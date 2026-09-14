import { AuthenticationMode, Config, resolveAuthenticationMode } from '../config.js';
import type { HttpFetch, HttpResponse } from '../types.js';
import { InstallBrowser, createBrowserInstaller } from './browserInstallation.js';
import {
  LoginBrowserLauncher,
  PerformBrowserLogin,
  TokenValidationResult,
  buildChromiumInstallCommand,
  buildLoginPageUrl,
  createBrowserLogin,
  createPlaywrightChromiumLauncher,
  deriveSiteUrl,
} from './browserLogin.js';
import {
  ABORT_EVENT,
  AUTHENTICATION_ERROR_CODES,
  AUTHENTICATION_MODES,
  AUTHORIZATION_HEADER_NAME,
  AuthenticationTimings,
  BEARER_TOKEN_PREFIX,
  BROWSER_INSTALLATION_PROGRESS_MESSAGE,
  CHROMIUM_DOWNLOAD_COMPONENT_NAME,
  CURRENT_USER_API_PATH,
  DEFAULT_AUTHENTICATION_TIMINGS,
  HTTP_GET_METHOD,
  HTTP_REDIRECT_MANUAL,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  INSTALLATION_ABORT_REASONS,
  LOGIN_PROGRESS_MESSAGE,
  MILLISECONDS_PER_SECOND,
  OTHER_PROCESS_PROGRESS_MESSAGE,
  TRAILING_SLASHES_PATTERN,
  UNKNOWN_ERROR_NAME,
  VACANT_STEPS_BEFORE_LOGIN_NOT_COMPLETED,
} from './constants.js';
import { HeldLoginLock, LoginLock, LoginLockRecord } from './loginLock.js';
import {
  AuthenticationLogger,
  Clock,
  MattermostAuthenticationError,
  createStderrAuthenticationLogger,
  systemClock,
  toSeconds,
} from './runtime.js';
import { StatePaths, TokenStore, createFileTokenStore, resolveStatePaths } from './stateFiles.js';

export interface ProgressUpdate {
  progress: number;
  message: string;
}

export interface CallAuthenticationState {
  browserLoginStarted: boolean;
  /** Последний отправленный прогресс вызова: MCP требует строгого роста между ожиданиями одного вызова */
  lastReportedProgress?: number;
}

export interface RequestCallContext {
  readonly interactive: boolean;
  readonly reportProgress?: (update: ProgressUpdate) => void;
  readonly cancellationSignal?: AbortSignal;
  /** Лог отмены вызова во время ожидания входа */
  readonly logger?: AuthenticationLogger;
  readonly authenticationState: CallAuthenticationState;
}

export const BACKGROUND_CALL_CONTEXT: RequestCallContext = Object.freeze({
  interactive: false,
  authenticationState: Object.freeze({ browserLoginStarted: false }),
});

export interface ToolCallContextOptions {
  progressToken: string | number | undefined;
  sendProgressNotification: (parameters: { progressToken: string | number; progress: number; message: string }) => Promise<void>;
  cancellationSignal: AbortSignal;
  logger: AuthenticationLogger;
}

const PROGRESS_NOTIFICATION_FAILED_MESSAGE = 'progress notification failed';
const CALLER_CANCELLED_MESSAGE = 'caller cancelled, sign-in continues in background';
const NEWER_TOKEN_FOUND_MESSAGE = 'newer token found in token file';
const NO_TOKEN_FILE_MESSAGE = 'no token file, sign-in required';
const UNAUTHORIZED_RECEIVED_MESSAGE = '401 received, checking token file';
const BACKGROUND_SIGN_IN_SKIPPED_MESSAGE = 'background request needs sign-in, skipped';
const CANCELLED_ATTEMPT_WAIT_MESSAGE = 'previous sign-in attempt was cancelled, waiting for it to finish';
const CANCELLED_CALL_AFTER_WAIT_MESSAGE = 'caller cancelled while waiting for the cancelled attempt, no new sign-in started';
const JOINING_SIGN_IN_MESSAGE = 'joining sign-in already in progress';
const LOCK_RELEASED_WITHOUT_TOKEN_MESSAGE = 'login lock released, token file unchanged';
const SESSION_TOKEN_SAVED_MESSAGE = 'session token saved';
const LOCK_LOST_DURING_INSTALLATION_MESSAGE = 'login lock lost during Chromium installation';

