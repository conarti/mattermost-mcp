import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { BrowserInstallationProgress } from '../../src/authentication/browserInstallation.js';
import {
  BrowserLoginRequest,
  PerformBrowserLogin,
  TokenValidationResult,
  createBrowserLogin,
} from '../../src/authentication/browserLogin.js';
import {
  DEFAULT_AUTHENTICATION_TIMINGS,
  PRIVATE_FILE_MODE,
  TEMPORARY_FILE_EXTENSION,
  TEXT_FILE_ENCODING,
} from '../../src/authentication/constants.js';
import {
  HeldLoginLock,
  LoginLock,
  LoginLockOptions,
  LoginLockRecord,
  LoginLockRenewalResult,
  LoginLockState,
} from '../../src/authentication/loginLock.js';
import { MattermostAuthenticationError } from '../../src/authentication/runtime.js';
import {
  BACKGROUND_CALL_CONTEXT,
  BrowserAuthenticationSession,
  RequestCallContext,
  StaticTokenProvider,
  createTokenProvider,
  createTokenValidator,
  createToolCallContext,
} from '../../src/authentication/session.js';
import {
  StatePaths,
  TokenStore,
  createFileTokenStore,
  ensureStateDirectory,
  resolveStatePaths,
} from '../../src/authentication/stateFiles.js';
import type { HttpFetch, HttpRequest, HttpResponse } from '../../src/types.js';
import {
  TrackedPromise,
  advanceClockSteps,
  advanceClockUntilSettled,
  createDeferred,
  flushAsyncWork,
  trackPromise,
  waitForCondition,
} from '../fixtures/asyncControl.js';
import { LogCapture, assertOrderedFragments, createLogCapture } from '../fixtures/captureLogs.js';
import { FakeClock } from '../fixtures/fakeClock.js';
import {
  FAKE_LOGIN_EVENTS,
  FakeBrowserInstaller,
  FakeBrowserInstallerOptions,
  FakeBrowserLogin,
  FakeBrowserLoginStep,
  FakeTokenValidator,
  createCancelledInstallationError,
  createFakeTokenValidator,
} from '../fixtures/fakeLogin.js';
import { FakeCookieStep, FakeLoginBrowserContext, FakeLoginBrowserLauncher } from '../fixtures/fakeLoginBrowser.js';
import { PERMISSION_BITS_MASK } from '../fixtures/fixtureConstants.js';

