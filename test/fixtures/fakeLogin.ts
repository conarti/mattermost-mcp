import type {
  BrowserInstallationProgress,
  BrowserInstallationRequest,
  InstallBrowser,
} from '../../src/authentication/browserInstallation.js';
import type {
  BrowserLoginRequest,
  PerformBrowserLogin,
  TokenValidationResult,
} from '../../src/authentication/browserLogin.js';
import { ABORT_EVENT, AUTHENTICATION_ERROR_CODES } from '../../src/authentication/constants.js';
import { MattermostAuthenticationError } from '../../src/authentication/runtime.js';
import { Deferred, createDeferred, waitForCondition } from './asyncControl.js';
import type { FakeClock } from './fakeClock.js';
import type { FakeLoginBrowserLauncher } from './fakeLoginBrowser.js';

export const FAKE_LOGIN_EVENTS = {
  PERFORM_BROWSER_LOGIN: 'performBrowserLogin',
  INSTALL_BROWSER: 'installBrowser',
  INSTALLATION_SETTLED: 'installationSettled',
} as const;

export type FakeBrowserLoginStep =
  | { kind: 'token'; token: string }
  | { kind: 'error'; error: Error }
  | { kind: 'deferred' };

/** Управляемый вход: шаги по номеру вызова, последний шаг повторяется */
export class FakeBrowserLogin {
  readonly requests: BrowserLoginRequest[] = [];
  readonly pendingResults: Array<Deferred<string>> = [];

  constructor(
    private readonly steps: FakeBrowserLoginStep[],
    private readonly events?: string[],
    private readonly onCall?: (request: BrowserLoginRequest) => void,
  ) {}

  get callCount(): number {
    return this.requests.length;
  }

  readonly perform: PerformBrowserLogin = async (request) => {
    this.events?.push(FAKE_LOGIN_EVENTS.PERFORM_BROWSER_LOGIN);
    const step = this.steps[Math.min(this.requests.length, this.steps.length - 1)];
    this.requests.push(request);
    this.onCall?.(request);
    if (step.kind === 'token') {
      return step.token;
    }
    if (step.kind === 'error') {
      throw step.error;
    }
    const deferred = createDeferred<string>();
    this.pendingResults.push(deferred);
    return deferred.promise;
  };

  waitForCalls(count: number): Promise<void> {
    return waitForCondition(() => this.requests.length >= count);
  }
}

export interface FakeTokenValidator {
  readonly validatedTokens: string[];
  validateToken(candidateToken: string): Promise<TokenValidationResult>;
}

export function createFakeTokenValidator(validTokens: readonly string[]): FakeTokenValidator {
  const validatedTokens: string[] = [];
  return {
    validatedTokens,
    validateToken: async (candidateToken) => {
      validatedTokens.push(candidateToken);
      return validTokens.includes(candidateToken)
        ? { kind: 'valid', statusDescription: 'status 200' }
        : { kind: 'rejected', statusDescription: 'status 401' };
    },
  };
}

export type FakeInstallationStep =
  | { kind: 'succeed' }
  | { kind: 'fail'; error: Error }
  | { kind: 'deferred' }
  | { kind: 'sleep'; milliseconds: number };

export interface FakeBrowserInstallerOptions {
  /** Шаги по номеру вызова, последний шаг повторяется */
  steps?: FakeInstallationStep[];
  /** Успешная установка переключает фейковый запуск в installed */
  launcher?: FakeLoginBrowserLauncher;
  markInstalledOnSuccess?: boolean;
  progress?: BrowserInstallationProgress;
  /** Отмена сразу отклоняет установку, как настоящий установщик после завершения процесса */
  rejectOnAbort?: boolean;
  clock?: FakeClock;
  events?: string[];
}

export function createCancelledInstallationError(signal: AbortSignal): MattermostAuthenticationError {
  return new MattermostAuthenticationError(
    AUTHENTICATION_ERROR_CODES.BROWSER_INSTALLATION_FAILED,
    `Chromium installation ${String(signal.reason)}, installer terminated`,
  );
}

export class FakeBrowserInstaller {
  readonly requests: BrowserInstallationRequest[] = [];
  readonly pendingInstallations: Array<Deferred<void>> = [];
  settledCount = 0;
  private readonly steps: FakeInstallationStep[];

  constructor(private readonly options: FakeBrowserInstallerOptions = {}) {
    this.steps = options.steps ?? [{ kind: 'succeed' }];
  }

  get callCount(): number {
    return this.requests.length;
  }

  /** Сигналы установок в порядке вызовов */
  get signals(): AbortSignal[] {
    return this.requests.map((request) => request.cancellationSignal);
  }

  readonly install: InstallBrowser = (request) => {
    const { events, launcher, progress, clock, markInstalledOnSuccess = true, rejectOnAbort = true } = this.options;
    events?.push(FAKE_LOGIN_EVENTS.INSTALL_BROWSER);
    const step = this.steps[Math.min(this.requests.length, this.steps.length - 1)];
    this.requests.push(request);
    const deferred = createDeferred<void>();
    this.pendingInstallations.push(deferred);

    if (progress !== undefined) {
      request.onProgress(progress);
    }
    const { cancellationSignal } = request;
    if (rejectOnAbort) {
      const rejectWithAbortReason = () => deferred.reject(createCancelledInstallationError(cancellationSignal));
      if (cancellationSignal.aborted) {
        rejectWithAbortReason();
      } else {
        cancellationSignal.addEventListener(ABORT_EVENT, rejectWithAbortReason, { once: true });
      }
    }

    if (step.kind === 'succeed') {
      deferred.resolve();
    } else if (step.kind === 'fail') {
      deferred.reject(step.error);
    } else if (step.kind === 'sleep') {
      if (clock === undefined) {
        throw new Error('FakeBrowserInstaller sleep step requires a clock');
      }
      void clock.sleep(step.milliseconds).then(() => deferred.resolve());
    }

    return deferred.promise.then(
      () => {
        this.settledCount += 1;
        events?.push(FAKE_LOGIN_EVENTS.INSTALLATION_SETTLED);
        if (markInstalledOnSuccess) {
          launcher?.markInstalled();
        }
      },
      (error: unknown) => {
        this.settledCount += 1;
        events?.push(FAKE_LOGIN_EVENTS.INSTALLATION_SETTLED);
        throw error;
      },
    );
  };

  waitForCalls(count: number): Promise<void> {
    return waitForCondition(() => this.requests.length >= count);
  }
}