export function createToolCallContext(options: ToolCallContextOptions): RequestCallContext {
  const { progressToken, sendProgressNotification, cancellationSignal, logger } = options;
  const authenticationState: CallAuthenticationState = { browserLoginStarted: false };
  if (progressToken === undefined) {
    return { interactive: true, cancellationSignal, logger, authenticationState };
  }

  let notificationFailureLogged = false;
  const handleNotificationFailure = (): void => {
    if (!notificationFailureLogged) {
      notificationFailureLogged = true;
      logger(PROGRESS_NOTIFICATION_FAILED_MESSAGE);
    }
  };
  const reportProgress = (update: ProgressUpdate): void => {
    /* Без транспорта notification() отклоняется, а сбой уведомления не должен ронять ожидание входа */
    try {
      sendProgressNotification({ progressToken, progress: update.progress, message: update.message }).catch(
        handleNotificationFailure,
      );
    } catch {
      handleNotificationFailure();
    }
  };
  return { interactive: true, reportProgress, cancellationSignal, logger, authenticationState };
}

export async function awaitWithProgress<Result>(
  operation: Promise<Result>,
  callContext: RequestCallContext,
  intervalMilliseconds: number,
  clock: Clock = systemClock,
  /** Текущее состояние для текста уведомления */
  describeStatus: () => string = () => LOGIN_PROGRESS_MESSAGE,
): Promise<Result> {
  const { reportProgress, cancellationSignal, logger, authenticationState } = callContext;
  if (reportProgress === undefined || cancellationSignal?.aborted) {
    return operation;
  }

  const startedAtMilliseconds = clock.now();
  let tickerStopped = false;
  const intervalHandle = clock.setInterval(() => {
    const elapsedSeconds = Math.floor((clock.now() - startedAtMilliseconds) / MILLISECONDS_PER_SECOND);
    const progress = Math.max((authenticationState.lastReportedProgress ?? 0) + 1, elapsedSeconds);
    authenticationState.lastReportedProgress = progress;
    reportProgress({ progress, message: `${describeStatus()} (${progress} s)` });
  }, intervalMilliseconds);
  const stopTicker = (): void => {
    if (!tickerStopped) {
      tickerStopped = true;
      clock.clearInterval(intervalHandle);
    }
  };
  const handleCancellation = (): void => {
    stopTicker();
    logger?.(CALLER_CANCELLED_MESSAGE);
  };
  cancellationSignal?.addEventListener(ABORT_EVENT, handleCancellation, { once: true });

  try {
    return await operation;
  } finally {
    cancellationSignal?.removeEventListener(ABORT_EVENT, handleCancellation);
    stopTicker();
  }
}

export interface TokenProvider {
  readonly mode: AuthenticationMode;
  getToken(callContext: RequestCallContext): Promise<string>;
  recoverFromUnauthorized(rejectedToken: string, callContext: RequestCallContext): Promise<string | undefined>;
}

export class StaticTokenProvider implements TokenProvider {
  readonly mode: AuthenticationMode = AUTHENTICATION_MODES.STATIC;

  constructor(private readonly token: string) {}

  async getToken(_callContext: RequestCallContext): Promise<string> {
    return this.token;
  }

  /** Статический режим не восстанавливает сессию: клиент бросает прежнюю ошибку 401 */
  async recoverFromUnauthorized(_rejectedToken: string, _callContext: RequestCallContext): Promise<string | undefined> {
    return undefined;
  }
}