const START_MILLISECONDS = 1_000_000_000_000;
const LIVE_FOREIGN_PROCESS_ID = 424242;
const DEAD_PROCESS_ID = 424243;
const FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS = 5_000;
const SITE_URL = 'https://chat.example.test';
const MATTERMOST_URL = `${SITE_URL}/api/v4`;
const TEAM_ID = 'team-test';
const STATIC_TOKEN = 'static-secret-token-0001';
const EXPIRED_TOKEN = 'expired-secret-token-0002';
const FRESH_TOKEN = 'fresh-secret-token-0003';
const PROGRESS_TOKEN = 'progress-token-1';
const INSTALLATION_PROGRESS: BrowserInstallationProgress = { percent: 40, totalSizeDescription: '150.3 MiB' };
const LOCK_EVENTS = {
  TRY_ACQUIRE: 'tryAcquire',
  TRY_BREAK_STALE: 'tryBreakStale',
  RENEW: 'renew',
  RELEASE: 'release',
} as const;
const INSPECT_INSTALLATION_EVENT = 'inspectInstallation';
const WRITE_TOKEN_EVENT = 'writeToken';

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeIsProcessAlive(processId: number): boolean {
  return processId !== DEAD_PROCESS_ID;
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

interface LoginLockHooks {
  afterInspect?: (state: LoginLockState) => Promise<void>;
  afterTryAcquire?: (heldLock: HeldLoginLock | undefined) => Promise<void>;
  tryBreakStale?: (run: () => Promise<HeldLoginLock | undefined>) => Promise<HeldLoginLock | undefined>;
  renew?: (renew: () => Promise<LoginLockRenewalResult>, callIndex: number) => Promise<LoginLockRenewalResult>;
}

/** Настоящая блокировка с журналом событий и швами для порядка гонок */
class JournalingLoginLock extends LoginLock {
  readonly hooks: LoginLockHooks = {};
  readonly acquiredAtMilliseconds: number[] = [];
  readonly releaseStartedAtMilliseconds: number[] = [];
  renewCount = 0;

  constructor(
    options: LoginLockOptions,
    private readonly journal: string[],
    private readonly journalClock: FakeClock,
  ) {
    super(options);
  }

  override async inspect(): Promise<LoginLockState> {
    const state = await super.inspect();
    await this.hooks.afterInspect?.(state);
    return state;
  }

  override async tryAcquire(): Promise<HeldLoginLock | undefined> {
    this.journal.push(LOCK_EVENTS.TRY_ACQUIRE);
    const heldLock = await super.tryAcquire();
    await this.hooks.afterTryAcquire?.(heldLock);
    return heldLock === undefined ? undefined : this.wrapHeldLock(heldLock);
  }

  override async tryBreakStale(state: Extract<LoginLockState, { kind: 'stale' }>): Promise<HeldLoginLock | undefined> {
    this.journal.push(LOCK_EVENTS.TRY_BREAK_STALE);
    const run = () => super.tryBreakStale(state);
    const heldLock = this.hooks.tryBreakStale === undefined ? await run() : await this.hooks.tryBreakStale(run);
    return heldLock === undefined ? undefined : this.wrapHeldLock(heldLock);
  }

  private wrapHeldLock(heldLock: HeldLoginLock): HeldLoginLock {
    this.acquiredAtMilliseconds.push(this.journalClock.now());
    return {
      get record() {
        return heldLock.record;
      },
      renew: async () => {
        this.journal.push(LOCK_EVENTS.RENEW);
        const callIndex = this.renewCount;
        this.renewCount += 1;
        return this.hooks.renew === undefined ? heldLock.renew() : this.hooks.renew(() => heldLock.renew(), callIndex);
      },
      release: async () => {
        this.journal.push(LOCK_EVENTS.RELEASE);
        this.releaseStartedAtMilliseconds.push(this.journalClock.now());
        await heldLock.release();
      },
    };
  }
}

class JournalingLauncher extends FakeLoginBrowserLauncher {
  constructor(
    private readonly journal: string[],
    context: FakeLoginBrowserContext,
    installed: boolean,
  ) {
    super(context, { installed });
  }

  override async inspectInstallation() {
    this.journal.push(INSPECT_INSTALLATION_EVENT);
    return super.inspectInstallation();
  }
}

interface SentNotification {
  progressToken: string | number;
  progress: number;
  message: string;
}

interface TestCallContext {
  context: RequestCallContext;
  controller: AbortController;
  notifications: SentNotification[];
}

interface SessionTestOptions {
  loginSteps?: FakeBrowserLoginStep[];
  onLoginCall?: (request: BrowserLoginRequest) => void;
  installed?: boolean;
  installer?: Omit<FakeBrowserInstallerOptions, 'launcher' | 'clock' | 'events'>;
  raceHook?: LoginLockOptions['raceHook'];
  /** Вход на основе настоящего createBrowserLogin с фейковым контекстом браузера */
  realBrowserLoginContext?: FakeLoginBrowserContext;
  validateToken?: (candidateToken: string) => Promise<TokenValidationResult>;
  readToken?: (read: () => Promise<string | undefined>) => Promise<string | undefined>;
}

interface SessionTestHarness {
  paths: StatePaths;
  clock: FakeClock;
  logs: LogCapture;
  events: string[];
  loginLock: JournalingLoginLock;
  launcher: JournalingLauncher;
  installer: FakeBrowserInstaller;
  browserLogin: FakeBrowserLogin;
  validator: FakeTokenValidator;
  session: BrowserAuthenticationSession;
  createCallContext(options?: { progressToken?: string }): TestCallContext;
  createOtherLock(overrides?: Partial<LoginLockOptions>): LoginLock;
  writeStoredToken(token: string): Promise<void>;
  readStoredToken(): Promise<string | undefined>;
  writeLockRecord(record: LoginLockRecord): Promise<string>;
}

async function createTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-session-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createSessionHarness(options: SessionTestOptions = {}): Promise<SessionTestHarness> {
  const homeDirectory = await createTemporaryHome();
  const paths = resolveStatePaths(homeDirectory);
  const clock = new FakeClock(START_MILLISECONDS);
  const logs = createLogCapture();
  const events: string[] = [];
  const timings = DEFAULT_AUTHENTICATION_TIMINGS;
  const lockOptions: LoginLockOptions = {
    paths,
    timings,
    logger: logs.logger,
    clock,
    isProcessAlive: fakeIsProcessAlive,
  };

  const loginLock = new JournalingLoginLock({ ...lockOptions, raceHook: options.raceHook }, events, clock);
  const launcher = new JournalingLauncher(events, options.realBrowserLoginContext ?? new FakeLoginBrowserContext(), options.installed ?? true);
  const installer = new FakeBrowserInstaller({ ...options.installer, launcher, clock, events });
  const browserLogin = new FakeBrowserLogin(
    options.loginSteps ?? [{ kind: 'token', token: FRESH_TOKEN }],
    events,
    options.onLoginCall,
  );
  const validator = createFakeTokenValidator([FRESH_TOKEN]);
  const performBrowserLogin: PerformBrowserLogin =
    options.realBrowserLoginContext === undefined
      ? browserLogin.perform
      : createBrowserLogin({ launcher, timings, logger: logs.logger, clock });

  const baseTokenStore = createFileTokenStore(paths, logs.logger);
  const tokenStore: TokenStore = {
    readToken: (siteUrl) =>
      options.readToken === undefined
        ? baseTokenStore.readToken(siteUrl)
        : options.readToken(() => baseTokenStore.readToken(siteUrl)),
    writeToken: async (siteUrl, token) => {
      events.push(WRITE_TOKEN_EVENT);
      await baseTokenStore.writeToken(siteUrl, token);
    },
  };

  const session = new BrowserAuthenticationSession({
    siteUrl: SITE_URL,
    paths,
    tokenStore,
    loginLock,
    launcher,
    installBrowser: installer.install,
    performBrowserLogin,
    validateToken: options.validateToken ?? validator.validateToken,
    timings,
    logger: logs.logger,
    clock,
  });

  const helperTokenStore = createFileTokenStore(paths, () => undefined);

  return {
    paths,
    clock,
    logs,
    events,
    loginLock,
    launcher,
    installer,
    browserLogin,
    validator,
    session,
    createCallContext: ({ progressToken = PROGRESS_TOKEN } = {}) => {
      const controller = new AbortController();
      const notifications: SentNotification[] = [];
      const context = createToolCallContext({
        progressToken,
        sendProgressNotification: async (parameters) => {
          notifications.push(parameters);
        },
        cancellationSignal: controller.signal,
        logger: logs.logger,
      });
      return { context, controller, notifications };
    },
    createOtherLock: (overrides = {}) => new LoginLock({ ...lockOptions, ...overrides }),
    writeStoredToken: (token) => helperTokenStore.writeToken(SITE_URL, token),
    readStoredToken: () => helperTokenStore.readToken(SITE_URL),
    writeLockRecord: async (record) => {
      await ensureStateDirectory(paths);
      const rawContent = JSON.stringify(record);
      /* Запись через rename, чтобы сессия никогда не прочитала неполный файл */
      const temporaryPath = `${paths.loginLockPath}.${randomUUID()}.test${TEMPORARY_FILE_EXTENSION}`;
      await writeFile(temporaryPath, rawContent, { mode: PRIVATE_FILE_MODE });
      await rename(temporaryPath, paths.loginLockPath);
      return rawContent;
    },
  };
}

function createForeignRecord(processId: number, createdAtMilliseconds: number, nonce: string = randomUUID()): LoginLockRecord {
  return { processId, createdAtMilliseconds, nonce };
}

async function expectAuthenticationError(
  promise: Promise<unknown>,
  code: string,
  messageFragment?: string,
): Promise<MattermostAuthenticationError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MattermostAuthenticationError, `unexpected error: ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (messageFragment !== undefined) {
      assert.ok(error.message.includes(messageFragment), error.message);
    }
    return error;
  }
  assert.fail(`expected ${code}`);
}

function getPendingRecovery(session: BrowserAuthenticationSession): Record<string, unknown> | undefined {
  return Reflect.get(session, 'pendingRecovery') as Record<string, unknown> | undefined;
}

function countEvents(events: readonly string[], event: string): number {
  return events.filter((entry) => entry === event).length;
}

test('fake process ids differ from the test process id', () => {
  assert.notEqual(process.pid, LIVE_FOREIGN_PROCESS_ID);
  assert.notEqual(process.pid, DEAD_PROCESS_ID);
});

test('N1: a newer token in the token file is returned without sign-in', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeStoredToken(FRESH_TOKEN);
  const { context } = harness.createCallContext();

  assert.equal(await harness.session.recoverFromUnauthorized(EXPIRED_TOKEN, context), FRESH_TOKEN);
  assert.equal(harness.browserLogin.callCount, 0);
  assert.ok(harness.logs.includes('newer token found in token file'));
});

test('N2: the rejected token in the file starts one sign-in and saves the new token privately', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeStoredToken(EXPIRED_TOKEN);
  const { context } = harness.createCallContext();

  assert.equal(await harness.session.recoverFromUnauthorized(EXPIRED_TOKEN, context), FRESH_TOKEN);
  assert.equal(harness.browserLogin.callCount, 1);
  assert.equal(harness.browserLogin.requests[0].rejectedToken, EXPIRED_TOKEN);
  assert.equal(await harness.readStoredToken(), FRESH_TOKEN);
  assert.equal((await stat(harness.paths.tokenFilePath)).mode & PERMISSION_BITS_MASK, PRIVATE_FILE_MODE);
  assert.ok(harness.logs.includes('401 received, checking token file'));
});

test('N3: the first interactive request without a token file signs in without HTTP calls while holding the lock', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  let lockExistedDuringLogin: boolean | undefined;
  let validationsBeforeLogin: number | undefined;
  const harness: SessionTestHarness = await createSessionHarness({
    onLoginCall: () => {
      validationsBeforeLogin = harness.validator.validatedTokens.length;
      lockExistedDuringLogin = existsSync(harness.paths.loginLockPath);
    },
  });
  const { context } = harness.createCallContext();

  assert.equal(await harness.session.getToken(context), FRESH_TOKEN);
  assert.equal(harness.browserLogin.callCount, 1);
  assert.equal(validationsBeforeLogin, 0);
  assert.equal(lockExistedDuringLogin, true);
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
  assert.ok(harness.logs.includes('no token file, sign-in required'));
});

test('N4: a background request without a token file fails without sign-in or disk changes', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({ installed: false });

  await expectAuthenticationError(harness.session.getToken(BACKGROUND_CALL_CONTEXT), 'AUTHENTICATION_REQUIRED');
  assert.equal(harness.browserLogin.callCount, 0);
  assert.equal(harness.installer.callCount, 0);
  assert.equal(harness.launcher.inspectCalls, 0);
  assert.equal(await pathExists(harness.paths.stateDirectory), false);
  assert.ok(harness.logs.includes('background request needs sign-in, skipped'));
});

test('N5: a background 401 with the same token in the file fails without sign-in or installation', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({ installed: false });
  await harness.writeStoredToken(EXPIRED_TOKEN);

  await expectAuthenticationError(
    harness.session.recoverFromUnauthorized(EXPIRED_TOKEN, BACKGROUND_CALL_CONTEXT),
    'AUTHENTICATION_REQUIRED',
  );
  assert.equal(harness.browserLogin.callCount, 0);
  assert.equal(harness.launcher.inspectCalls, 0);
  assert.equal(harness.installer.callCount, 0);
});

test('N6: a background request with a token file returns the token', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeStoredToken(FRESH_TOKEN);

  assert.equal(await harness.session.getToken(BACKGROUND_CALL_CONTEXT), FRESH_TOKEN);
  assert.equal(harness.browserLogin.callCount, 0);
});

test('N7: a closed window fails the call, clears the attempt and a new call signs in again', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    loginSteps: [
      {
        kind: 'error',
        error: new MattermostAuthenticationError('LOGIN_WINDOW_CLOSED', 'The Mattermost sign-in window was closed.'),
      },
      { kind: 'token', token: FRESH_TOKEN },
    ],
  });

  await expectAuthenticationError(harness.session.getToken(harness.createCallContext().context), 'LOGIN_WINDOW_CLOSED');
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
  assert.equal(getPendingRecovery(harness.session), undefined);

  assert.equal(await harness.session.getToken(harness.createCallContext().context), FRESH_TOKEN);
  assert.equal(harness.browserLogin.callCount, 2);
});

test('N8: a waiter behind a live foreign lock reports progress and returns the token written by the holder', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeStoredToken(EXPIRED_TOKEN);
  await harness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS));
  const { context, notifications } = harness.createCallContext();

  const recovery = trackPromise(harness.session.recoverFromUnauthorized(EXPIRED_TOKEN, context));
  await advanceClockSteps(harness.clock, recovery, 20);
  await flushAsyncWork();
  assert.equal(notifications.length, 2);
  assert.equal(harness.logs.count('login lock busy (holder process 424242, age 0 s), waiting'), 1);

  await harness.clock.waitForPendingSleeps(1);
  await harness.writeStoredToken(FRESH_TOKEN);
  await unlink(harness.paths.loginLockPath);
  await advanceClockUntilSettled(harness.clock, recovery, { maximumSteps: 1 });

  assert.equal(await recovery.promise, FRESH_TOKEN);
  assert.equal(harness.browserLogin.callCount, 0);
  assert.ok(harness.logs.includes('newer token found in token file'));
});

test('N8: a released lock without a new token gives LOGIN_NOT_COMPLETED only on the second vacant step', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeStoredToken(EXPIRED_TOKEN);
  await harness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS));

  const recovery = trackPromise(harness.session.recoverFromUnauthorized(EXPIRED_TOKEN, harness.createCallContext().context));
  await advanceClockSteps(harness.clock, recovery, 3);
  await harness.clock.waitForPendingSleeps(1);
  await unlink(harness.paths.loginLockPath);

  await advanceClockSteps(harness.clock, recovery, 1);
  await harness.clock.waitForPendingSleeps(1);
  assert.equal(recovery.settled, false);

  await advanceClockUntilSettled(harness.clock, recovery, { maximumSteps: 1 });
  await expectAuthenticationError(recovery.promise, 'LOGIN_NOT_COMPLETED');
  assert.ok(harness.logs.includes('login lock released, token file unchanged'));
  assert.equal(harness.browserLogin.callCount, 0);
});

test('N8: a live record between vacant steps resets the vacant step counter', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeStoredToken(EXPIRED_TOKEN);
  await harness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS));

  const recovery = trackPromise(harness.session.recoverFromUnauthorized(EXPIRED_TOKEN, harness.createCallContext().context));
  await advanceClockSteps(harness.clock, recovery, 1);
  await harness.clock.waitForPendingSleeps(1);
  await unlink(harness.paths.loginLockPath);

  await advanceClockSteps(harness.clock, recovery, 1);
  await harness.clock.waitForPendingSleeps(1);
  await harness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, harness.clock.now()));

  await advanceClockSteps(harness.clock, recovery, 1);
  await harness.clock.waitForPendingSleeps(1);
  await unlink(harness.paths.loginLockPath);

  await advanceClockSteps(harness.clock, recovery, 1);
  await harness.clock.waitForPendingSleeps(1);
  assert.equal(recovery.settled, false);

  await advanceClockUntilSettled(harness.clock, recovery, { maximumSteps: 1 });
  await expectAuthenticationError(recovery.promise, 'LOGIN_NOT_COMPLETED');
  assert.equal(harness.browserLogin.callCount, 0);
});

test('N8: the confirmation read on the second vacant step returns a token written before the release', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  let outdatedReadsRemaining = 0;
  const harness = await createSessionHarness({
    readToken: async (read) => {
      const token = await read();
      if (outdatedReadsRemaining > 0) {
        outdatedReadsRemaining -= 1;
        return EXPIRED_TOKEN;
      }
      return token;
    },
  });
  await harness.writeStoredToken(EXPIRED_TOKEN);
  await harness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS));

  const recovery = trackPromise(harness.session.recoverFromUnauthorized(EXPIRED_TOKEN, harness.createCallContext().context));
  await advanceClockSteps(harness.clock, recovery, 1);
  await harness.clock.waitForPendingSleeps(1);
  await harness.writeStoredToken(FRESH_TOKEN);
  await unlink(harness.paths.loginLockPath);
  outdatedReadsRemaining = 2;

  await advanceClockUntilSettled(harness.clock, recovery, { maximumSteps: 2 });
  assert.equal(await recovery.promise, FRESH_TOKEN);
  assert.equal(outdatedReadsRemaining, 0);
  assert.equal(harness.browserLogin.callCount, 0);
});

test('N9: a lock of a dead process and a lock older than 360 s are taken and give one sign-in each', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const deadHolderHarness = await createSessionHarness();
  await deadHolderHarness.writeLockRecord(createForeignRecord(DEAD_PROCESS_ID, START_MILLISECONDS));
  assert.equal(await deadHolderHarness.session.getToken(deadHolderHarness.createCallContext().context), FRESH_TOKEN);
  assert.equal(deadHolderHarness.browserLogin.callCount, 1);
  assert.ok(deadHolderHarness.logs.includes('stale login lock removed (holder process 424243 not running)'));

  const oldLockHarness = await createSessionHarness();
  await oldLockHarness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS - 361_000));
  assert.equal(await oldLockHarness.session.getToken(oldLockHarness.createCallContext().context), FRESH_TOKEN);
  assert.equal(oldLockHarness.browserLogin.callCount, 1);
  assert.ok(oldLockHarness.logs.includes('stale login lock removed (age 361 s)'));
});

test('N10: parallel 401 responses in one process share one sign-in', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({ loginSteps: [{ kind: 'deferred' }] });
  await harness.writeStoredToken(EXPIRED_TOKEN);

  const calls = Array.from({ length: 10 }, () =>
    trackPromise(harness.session.recoverFromUnauthorized(EXPIRED_TOKEN, harness.createCallContext().context)),
  );
  await harness.browserLogin.waitForCalls(1);
  await waitForCondition(() => harness.logs.count('joining sign-in already in progress') === 9);
  harness.browserLogin.pendingResults[0].resolve(FRESH_TOKEN);

  assert.deepEqual(
    await Promise.all(calls.map((call) => call.promise)),
    Array.from({ length: 10 }, () => FRESH_TOKEN),
  );
  assert.equal(harness.browserLogin.callCount, 1);

  const sharedContextHarness = await createSessionHarness({ loginSteps: [{ kind: 'deferred' }] });
  await sharedContextHarness.writeStoredToken(EXPIRED_TOKEN);
  const { context } = sharedContextHarness.createCallContext();
  const sharedContextCalls = Array.from({ length: 3 }, () =>
    trackPromise(sharedContextHarness.session.recoverFromUnauthorized(EXPIRED_TOKEN, context)),
  );
  await sharedContextHarness.browserLogin.waitForCalls(1);
  await waitForCondition(() => sharedContextHarness.logs.count('joining sign-in already in progress') === 2);
  sharedContextHarness.browserLogin.pendingResults[0].resolve(FRESH_TOKEN);

  assert.deepEqual(
    await Promise.all(sharedContextCalls.map((call) => call.promise)),
    [FRESH_TOKEN, FRESH_TOKEN, FRESH_TOKEN],
  );
  assert.equal(sharedContextHarness.browserLogin.callCount, 1);
});

test('N11: a token written right after the lock is taken is returned without a window', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  harness.loginLock.hooks.afterTryAcquire = async (heldLock) => {
    if (heldLock !== undefined) {
      await harness.writeStoredToken(FRESH_TOKEN);
    }
  };

  assert.equal(await harness.session.getToken(harness.createCallContext().context), FRESH_TOKEN);
  assert.equal(harness.browserLogin.callCount, 0);
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
});

test('N12: the token is written before the lock is released', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();

  assert.equal(await harness.session.getToken(harness.createCallContext().context), FRESH_TOKEN);
  const writeIndex = harness.events.indexOf(WRITE_TOKEN_EVENT);
  const releaseIndex = harness.events.indexOf(LOCK_EVENTS.RELEASE);
  assert.ok(writeIndex !== -1 && releaseIndex !== -1);
  assert.ok(writeIndex < releaseIndex, harness.events.join(', '));
});

test('N13: a live foreign lock that is never released times out after 300 s without a window', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS));

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
  const settledAtMilliseconds = await advanceClockUntilSettled(harness.clock, recovery, { maximumSteps: 400 });

  await expectAuthenticationError(recovery.promise, 'LOGIN_TIMEOUT');
  assert.equal(settledAtMilliseconds - START_MILLISECONDS, 300_000);
  assert.ok(harness.logs.includes('sign-in timed out after 300 s (no browser window in this process)'));
  assert.equal(harness.browserLogin.callCount, 0);
});

test('N14: cancelling the owner call does not stop the sign-in and stops its notifications', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({ loginSteps: [{ kind: 'deferred' }] });
  const { context, controller, notifications } = harness.createCallContext();

  const recovery = trackPromise(harness.session.getToken(context));
  await harness.browserLogin.waitForCalls(1);
  harness.clock.advance(10_000);
  assert.equal(notifications.length, 1);

  controller.abort();
  harness.clock.advance(30_000);
  assert.equal(notifications.length, 1);
  assert.ok(harness.logs.includes('caller cancelled, sign-in continues in background'));

  harness.browserLogin.pendingResults[0].resolve(FRESH_TOKEN);
  assert.equal(await recovery.promise, FRESH_TOKEN);
  assert.equal(await harness.readStoredToken(), FRESH_TOKEN);
  assert.equal(notifications.length, 1);
});

test('N15: a laptop sleep longer than the deadline gives LOGIN_TIMEOUT without taking the lock', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  const lockContent = await harness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS));

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
  await harness.clock.waitForPendingSleeps(1);
  harness.clock.advance(400_000);

  await expectAuthenticationError(recovery.promise, 'LOGIN_TIMEOUT');
  assert.equal(harness.browserLogin.callCount, 0);
  assert.deepEqual(harness.launcher.launchCalls, []);
  assert.equal(await readFile(harness.paths.loginLockPath, TEXT_FILE_ENCODING), lockContent);
  assert.ok(harness.logs.includes('sign-in timed out after 300 s (no browser window in this process)'));
});

function sessionCookie(value: string): FakeCookieStep {
  return [{ name: 'MMAUTHTOKEN', value }];
}

for (const variant of [
  {
    name: 'a hanging validator and close',
    cookieSteps: [sessionCookie(FRESH_TOKEN)],
  },
  {
    name: 'hanging cookie reads and close',
    cookieSteps: ['never-resolves'] as FakeCookieStep[],
  },
]) {
  test(`N16: the lock is held at most 320 s with ${variant.name}`, { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
    const browserContext = new FakeLoginBrowserContext({ cookieSteps: variant.cookieSteps, closeNeverResolves: true });
    const harness = await createSessionHarness({
      realBrowserLoginContext: browserContext,
      validateToken: () => new Promise<TokenValidationResult>(() => undefined),
    });

    const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
    await advanceClockUntilSettled(harness.clock, recovery, { maximumSteps: 400 });

    await expectAuthenticationError(recovery.promise, 'LOGIN_TIMEOUT');
    assert.equal(harness.loginLock.acquiredAtMilliseconds.length, 1);
    assert.equal(harness.loginLock.releaseStartedAtMilliseconds.length, 1);
    const heldMilliseconds =
      harness.loginLock.releaseStartedAtMilliseconds[0] - harness.loginLock.acquiredAtMilliseconds[0];
    assert.ok(heldMilliseconds <= 320_000, `lock held for ${heldMilliseconds} ms`);
    assert.equal(await pathExists(harness.paths.loginLockPath), false);
  });
}

function createFakeResponse(status: number): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => ({}),
    text: async () => '',
  };
}

test('N17: the token validator maps statuses, exceptions and timeouts', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const requests: Array<{ url: string; request: HttpRequest }> = [];
  let behavior: (request: HttpRequest) => Promise<HttpResponse> = async () => createFakeResponse(200);
  const fetchImplementation: HttpFetch = (url, request) => {
    requests.push({ url, request });
    return behavior(request);
  };
  const validateToken = createTokenValidator(MATTERMOST_URL, fetchImplementation, 20);

  assert.deepEqual(await validateToken('candidate-token-1'), { kind: 'valid', statusDescription: 'status 200' });
  assert.equal(requests[0].url, `${MATTERMOST_URL}/users/me`);
  assert.equal(requests[0].request.method, 'GET');
  assert.equal(requests[0].request.headers.Authorization, 'Bearer candidate-token-1');
  assert.ok(requests[0].request.signal instanceof AbortSignal);

  behavior = async () => createFakeResponse(401);
  assert.deepEqual(await validateToken('candidate-token-1'), { kind: 'rejected', statusDescription: 'status 401' });

  behavior = async () => createFakeResponse(500);
  assert.deepEqual(await validateToken('candidate-token-1'), { kind: 'unavailable', statusDescription: 'status 500' });

  behavior = async () => {
    throw new TypeError('fetch failed for Bearer candidate-token-1');
  };
  assert.deepEqual(await validateToken('candidate-token-1'), { kind: 'unavailable', statusDescription: 'TypeError' });

  behavior = (request) =>
    new Promise<HttpResponse>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
    });
  assert.deepEqual(await validateToken('candidate-token-1'), { kind: 'unavailable', statusDescription: 'TimeoutError' });
});

test('N18: the static token provider never touches the browser or the disk', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const homeDirectory = await createTemporaryHome();
  const launcher = new FakeLoginBrowserLauncher();
  const installer = new FakeBrowserInstaller();
  let fetchCalls = 0;
  const fetchImplementation: HttpFetch = async () => {
    fetchCalls += 1;
    return createFakeResponse(200);
  };

  const provider = createTokenProvider(
    { mattermostUrl: MATTERMOST_URL, token: STATIC_TOKEN, teamId: TEAM_ID },
    fetchImplementation,
    { homeDirectory, launcher, installBrowser: installer.install },
  );
  assert.ok(provider instanceof StaticTokenProvider);
  assert.equal(provider.mode, 'static');
  const { context } = createSessionContextWithoutHarness();
  assert.equal(await provider.getToken(context), STATIC_TOKEN);
  assert.equal(await provider.recoverFromUnauthorized(STATIC_TOKEN, context), undefined);
  assert.deepEqual(launcher.launchCalls, []);
  assert.equal(launcher.inspectCalls, 0);
  assert.equal(installer.callCount, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(await pathExists(join(homeDirectory, '.config', 'mattermost-mcp')), false);

  const browserProvider = createTokenProvider(
    { mattermostUrl: MATTERMOST_URL, token: '', teamId: TEAM_ID },
    fetchImplementation,
    { homeDirectory, launcher, installBrowser: installer.install, logger: () => undefined },
  );
  assert.ok(browserProvider instanceof BrowserAuthenticationSession);
  assert.equal(browserProvider.mode, 'browser');
  assert.equal(await pathExists(join(homeDirectory, '.config')), false);
});

function createSessionContextWithoutHarness(): { context: RequestCallContext } {
  return {
    context: createToolCallContext({
      progressToken: undefined,
      sendProgressNotification: async () => undefined,
      cancellationSignal: new AbortController().signal,
      logger: () => undefined,
    }),
  };
}

test('N19: a fresh lock break of a dead process delays the takeover until it is stale', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeLockRecord(createForeignRecord(DEAD_PROCESS_ID, START_MILLISECONDS));
  await writeFile(
    harness.paths.loginLockBreakPath,
    JSON.stringify(createForeignRecord(DEAD_PROCESS_ID, START_MILLISECONDS)),
    { mode: PRIVATE_FILE_MODE },
  );

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
  await advanceClockSteps(harness.clock, recovery, 5);
  await harness.clock.waitForPendingSleeps(1);
  assert.equal(recovery.settled, false);
  assert.equal(harness.browserLogin.callCount, 0);

  harness.clock.advance(11_000);
  assert.equal(await recovery.promise, FRESH_TOKEN);
  assert.equal(harness.browserLogin.callCount, 1);
});

test('N20: a lock that appears only between inspect and link and then disappears gives LOGIN_NOT_COMPLETED', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  let foreignLockCreated = false;
  const harness: SessionTestHarness = await createSessionHarness({
    raceHook: async (stage) => {
      if (stage === 'before-link' && !foreignLockCreated) {
        foreignLockCreated = true;
        await harness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, harness.clock.now()));
      }
    },
  });

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
  await harness.clock.waitForPendingSleeps(1);
  assert.equal(foreignLockCreated, true);
  await unlink(harness.paths.loginLockPath);

  await advanceClockSteps(harness.clock, recovery, 1);
  await harness.clock.waitForPendingSleeps(1);
  assert.equal(recovery.settled, false);

  await advanceClockUntilSettled(harness.clock, recovery, { maximumSteps: 1 });
  await expectAuthenticationError(recovery.promise, 'LOGIN_NOT_COMPLETED');
  assert.equal(harness.browserLogin.callCount, 0);
  assert.ok(harness.logs.includes('login lock released, token file unchanged'));
});

test('N21: a waiter never inspects or installs Chromium', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({ installed: false });
  await harness.writeLockRecord(createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS));

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
  await advanceClockSteps(harness.clock, recovery, 5);
  await harness.clock.waitForPendingSleeps(1);
  await harness.writeStoredToken(FRESH_TOKEN);
  harness.clock.advance(1_000);

  assert.equal(await recovery.promise, FRESH_TOKEN);
  assert.equal(harness.launcher.inspectCalls, 0);
  assert.equal(harness.installer.callCount, 0);
  assert.equal(harness.browserLogin.callCount, 0);
});

test('N22: a second sign-in in the same call context gives UNAUTHORIZED_AFTER_RETRY', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeStoredToken(EXPIRED_TOKEN);
  const { context } = harness.createCallContext();

  assert.equal(await harness.session.recoverFromUnauthorized(EXPIRED_TOKEN, context), FRESH_TOKEN);
  await expectAuthenticationError(
    harness.session.recoverFromUnauthorized(FRESH_TOKEN, context),
    'UNAUTHORIZED_AFTER_RETRY',
  );
  assert.equal(harness.browserLogin.callCount, 1);
});

test('N23: a lost stale break race followed by a release without token gives LOGIN_NOT_COMPLETED', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness();
  await harness.writeLockRecord(createForeignRecord(DEAD_PROCESS_ID, START_MILLISECONDS));

  const otherEnteredVerification = createDeferred<void>();
  const verificationGate = createDeferred<void>();
  const otherLock = harness.createOtherLock({
    raceHook: async (stage) => {
      if (stage === 'before-break-verification') {
        otherEnteredVerification.resolve();
        await verificationGate.promise;
      }
    },
  });
  let otherBreak: Promise<HeldLoginLock | undefined> | undefined;
  harness.loginLock.hooks.afterInspect = async (state) => {
    if (state.kind === 'stale' && otherBreak === undefined) {
      otherBreak = otherLock.tryBreakStale(state);
      await otherEnteredVerification.promise;
    }
  };
  const sessionBreakResults: Array<HeldLoginLock | undefined> = [];
  harness.loginLock.hooks.tryBreakStale = async (run) => {
    let result: HeldLoginLock | undefined;
    try {
      result = await run();
      return result;
    } finally {
      sessionBreakResults.push(result);
      verificationGate.resolve();
    }
  };

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
  await waitForCondition(() => otherBreak !== undefined);
  const otherHeldLock = await otherBreak;
  assert.ok(otherHeldLock, 'the other instance must take the stale lock');
  await otherHeldLock.release();
  assert.deepEqual(sessionBreakResults, [undefined]);

  await advanceClockUntilSettled(harness.clock, recovery, { maximumSteps: 3 });
  await expectAuthenticationError(recovery.promise, 'LOGIN_NOT_COMPLETED');
  assert.equal(harness.browserLogin.callCount, 0);
  assert.ok(harness.logs.includes('login lock released, token file unchanged'));
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
  assert.equal(await pathExists(harness.paths.loginLockBreakPath), false);
});

const PLAN_JOURNAL_EVENTS = new Set<string>([
  LOCK_EVENTS.TRY_ACQUIRE,
  LOCK_EVENTS.TRY_BREAK_STALE,
  LOCK_EVENTS.RENEW,
  LOCK_EVENTS.RELEASE,
  INSPECT_INSTALLATION_EVENT,
  FAKE_LOGIN_EVENTS.INSTALL_BROWSER,
  FAKE_LOGIN_EVENTS.PERFORM_BROWSER_LOGIN,
  WRITE_TOKEN_EVENT,
]);

test('N24: the lock holder installs Chromium before opening the window and reports download progress', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'deferred' }], progress: INSTALLATION_PROGRESS },
    loginSteps: [{ kind: 'deferred' }],
  });
  const { context, notifications } = harness.createCallContext();

  const recovery = trackPromise(harness.session.getToken(context));
  await harness.installer.waitForCalls(1);
  harness.clock.advance(10_000);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].message, 'Downloading Chromium for Mattermost sign-in: 40% of 150.3 MiB (10 s)');

  harness.installer.pendingInstallations[0].resolve();
  await harness.browserLogin.waitForCalls(1);
  harness.clock.advance(10_000);
  assert.equal(notifications.length, 2);
  assert.match(notifications[1].message, /browser window/);

  harness.browserLogin.pendingResults[0].resolve(FRESH_TOKEN);
  assert.equal(await recovery.promise, FRESH_TOKEN);
  assert.deepEqual(
    harness.events.filter((event) => PLAN_JOURNAL_EVENTS.has(event)),
    [
      'tryAcquire',
      'inspectInstallation',
      'installBrowser',
      'renew',
      'inspectInstallation',
      'performBrowserLogin',
      'writeToken',
      'release',
    ],
  );
  assert.equal(harness.installer.callCount, 1);
  assert.equal(harness.browserLogin.callCount, 1);
  assertOrderedFragments(harness.logs.messages, [
    `Chromium not found in ${harness.paths.browsersDirectory}, downloading`,
    'Chromium installed in 10 s, sign-in timer started',
    'login lock acquired, opening browser window https://chat.example.test/login',
  ]);
});

test('N25: a long installation renews the lock every 30 s and the sign-in deadline starts after it', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'sleep', milliseconds: 400_000 }] },
    loginSteps: [{ kind: 'deferred' }],
  });
  const otherLock = harness.createOtherLock();

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext({ progressToken: undefined }).context));
  await harness.installer.waitForCalls(1);
  let stateAt390Seconds: LoginLockState | undefined;
  for (let step = 0; step < 40; step += 1) {
    await harness.clock.waitForPendingSleeps(2);
    if (harness.clock.now() === START_MILLISECONDS + 390_000) {
      stateAt390Seconds = await otherLock.inspect();
    }
    harness.clock.advance(10_000);
  }
  await harness.browserLogin.waitForCalls(1);

  assert.equal(stateAt390Seconds?.kind, 'live');
  const installationSettledIndex = harness.events.indexOf(FAKE_LOGIN_EVENTS.INSTALLATION_SETTLED);
  const renewalsDuringInstallation = countEvents(harness.events.slice(0, installationSettledIndex), LOCK_EVENTS.RENEW);
  const renewalsAfterInstallation = countEvents(harness.events.slice(installationSettledIndex), LOCK_EVENTS.RENEW);
  assert.ok(renewalsDuringInstallation >= 13, `renewals during installation: ${renewalsDuringInstallation}`);
  assert.equal(renewalsAfterInstallation, 1);
  assert.equal(
    harness.browserLogin.requests[0].deadlineMilliseconds,
    START_MILLISECONDS + 400_000 + DEFAULT_AUTHENTICATION_TIMINGS.loginTimeoutMilliseconds,
  );
  assert.equal(harness.clock.pendingSleepCount(), 0);

  harness.browserLogin.pendingResults[0].resolve(FRESH_TOKEN);
  assert.equal(await recovery.promise, FRESH_TOKEN);
});

test('N26: a failed installation is returned to the call and a new call installs again', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const installationError = new MattermostAuthenticationError(
    'BROWSER_INSTALLATION_FAILED',
    'Chromium download failed: Download failure, code=1; getaddrinfo ENOTFOUND cdn.playwright.dev',
  );
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'fail', error: installationError }, { kind: 'succeed' }] },
  });

  await expectAuthenticationError(
    harness.session.getToken(harness.createCallContext().context),
    'BROWSER_INSTALLATION_FAILED',
    'getaddrinfo ENOTFOUND cdn.playwright.dev',
  );
  assert.equal(harness.browserLogin.callCount, 0);
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
  assert.equal(getPendingRecovery(harness.session), undefined);

  assert.equal(await harness.session.getToken(harness.createCallContext().context), FRESH_TOKEN);
  assert.equal(harness.installer.callCount, 2);
  assert.equal(harness.browserLogin.callCount, 1);
});

test('N27: Chromium still missing after a successful installation fails without a window', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { markInstalledOnSuccess: false },
  });

  await expectAuthenticationError(
    harness.session.getToken(harness.createCallContext().context),
    'BROWSER_INSTALLATION_FAILED',
    'Chromium is still missing after installation',
  );
  assert.equal(harness.browserLogin.callCount, 0);
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
});

test('N28 (a): cancelling the only call cancels the installation and releases the lock after it ends', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'deferred' }], rejectOnAbort: false },
  });
  const { context, controller } = harness.createCallContext();

  const recovery = trackPromise(harness.session.getToken(context));
  await harness.installer.waitForCalls(1);
  controller.abort();
  const installationSignal = harness.installer.signals[0];
  assert.equal(installationSignal.aborted, true);
  assert.equal(installationSignal.reason, 'cancelled');

  await flushAsyncWork();
  await flushAsyncWork();
  assert.equal(harness.events.includes(LOCK_EVENTS.RELEASE), false);
  assert.equal(await pathExists(harness.paths.loginLockPath), true);

  harness.installer.pendingInstallations[0].reject(createCancelledInstallationError(installationSignal));
  await expectAuthenticationError(recovery.promise, 'BROWSER_INSTALLATION_FAILED');
  assert.ok(
    harness.events.indexOf(FAKE_LOGIN_EVENTS.INSTALLATION_SETTLED) < harness.events.indexOf(LOCK_EVENTS.RELEASE),
  );
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
  assert.equal(harness.browserLogin.callCount, 0);
});

test('N28 (b): the installation is cancelled only when the last interested call is cancelled', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'deferred' }] },
  });
  const first = harness.createCallContext();
  const second = harness.createCallContext();

  const firstCall = trackPromise(harness.session.getToken(first.context));
  await harness.installer.waitForCalls(1);
  const secondCall = trackPromise(harness.session.getToken(second.context));
  await waitForCondition(() => harness.logs.includes('joining sign-in already in progress'));

  first.controller.abort();
  assert.equal(harness.installer.signals[0].aborted, false);
  second.controller.abort();
  assert.equal(harness.installer.signals[0].aborted, true);
  assert.equal(harness.installer.signals[0].reason, 'cancelled');

  await expectAuthenticationError(firstCall.promise, 'BROWSER_INSTALLATION_FAILED');
  await expectAuthenticationError(secondCall.promise, 'BROWSER_INSTALLATION_FAILED');
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
  assert.equal(harness.browserLogin.callCount, 0);
});

test('N28 (c): cancelling during the sign-in window does not touch the finished installation', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    loginSteps: [{ kind: 'deferred' }],
  });
  const { context, controller } = harness.createCallContext();

  const recovery = trackPromise(harness.session.getToken(context));
  await harness.browserLogin.waitForCalls(1);
  controller.abort();
  harness.browserLogin.pendingResults[0].resolve(FRESH_TOKEN);

  assert.equal(await recovery.promise, FRESH_TOKEN);
  assert.equal(await harness.readStoredToken(), FRESH_TOKEN);
  assert.equal(harness.installer.signals[0].aborted, false);
});

test('N28 (d): a call cancelled while waiting starts no installation after taking a stale lock', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({ installed: false });
  const liveRecord = createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS);
  await harness.writeLockRecord(liveRecord);
  const { context, controller } = harness.createCallContext();

  const recovery = trackPromise(harness.session.getToken(context));
  await advanceClockSteps(harness.clock, recovery, 2);
  controller.abort();
  await harness.clock.waitForPendingSleeps(1);
  await harness.writeLockRecord({ ...liveRecord, processId: DEAD_PROCESS_ID });

  /* Кроме шага опроса часы видят короткоживущий сон интервала обновления, поэтому запас шагов больше двух */
  await advanceClockUntilSettled(harness.clock, recovery, { maximumSteps: 5 });
  await expectAuthenticationError(recovery.promise, 'BROWSER_INSTALLATION_FAILED');
  assert.equal(harness.installer.callCount, 1);
  assert.equal(harness.installer.signals[0].aborted, true);
  assert.equal(harness.installer.signals[0].reason, 'cancelled');
  assert.equal(harness.browserLogin.callCount, 0);
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
});

test('N28 (e): a call after a cancelled installation waits for that attempt and then starts a new one', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'deferred' }, { kind: 'succeed' }], rejectOnAbort: false },
  });
  const first = harness.createCallContext();
  const second = harness.createCallContext();

  const firstCall = trackPromise(harness.session.getToken(first.context));
  await harness.installer.waitForCalls(1);
  first.controller.abort();
  assert.equal(harness.installer.signals[0].aborted, true);

  const secondCall = trackPromise(harness.session.getToken(second.context));
  await waitForCondition(() => harness.logs.includes('previous sign-in attempt was cancelled, waiting for it to finish'));
  await flushAsyncWork();
  assert.equal(secondCall.settled, false);
  assert.equal(harness.installer.callCount, 1);
  assert.equal(harness.logs.includes('joining sign-in already in progress'), false);

  harness.installer.pendingInstallations[0].reject(createCancelledInstallationError(harness.installer.signals[0]));
  await expectAuthenticationError(firstCall.promise, 'BROWSER_INSTALLATION_FAILED');

  assert.equal(await secondCall.promise, FRESH_TOKEN);
  assert.equal(harness.installer.callCount, 2);
  assert.equal(harness.installer.signals[1].aborted, false);
  assert.equal(harness.browserLogin.callCount, 1);
});

test('N28 (f): a call cancelled before the installation does not cancel it for a call that joined later', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({ installed: false });
  const liveRecord = createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS);
  await harness.writeLockRecord(liveRecord);
  const first = harness.createCallContext();
  const second = harness.createCallContext();

  const firstCall = trackPromise(harness.session.getToken(first.context));
  await advanceClockSteps(harness.clock, firstCall, 1);
  first.controller.abort();
  const secondCall = trackPromise(harness.session.getToken(second.context));
  await waitForCondition(() => harness.logs.includes('joining sign-in already in progress'));

  await harness.clock.waitForPendingSleeps(1);
  await harness.writeLockRecord({ ...liveRecord, processId: DEAD_PROCESS_ID });
  await advanceClockUntilSettled(harness.clock, secondCall, { maximumSteps: 5 });

  assert.equal(await secondCall.promise, FRESH_TOKEN);
  assert.equal(await firstCall.promise, FRESH_TOKEN);
  assert.equal(harness.installer.callCount, 1);
  assert.equal(harness.installer.signals[0].aborted, false);
});

test('N28 (g): cancelling during the window after the download lets a new call join the same attempt', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    loginSteps: [{ kind: 'deferred' }],
  });
  const first = harness.createCallContext();
  const second = harness.createCallContext();

  const firstCall = trackPromise(harness.session.getToken(first.context));
  await harness.browserLogin.waitForCalls(1);
  first.controller.abort();

  const pendingRecovery = getPendingRecovery(harness.session);
  assert.ok(pendingRecovery);
  assert.equal(pendingRecovery.installationAbortController, undefined);
  assert.equal(pendingRecovery.installationCancelled, false);
  assert.equal(harness.installer.signals[0].aborted, false);

  const secondCall = trackPromise(harness.session.getToken(second.context));
  await waitForCondition(() => harness.logs.includes('joining sign-in already in progress'));
  assert.equal(harness.logs.includes('previous sign-in attempt was cancelled'), false);

  harness.clock.advance(10_000);
  assert.equal(second.notifications.length, 1);
  assert.match(second.notifications[0].message, /browser window/);

  harness.browserLogin.pendingResults[0].resolve(FRESH_TOKEN);
  assert.equal(await secondCall.promise, FRESH_TOKEN);
  assert.equal(await firstCall.promise, FRESH_TOKEN);
  assert.equal(harness.installer.callCount, 1);
  assert.equal(harness.browserLogin.callCount, 1);
});

test('N28 (g): an installation that succeeds despite a late cancellation clears the cancelled flag', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'deferred' }], rejectOnAbort: false },
    loginSteps: [{ kind: 'deferred' }],
  });
  const first = harness.createCallContext();
  const second = harness.createCallContext();

  const firstCall = trackPromise(harness.session.getToken(first.context));
  await harness.installer.waitForCalls(1);
  first.controller.abort();
  assert.equal(harness.installer.signals[0].aborted, true);
  assert.equal(getPendingRecovery(harness.session)?.installationCancelled, true);

  harness.installer.pendingInstallations[0].resolve();
  await harness.browserLogin.waitForCalls(1);
  const pendingRecovery = getPendingRecovery(harness.session);
  assert.equal(pendingRecovery?.installationCancelled, false);
  assert.equal(pendingRecovery?.installationAbortController, undefined);

  const secondCall = trackPromise(harness.session.getToken(second.context));
  await waitForCondition(() => harness.logs.includes('joining sign-in already in progress'));
  assert.equal(harness.logs.includes('previous sign-in attempt was cancelled'), false);

  harness.browserLogin.pendingResults[0].resolve(FRESH_TOKEN);
  assert.equal(await secondCall.promise, FRESH_TOKEN);
  assert.equal(await firstCall.promise, FRESH_TOKEN);
  assert.equal(harness.installer.callCount, 1);
  assert.equal(harness.browserLogin.callCount, 1);
});

test('N28 (h): a call waiting for a cancelled attempt never joins the settled attempt object', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'deferred' }, { kind: 'succeed' }], rejectOnAbort: false },
  });
  const first = harness.createCallContext();
  const second = harness.createCallContext();

  const firstCall = trackPromise(harness.session.getToken(first.context));
  await harness.installer.waitForCalls(1);
  const waitedRecovery = getPendingRecovery(harness.session) as { promise: Promise<string>; settled: boolean } | undefined;
  assert.ok(waitedRecovery);
  /* Обработчик зарегистрирован раньше ожидания второго вызова, поэтому ссылка возвращается до его продолжения */
  waitedRecovery.promise.catch(() => {
    Reflect.set(harness.session, 'pendingRecovery', waitedRecovery);
  });
  first.controller.abort();

  const secondCall = trackPromise(harness.session.getToken(second.context));
  await waitForCondition(() => harness.logs.includes('previous sign-in attempt was cancelled, waiting for it to finish'));
  harness.clock.advance(10_000);
  assert.equal(second.notifications.length, 1);

  harness.installer.pendingInstallations[0].reject(createCancelledInstallationError(harness.installer.signals[0]));
  await expectAuthenticationError(firstCall.promise, 'BROWSER_INSTALLATION_FAILED');

  assert.equal(await secondCall.promise, FRESH_TOKEN);
  assert.equal(waitedRecovery.settled, true);
  assert.equal(harness.installer.callCount, 2);
  assert.equal(harness.logs.includes('joining sign-in already in progress'), false);
});

async function runWaiterWithRenewals(options: {
  renewAt: (elapsedMilliseconds: number) => 'same-nonce' | 'other-nonce' | undefined;
  maximumElapsedMilliseconds: number;
}): Promise<{ harness: SessionTestHarness; settledAfterMilliseconds: number; call: TrackedPromise<string>; notifications: SentNotification[] }> {
  const harness = await createSessionHarness();
  let record = createForeignRecord(LIVE_FOREIGN_PROCESS_ID, START_MILLISECONDS);
  await harness.writeLockRecord(record);
  const { context, notifications } = harness.createCallContext();

  const call = trackPromise(harness.session.getToken(context));
  while (true) {
    await Promise.race([harness.clock.waitForPendingSleeps(1), call.done]);
    if (call.settled) {
      break;
    }
    const elapsedMilliseconds = harness.clock.now() - START_MILLISECONDS;
    assert.ok(elapsedMilliseconds <= options.maximumElapsedMilliseconds, 'waiter did not time out');
    const renewal = elapsedMilliseconds > 0 ? options.renewAt(elapsedMilliseconds) : undefined;
    if (renewal === 'same-nonce') {
      record = { ...record, createdAtMilliseconds: harness.clock.now() };
      await harness.writeLockRecord(record);
    } else if (renewal === 'other-nonce') {
      record = createForeignRecord(LIVE_FOREIGN_PROCESS_ID, harness.clock.now());
      await harness.writeLockRecord(record);
    }
    harness.clock.advance(1_000);
  }
  return { harness, settledAfterMilliseconds: harness.clock.now() - START_MILLISECONDS, call, notifications };
}

test('N29: a waiter extends its deadline when the holder renews the record', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const { harness, settledAfterMilliseconds, call, notifications } = await runWaiterWithRenewals({
    renewAt: (elapsedMilliseconds) =>
      elapsedMilliseconds === 200_000 || elapsedMilliseconds === 290_000 ? 'same-nonce' : undefined,
    maximumElapsedMilliseconds: 700_000,
  });

  await expectAuthenticationError(call.promise, 'LOGIN_TIMEOUT');
  assert.ok(settledAfterMilliseconds > 580_000);
  assert.ok(settledAfterMilliseconds >= 590_000 && settledAfterMilliseconds <= 592_000, `timed out after ${settledAfterMilliseconds} ms`);
  assert.equal(harness.logs.count('login lock renewed by holder process 424242, extending wait'), 1);
  assert.ok(notifications.length > 0);
  assert.ok(notifications.every((notification) => notification.message.includes('another process')));
  assert.equal(harness.browserLogin.callCount, 0);
});

test('N29: a record with another nonce does not extend the deadline', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const { harness, settledAfterMilliseconds, call } = await runWaiterWithRenewals({
    renewAt: (elapsedMilliseconds) => (elapsedMilliseconds === 290_000 ? 'other-nonce' : undefined),
    maximumElapsedMilliseconds: 400_000,
  });

  await expectAuthenticationError(call.promise, 'LOGIN_TIMEOUT');
  assert.equal(settledAfterMilliseconds, 300_000);
  assert.equal(harness.logs.includes('extending wait'), false);
});

test('N29: renewals without end stop extending the deadline at 954 s after the record first appeared', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const { settledAfterMilliseconds, call } = await runWaiterWithRenewals({
    renewAt: (elapsedMilliseconds) => (elapsedMilliseconds % 30_000 === 0 ? 'same-nonce' : undefined),
    maximumElapsedMilliseconds: 1_000_000,
  });

  await expectAuthenticationError(call.promise, 'LOGIN_TIMEOUT');
  assert.ok(settledAfterMilliseconds >= 954_000 && settledAfterMilliseconds <= 956_000, `timed out after ${settledAfterMilliseconds} ms`);
});

test('N30: a lost lock during installation stops the installer with its own reason', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'deferred' }] },
  });
  harness.loginLock.hooks.renew = async (renew, callIndex) => (callIndex === 0 ? 'lost' : renew());

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
  await harness.installer.waitForCalls(1);
  await harness.clock.waitForPendingSleeps(1);
  harness.clock.advance(30_000);

  await expectAuthenticationError(recovery.promise, 'LOGIN_NOT_COMPLETED');
  assert.equal(harness.installer.signals[0].aborted, true);
  assert.equal(harness.installer.signals[0].reason, 'stopped because login lock was lost');
  assert.equal(harness.browserLogin.callCount, 0);
  assert.ok(harness.logs.includes('login lock lost during Chromium installation'));
});

test('N31: an unexpected renewal error releases the lock only after the installer ended', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'deferred' }], rejectOnAbort: false },
  });
  const renewalError = new Error('unexpected renewal failure');
  harness.loginLock.hooks.renew = async () => {
    throw renewalError;
  };

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
  await harness.installer.waitForCalls(1);
  await harness.clock.waitForPendingSleeps(1);
  harness.clock.advance(30_000);
  await waitForCondition(() => harness.installer.signals[0].aborted);
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(harness.events.includes(LOCK_EVENTS.RELEASE), false);
  assert.equal(await pathExists(harness.paths.loginLockPath), true);

  harness.installer.pendingInstallations[0].reject(createCancelledInstallationError(harness.installer.signals[0]));
  await assert.rejects(recovery.promise, renewalError);
  assert.ok(
    harness.events.indexOf(FAKE_LOGIN_EVENTS.INSTALLATION_SETTLED) < harness.events.indexOf(LOCK_EVENTS.RELEASE),
    harness.events.join(', '),
  );
  assert.equal(harness.browserLogin.callCount, 0);
  assert.equal(await pathExists(harness.paths.loginLockPath), false);
});

test('N31: a removed state directory during installation gives LOGIN_NOT_COMPLETED and a logged release failure', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const harness = await createSessionHarness({
    installed: false,
    installer: { steps: [{ kind: 'deferred' }] },
  });

  const recovery = trackPromise(harness.session.getToken(harness.createCallContext().context));
  await harness.installer.waitForCalls(1);
  await harness.clock.waitForPendingSleeps(1);
  await rm(harness.paths.stateDirectory, { recursive: true, force: true });
  harness.clock.advance(30_000);

  await expectAuthenticationError(recovery.promise, 'LOGIN_NOT_COMPLETED');
  assert.ok(harness.logs.includes('login lock renewal failed (ENOENT)'));
  assert.ok(harness.logs.includes('login lock release failed (ENOENT)'));
  assert.equal(harness.installer.signals[0].reason, 'stopped because login lock was lost');
  assert.equal(harness.browserLogin.callCount, 0);
});