export interface BrowserAuthenticationSessionDependencies {
  siteUrl: string;
  paths: StatePaths;
  tokenStore: TokenStore;
  loginLock: LoginLock;
  launcher: LoginBrowserLauncher;
  installBrowser: InstallBrowser;
  performBrowserLogin: PerformBrowserLogin;
  validateToken: (candidateToken: string) => Promise<TokenValidationResult>;
  timings: AuthenticationTimings;
  logger: AuthenticationLogger;
  clock?: Clock;
}

interface RecoveryAttemptState {
  statusMessage: string;
  startedAtMilliseconds: number;
  interestedCallCount: number;
  /** Существует только пока идёт установка Chromium */
  installationAbortController: AbortController | undefined;
  /** Установка этой попытки отменена, и попытка завершится ошибкой */
  installationCancelled: boolean;
  settled: boolean;
}

interface PendingRecovery extends RecoveryAttemptState {
  promise: Promise<string>;
}

type InstallationOutcome = { kind: 'succeeded' } | { kind: 'failed'; error: unknown };

export class BrowserAuthenticationSession implements TokenProvider {
  readonly mode: AuthenticationMode = AUTHENTICATION_MODES.BROWSER;
  private readonly siteUrl: string;
  private readonly paths: StatePaths;
  private readonly tokenStore: TokenStore;
  private readonly loginLock: LoginLock;
  private readonly launcher: LoginBrowserLauncher;
  private readonly installBrowser: InstallBrowser;
  private readonly performBrowserLogin: PerformBrowserLogin;
  private readonly validateToken: (candidateToken: string) => Promise<TokenValidationResult>;
  private readonly timings: AuthenticationTimings;
  private readonly logger: AuthenticationLogger;
  private readonly clock: Clock;
  private pendingRecovery: PendingRecovery | undefined;
  private tokenFilePresent: boolean | undefined;

  constructor(dependencies: BrowserAuthenticationSessionDependencies) {
    this.siteUrl = dependencies.siteUrl;
    this.paths = dependencies.paths;
    this.tokenStore = dependencies.tokenStore;
    this.loginLock = dependencies.loginLock;
    this.launcher = dependencies.launcher;
    this.installBrowser = dependencies.installBrowser;
    this.performBrowserLogin = dependencies.performBrowserLogin;
    this.validateToken = dependencies.validateToken;
    this.timings = dependencies.timings;
    this.logger = dependencies.logger;
    this.clock = dependencies.clock ?? systemClock;
  }

  async getToken(callContext: RequestCallContext): Promise<string> {
    const storedToken = await this.tokenStore.readToken(this.siteUrl);
    const present = storedToken !== undefined;
    if (!present && this.tokenFilePresent !== false) {
      this.logger(NO_TOKEN_FILE_MESSAGE);
    }
    this.tokenFilePresent = present;
    if (storedToken !== undefined) {
      return storedToken;
    }
    return this.acquireFreshToken(undefined, callContext);
  }

  async recoverFromUnauthorized(rejectedToken: string, callContext: RequestCallContext): Promise<string | undefined> {
    this.logger(UNAUTHORIZED_RECEIVED_MESSAGE);
    return this.acquireFreshToken(rejectedToken, callContext);
  }

  private async acquireFreshToken(rejectedToken: string | undefined, callContext: RequestCallContext): Promise<string> {
    const { authenticationState } = callContext;
    while (true) {
      const newerToken = await this.readNewerToken(rejectedToken);
      if (newerToken !== undefined) {
        return newerToken;
      }

      if (!callContext.interactive) {
        this.logger(BACKGROUND_SIGN_IN_SKIPPED_MESSAGE);
        throw new MattermostAuthenticationError(
          AUTHENTICATION_ERROR_CODES.AUTHENTICATION_REQUIRED,
          'Mattermost sign-in is required, but background requests do not open the sign-in window. Call any Mattermost tool to sign in.',
        );
      }

      /* Завершённая попытка считается отсутствующей, даже если ссылка на неё ещё не обнулена */
      const activeRecovery =
        this.pendingRecovery !== undefined && !this.pendingRecovery.settled ? this.pendingRecovery : undefined;

      if (activeRecovery !== undefined && activeRecovery.installationCancelled) {
        this.logger(CANCELLED_ATTEMPT_WAIT_MESSAGE);
        await awaitWithProgress(
          activeRecovery.promise.catch(() => undefined),
          callContext,
          this.timings.progressIntervalMilliseconds,
          this.clock,
          () => activeRecovery.statusMessage,
        );
        if (callContext.cancellationSignal?.aborted) {
          this.logger(CANCELLED_CALL_AFTER_WAIT_MESSAGE);
          throw new MattermostAuthenticationError(
            AUTHENTICATION_ERROR_CODES.LOGIN_NOT_COMPLETED,
            'The tool call was cancelled while waiting for the previous Mattermost sign-in attempt. Retry the tool call.',
          );
        }
        continue;
      }

      if (activeRecovery !== undefined) {
        authenticationState.browserLoginStarted = true;
        this.logger(JOINING_SIGN_IN_MESSAGE);
        this.registerInterest(activeRecovery, callContext);
        return awaitWithProgress(
          activeRecovery.promise,
          callContext,
          this.timings.progressIntervalMilliseconds,
          this.clock,
          () => activeRecovery.statusMessage,
        );
      }

      if (authenticationState.browserLoginStarted) {
        throw new MattermostAuthenticationError(
          AUTHENTICATION_ERROR_CODES.UNAUTHORIZED_AFTER_RETRY,
          'Mattermost rejected the session token again after sign-in in this tool call. Retry the tool call.',
        );
      }

      authenticationState.browserLoginStarted = true;
      const recovery = this.startRecovery(rejectedToken);
      this.registerInterest(recovery, callContext);
      return awaitWithProgress(
        recovery.promise,
        callContext,
        this.timings.progressIntervalMilliseconds,
        this.clock,
        () => recovery.statusMessage,
      );
    }
  }

  private startRecovery(rejectedToken: string | undefined): PendingRecovery {
    const attemptState: RecoveryAttemptState = {
      statusMessage: LOGIN_PROGRESS_MESSAGE,
      startedAtMilliseconds: this.clock.now(),
      interestedCallCount: 0,
      installationAbortController: undefined,
      installationCancelled: false,
      settled: false,
    };
    const deadlineMilliseconds = attemptState.startedAtMilliseconds + this.timings.loginTimeoutMilliseconds;
    const recovery: PendingRecovery = Object.assign(attemptState, {
      promise: this.recoverAcrossProcesses(rejectedToken, deadlineMilliseconds, attemptState).finally(() => {
        /* settled выставляется до обнуления ссылки, поэтому вызов, увидевший этот объект позже, к нему не присоединится */
        recovery.settled = true;
        if (this.pendingRecovery === recovery) {
          this.pendingRecovery = undefined;
        }
      }),
    });
    this.pendingRecovery = recovery;
    return recovery;
  }

  /** Интерес вызова влияет только на установку Chromium: вход в окне после отмены продолжается */
  private registerInterest(recovery: RecoveryAttemptState, callContext: RequestCallContext): void {
    const { cancellationSignal } = callContext;
    if (cancellationSignal?.aborted) {
      return;
    }
    recovery.interestedCallCount += 1;
    cancellationSignal?.addEventListener(
      ABORT_EVENT,
      () => {
        recovery.interestedCallCount -= 1;
        if (recovery.interestedCallCount === 0 && recovery.installationAbortController !== undefined) {
          recovery.installationCancelled = true;
          recovery.installationAbortController.abort(INSTALLATION_ABORT_REASONS.CANCELLED);
        }
      },
      { once: true },
    );
  }

  private async readNewerToken(rejectedToken: string | undefined): Promise<string | undefined> {
    const storedToken = await this.tokenStore.readToken(this.siteUrl);
    if (storedToken === undefined || storedToken === rejectedToken) {
      return undefined;
    }
    this.logger(NEWER_TOKEN_FOUND_MESSAGE);
    return storedToken;
  }

  private createWaitTimeoutError(recovery: RecoveryAttemptState): MattermostAuthenticationError {
    const waitedSeconds = toSeconds(this.clock.now() - recovery.startedAtMilliseconds);
    this.logger(`sign-in timed out after ${waitedSeconds} s (no browser window in this process)`);
    return new MattermostAuthenticationError(
      AUTHENTICATION_ERROR_CODES.LOGIN_TIMEOUT,
      `Mattermost sign-in did not complete within ${waitedSeconds} s. Complete the sign-in in the browser window and retry the tool call.`,
    );
  }

  /**
   * Цикл ожидания без лимита итераций. Процесс, заметивший претендента на блокировку, свободную блокировку
   * больше не захватывает: после двух подряд шагов со свободной блокировкой он возвращает LOGIN_NOT_COMPLETED.
   * Устаревшую блокировку он по-прежнему берёт через tryBreakStale и тогда открывает окно сам
   */
  private async recoverAcrossProcesses(
    rejectedToken: string | undefined,
    initialDeadlineMilliseconds: number,
    recovery: RecoveryAttemptState,
  ): Promise<string> {
    let deadlineMilliseconds = initialDeadlineMilliseconds;
    let lockHolderObserved = false;
    let vacantStepsAfterObservation = 0;
    let lastLiveRecord: LoginLockRecord | undefined;
    const firstObservedAtByNonce = new Map<string, number>();
    const renewalLoggedNonces = new Set<string>();

    while (true) {
      const newerToken = await this.readNewerToken(rejectedToken);
      if (newerToken !== undefined) {
        return newerToken;
      }
      if (this.clock.now() >= deadlineMilliseconds) {
        throw this.createWaitTimeoutError(recovery);
      }

      const state = await this.loginLock.inspect();
      if (state.kind !== 'vacant') {
        vacantStepsAfterObservation = 0;
      }
      let heldLock: HeldLoginLock | undefined;

      if (state.kind === 'vacant') {
        if (lockHolderObserved) {
          vacantStepsAfterObservation += 1;
          if (vacantStepsAfterObservation >= VACANT_STEPS_BEFORE_LOGIN_NOT_COMPLETED) {
            /* Держатель пишет токен до снятия блокировки, поэтому повторное чтение закрывает гонку с этой записью */
            const confirmedToken = await this.readNewerToken(rejectedToken);
            if (confirmedToken !== undefined) {
              return confirmedToken;
            }
            this.logger(LOCK_RELEASED_WITHOUT_TOKEN_MESSAGE);
            throw new MattermostAuthenticationError(
              AUTHENTICATION_ERROR_CODES.LOGIN_NOT_COMPLETED,
              'Mattermost sign-in in another process ended without a new session token. Retry the tool call to open the sign-in window.',
            );
          }
        } else {
          heldLock = await this.loginLock.tryAcquire();
          if (heldLock === undefined) {
            lockHolderObserved = true;
          }
        }
      } else if (state.kind === 'stale') {
        heldLock = await this.loginLock.tryBreakStale(state);
        if (heldLock === undefined) {
          lockHolderObserved = true;
        }
      } else if (state.kind === 'live') {
        const { record } = state;
        const now = this.clock.now();
        lockHolderObserved = true;
        recovery.statusMessage = OTHER_PROCESS_PROGRESS_MESSAGE;
        if (!firstObservedAtByNonce.has(record.nonce)) {
          firstObservedAtByNonce.set(record.nonce, now);
          const ageSeconds = Math.max(0, Math.floor((now - record.createdAtMilliseconds) / MILLISECONDS_PER_SECOND));
          this.logger(`login lock busy (holder process ${record.processId}, age ${ageSeconds} s), waiting`);
        }
        if (
          lastLiveRecord !== undefined &&
          lastLiveRecord.nonce === record.nonce &&
          lastLiveRecord.createdAtMilliseconds < record.createdAtMilliseconds
        ) {
          if (!renewalLoggedNonces.has(record.nonce)) {
            renewalLoggedNonces.add(record.nonce);
            this.logger(`login lock renewed by holder process ${record.processId}, extending wait`);
          }
          deadlineMilliseconds = Math.max(
            deadlineMilliseconds,
            Math.min(now + this.timings.loginTimeoutMilliseconds, this.calculateExtensionLimit(firstObservedAtByNonce, record)),
          );
        }
        lastLiveRecord = record;
      } else {
        recovery.statusMessage = OTHER_PROCESS_PROGRESS_MESSAGE;
      }

      if (heldLock !== undefined) {
        return this.completeRecoveryAsLockHolder(heldLock, rejectedToken, deadlineMilliseconds, recovery);
      }
      await this.clock.sleep(this.timings.lockPollIntervalMilliseconds);
    }
  }

  /**
   * Предел продления равен границе полного удержания блокировки держателем при первой загрузке Chromium.
   * После срока входа шаг держателя ещё читает cookie, проверяет токен и закрывает окно
   */
  private calculateExtensionLimit(firstObservedAtByNonce: Map<string, number>, record: LoginLockRecord): number {
    const firstObservedAtMilliseconds = firstObservedAtByNonce.get(record.nonce) ?? this.clock.now();
    const holderLoginStepAllowanceMilliseconds =
      this.timings.cookieReadTimeoutMilliseconds +
      this.timings.tokenValidationTimeoutMilliseconds +
      this.timings.browserCloseTimeoutMilliseconds;
    return (
      firstObservedAtMilliseconds +
      this.timings.browserInstallationTimeoutMilliseconds +
      2 * this.timings.installationTerminationGraceMilliseconds +
      2 * this.timings.lockReleaseTimeoutMilliseconds +
      this.timings.loginTimeoutMilliseconds +
      holderLoginStepAllowanceMilliseconds
    );
  }

  private async completeRecoveryAsLockHolder(
    heldLock: HeldLoginLock,
    rejectedToken: string | undefined,
    deadlineMilliseconds: number,
    recovery: RecoveryAttemptState,
  ): Promise<string> {
    try {
      const newerToken = await this.readNewerToken(rejectedToken);
      if (newerToken !== undefined) {
        return newerToken;
      }
      if (this.clock.now() >= deadlineMilliseconds) {
        throw this.createWaitTimeoutError(recovery);
      }

      let loginDeadlineMilliseconds = deadlineMilliseconds;
      const installationState = await this.launcher.inspectInstallation();
      if (installationState.kind === 'missing') {
        await this.installChromiumAsLockHolder(heldLock, recovery);
        loginDeadlineMilliseconds = this.clock.now() + this.timings.loginTimeoutMilliseconds;
      }

      recovery.statusMessage = LOGIN_PROGRESS_MESSAGE;
      this.logger(`login lock acquired, opening browser window ${buildLoginPageUrl(this.siteUrl)}`);
      const token = await this.performBrowserLogin({
        siteUrl: this.siteUrl,
        profileDirectory: this.paths.profileDirectory,
        rejectedToken,
        deadlineMilliseconds: loginDeadlineMilliseconds,
        validateToken: this.validateToken,
      });
      /* Токен пишется до снятия блокировки: ожидающий после её снятия должен увидеть новый файл */
      await this.tokenStore.writeToken(this.siteUrl, token);
      this.logger(SESSION_TOKEN_SAVED_MESSAGE);
      return token;
    } finally {
      await heldLock.release();
    }
  }

  private async installChromiumAsLockHolder(heldLock: HeldLoginLock, recovery: RecoveryAttemptState): Promise<void> {
    const { browsersDirectory, installationTemporaryDirectory } = this.paths;
    this.logger(`Chromium not found in ${browsersDirectory}, downloading`);
    recovery.statusMessage = BROWSER_INSTALLATION_PROGRESS_MESSAGE;
    const installationStartedAtMilliseconds = this.clock.now();

    const installationAbortController = new AbortController();
    let installationOutcomePromise: Promise<InstallationOutcome> | undefined;
    let installationOutcome: InstallationOutcome | undefined;
    let installationSettled = false;
    try {
      recovery.installationAbortController = installationAbortController;
      if (recovery.interestedCallCount === 0) {
        recovery.installationCancelled = true;
        installationAbortController.abort(INSTALLATION_ABORT_REASONS.CANCELLED);
      }

      installationOutcomePromise = this.installBrowser({
        browsersDirectory,
        temporaryRootDirectory: installationTemporaryDirectory,
        cancellationSignal: installationAbortController.signal,
        onProgress: (progress) => {
          /* Маленький архив после Chromium назван явно, иначе его 0% выглядит как перезапуск загрузки Chromium */
          const componentPrefix =
            progress.componentName === CHROMIUM_DOWNLOAD_COMPONENT_NAME ? '' : `${progress.componentName} `;
          recovery.statusMessage = `${BROWSER_INSTALLATION_PROGRESS_MESSAGE}: ${componentPrefix}${progress.percent}% of ${progress.totalSizeDescription}`;
        },
      }).then(
        (): InstallationOutcome => {
          installationSettled = true;
          return { kind: 'succeeded' };
        },
        (error: unknown): InstallationOutcome => {
          installationSettled = true;
          return { kind: 'failed', error };
        },
      );

      while (true) {
        /* Сон отменяется сразу после гонки, чтобы завершившаяся установка не оставляла таймер интервала */
        const sleepController = new AbortController();
        let raceResult: InstallationOutcome | undefined;
        try {
          raceResult = await Promise.race([
            installationOutcomePromise,
            this.clock
              .sleep(this.timings.lockRenewIntervalMilliseconds, sleepController.signal)
              .then((): undefined => undefined),
          ]);
        } finally {
          sleepController.abort();
        }
        if (raceResult !== undefined) {
          installationOutcome = raceResult;
          break;
        }

        const renewalResult = await heldLock.renew();
        if (renewalResult === 'lost') {
          installationAbortController.abort(INSTALLATION_ABORT_REASONS.LOCK_LOST);
          installationOutcome = await installationOutcomePromise;
          this.logger(LOCK_LOST_DURING_INSTALLATION_MESSAGE);
          throw new MattermostAuthenticationError(
            AUTHENTICATION_ERROR_CODES.LOGIN_NOT_COMPLETED,
            'The Mattermost login lock was lost during Chromium installation. Retry the tool call.',
          );
        }
      }

      if (installationOutcome.kind === 'failed') {
        throw installationOutcome.error;
      }
    } finally {
      /* Блокировка не снимается при живом установщике: неожиданный выход сначала завершает установку */
      if (installationOutcomePromise !== undefined && !installationSettled) {
        if (!installationAbortController.signal.aborted) {
          installationAbortController.abort(INSTALLATION_ABORT_REASONS.CANCELLED);
        }
        installationOutcome = await installationOutcomePromise;
      }
      recovery.installationAbortController = undefined;
      if (installationOutcome?.kind === 'succeeded') {
        recovery.installationCancelled = false;
      }
    }

    /* Граница удержания после установки считается от этого обновления */
    if ((await heldLock.renew()) !== 'renewed') {
      throw new MattermostAuthenticationError(
        AUTHENTICATION_ERROR_CODES.LOGIN_NOT_COMPLETED,
        'The Mattermost login lock could not be renewed after Chromium installation. Chromium was installed, call the tool again.',
      );
    }
    if ((await this.launcher.inspectInstallation()).kind === 'missing') {
      throw new MattermostAuthenticationError(
        AUTHENTICATION_ERROR_CODES.BROWSER_INSTALLATION_FAILED,
        `Chromium is still missing after installation in ${browsersDirectory}. Run manually: ${buildChromiumInstallCommand(browsersDirectory)}`,
      );
    }
    this.logger(
      `Chromium installed in ${toSeconds(this.clock.now() - installationStartedAtMilliseconds)} s, sign-in timer started`,
    );
  }
}

const UNEXPECTED_CURRENT_USER_BODY_DESCRIPTION = `unexpected ${CURRENT_USER_API_PATH} body`;

async function isCurrentUserBody(response: HttpResponse): Promise<boolean> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  return typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).id === 'string';
}

export function createTokenValidator(
  apiBaseUrl: string,
  fetchImplementation: HttpFetch,
  timeoutMilliseconds: number,
): (candidateToken: string) => Promise<TokenValidationResult> {
  const currentUserUrl = `${apiBaseUrl.replace(TRAILING_SLASHES_PATTERN, '')}${CURRENT_USER_API_PATH}`;
  return async (candidateToken) => {
    try {
      /* Без редиректов: иначе 200 от страницы входа или прокси по адресу редиректа сошёл бы за валидный токен */
      const response = await fetchImplementation(currentUserUrl, {
        method: HTTP_GET_METHOD,
        headers: { [AUTHORIZATION_HEADER_NAME]: `${BEARER_TOKEN_PREFIX}${candidateToken}` },
        signal: AbortSignal.timeout(timeoutMilliseconds),
        redirect: HTTP_REDIRECT_MANUAL,
      });
      const statusDescription = `status ${response.status}`;
      if (response.status === HTTP_STATUS_OK) {
        return (await isCurrentUserBody(response))
          ? { kind: 'valid', statusDescription }
          : { kind: 'unavailable', statusDescription: UNEXPECTED_CURRENT_USER_BODY_DESCRIPTION };
      }
      if (response.status === HTTP_STATUS_UNAUTHORIZED) {
        return { kind: 'rejected', statusDescription };
      }
      return { kind: 'unavailable', statusDescription };
    } catch (error) {
      /* Только имя ошибки: текст исключения HTTP-клиента может содержать заголовки запроса */
      const errorName = error instanceof Error ? error.name : UNKNOWN_ERROR_NAME;
      return { kind: 'unavailable', statusDescription: errorName };
    }
  };
}

export interface TokenProviderOverrides {
  homeDirectory?: string;
  launcher?: LoginBrowserLauncher;
  installBrowser?: InstallBrowser;
  timings?: Partial<AuthenticationTimings>;
  logger?: AuthenticationLogger;
  clock?: Clock;
}

/** Создание провайдера не обращается к диску и не запускает процессов */
export function createTokenProvider(
  config: Config,
  fetchImplementation: HttpFetch,
  overrides: TokenProviderOverrides = {},
): TokenProvider {
  if (resolveAuthenticationMode(config) === AUTHENTICATION_MODES.STATIC) {
    return new StaticTokenProvider(config.token);
  }

  const siteUrl = deriveSiteUrl(config.mattermostUrl);
  const paths = resolveStatePaths(overrides.homeDirectory);
  const timings: AuthenticationTimings = { ...DEFAULT_AUTHENTICATION_TIMINGS, ...overrides.timings };
  const clock = overrides.clock ?? systemClock;
  const logger = overrides.logger ?? createStderrAuthenticationLogger();
  const launcher = overrides.launcher ?? createPlaywrightChromiumLauncher({ paths, timings, logger });
  return new BrowserAuthenticationSession({
    siteUrl,
    paths,
    tokenStore: createFileTokenStore(paths, logger),
    loginLock: new LoginLock({ paths, timings, logger, clock }),
    launcher,
    installBrowser: overrides.installBrowser ?? createBrowserInstaller({ timings, logger, clock }),
    performBrowserLogin: createBrowserLogin({ launcher, timings, logger, clock }),
    validateToken: createTokenValidator(config.mattermostUrl, fetchImplementation, timings.tokenValidationTimeoutMilliseconds),
    timings,
    logger,
    clock,
  });
}
