import assert from 'node:assert/strict';
import { ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AUTHENTICATION_TIMINGS,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  TEXT_FILE_ENCODING,
} from '../../src/authentication/constants.js';
import {
  HeldLoginLock,
  LoginLock,
  LoginLockOptions,
  LoginLockRecord,
  LoginLockRenewalResult,
  LoginLockState,
  isProcessAlive,
} from '../../src/authentication/loginLock.js';
import { systemClock } from '../../src/authentication/runtime.js';
import { StatePaths, resolveStatePaths } from '../../src/authentication/stateFiles.js';
import { FakeClock } from '../fixtures/fakeClock.js';

const START_MILLISECONDS = 1_000_000_000_000;
const LIVE_FOREIGN_PROCESS_ID = 424242;
const DEAD_PROCESS_ID = 424243;
const PERMISSION_BITS_MASK = 0o777;
const CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS = 30_000;
const SIGNAL_EXIT_DEADLINE_MILLISECONDS = 2_000;

const temporaryDirectories: string[] = [];
const fixtureProcesses: Array<ChildProcessByStdio<null, Readable, Readable>> = [];

after(async () => {
  for (const child of fixtureProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeIsProcessAlive(processId: number): boolean {
  return processId !== DEAD_PROCESS_ID;
}

interface LockTestContext {
  homeDirectory: string;
  paths: StatePaths;
  clock: FakeClock;
  messages: string[];
  createLock(overrides?: Partial<LoginLockOptions>): LoginLock;
}

async function createTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-login-lock-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createLockTestContext(): Promise<LockTestContext> {
  const homeDirectory = await createTemporaryHome();
  const paths = resolveStatePaths(homeDirectory);
  const clock = new FakeClock(START_MILLISECONDS);
  const messages: string[] = [];
  const createLock = (overrides: Partial<LoginLockOptions> = {}) =>
    new LoginLock({
      paths,
      timings: DEFAULT_AUTHENTICATION_TIMINGS,
      logger: (message) => messages.push(message),
      clock,
      isProcessAlive: fakeIsProcessAlive,
      ...overrides,
    });
  return { homeDirectory, paths, clock, messages, createLock };
}

async function writeRawFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await writeFile(filePath, content);
}

function createRecordContent(processId: number, createdAtMilliseconds: number, nonce: string = randomUUID()): string {
  return JSON.stringify({ processId, createdAtMilliseconds, nonce });
}

async function readRecordFile(filePath: string): Promise<LoginLockRecord> {
  return JSON.parse(await readFile(filePath, TEXT_FILE_ENCODING)) as LoginLockRecord;
}

async function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

async function acquireOrFail(lock: LoginLock): Promise<HeldLoginLock> {
  const heldLock = await lock.tryAcquire();
  assert.ok(heldLock, 'expected to acquire the login lock');
  return heldLock;
}

async function inspectStaleState(lock: LoginLock): Promise<Extract<LoginLockState, { kind: 'stale' }>> {
  const state = await lock.inspect();
  if (state.kind !== 'stale') {
    assert.fail(`expected stale login lock, got ${state.kind}`);
  }
  return state;
}

test('fake process ids differ from the test process id', () => {
  assert.notEqual(process.pid, LIVE_FOREIGN_PROCESS_ID);
  assert.notEqual(process.pid, DEAD_PROCESS_ID);
});

test('L1: record content and exclusive acquisition', async () => {
  const context = await createLockTestContext();
  const firstLock = context.createLock();
  const heldLock = await acquireOrFail(firstLock);

  const fileRecord = await readRecordFile(context.paths.loginLockPath);
  assert.deepEqual(fileRecord, heldLock.record);
  assert.equal(fileRecord.processId, process.pid);
  assert.equal(fileRecord.createdAtMilliseconds, START_MILLISECONDS);
  assert.equal(typeof fileRecord.nonce, 'string');
  assert.ok(fileRecord.nonce.length > 0);
  assert.equal((await stat(context.paths.loginLockPath)).mode & PERMISSION_BITS_MASK, PRIVATE_FILE_MODE);

  assert.equal(await firstLock.tryAcquire(), undefined);
  assert.equal(await context.createLock().tryAcquire(), undefined);
  assert.deepEqual(await context.createLock().inspect(), { kind: 'live', record: heldLock.record });

  await heldLock.release();
});

test('L2: release removes own lock and keeps a foreign record', async () => {
  const context = await createLockTestContext();
  const lock = context.createLock();

  const firstHeldLock = await acquireOrFail(lock);
  await firstHeldLock.release();
  assert.equal(await pathExists(context.paths.loginLockPath), false);

  const secondHeldLock = await acquireOrFail(lock);
  const foreignContent = createRecordContent(LIVE_FOREIGN_PROCESS_ID, context.clock.now(), 'foreign-holder-nonce');
  await writeFile(context.paths.loginLockPath, foreignContent);
  await secondHeldLock.release();

  assert.equal(await readFile(context.paths.loginLockPath, TEXT_FILE_ENCODING), foreignContent);
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);
});

test('L3: inspect reports every stale reason and live records of other instances', async () => {
  const context = await createLockTestContext();
  const now = context.clock.now();
  const staleCases = [
    {
      content: createRecordContent(DEAD_PROCESS_ID, now),
      reason: `holder process ${DEAD_PROCESS_ID} not running`,
    },
    {
      content: createRecordContent(LIVE_FOREIGN_PROCESS_ID, now - 361_000),
      reason: 'age 361 s',
    },
    {
      content: 'not a login lock record',
      reason: 'unreadable record',
    },
    {
      content: createRecordContent(process.pid, now),
      reason: 'own process with unknown nonce',
    },
  ];

  for (const staleCase of staleCases) {
    await writeRawFile(context.paths.loginLockPath, staleCase.content);
    assert.deepEqual(await context.createLock().inspect(), {
      kind: 'stale',
      rawContent: staleCase.content,
      reason: staleCase.reason,
    });
  }

  await unlink(context.paths.loginLockPath);
  const heldLock = await acquireOrFail(context.createLock());
  assert.deepEqual(await context.createLock().inspect(), { kind: 'live', record: heldLock.record });
  await heldLock.release();
});

test('L4: tryBreakStale takes a lock of a dead process', async () => {
  const context = await createLockTestContext();
  await writeRawFile(context.paths.loginLockPath, createRecordContent(DEAD_PROCESS_ID, context.clock.now()));
  const lock = context.createLock();

  const heldLock = await lock.tryBreakStale(await inspectStaleState(lock));
  assert.ok(heldLock);
  assert.deepEqual(await readRecordFile(context.paths.loginLockPath), heldLock.record);
  assert.ok(context.messages.includes(`stale login lock removed (holder process ${DEAD_PROCESS_ID} not running)`));
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);

  await heldLock.release();
});

test('L5: lock removed before break verification gives no ownership', async () => {
  const context = await createLockTestContext();
  await writeRawFile(context.paths.loginLockPath, createRecordContent(DEAD_PROCESS_ID, context.clock.now()));
  const lock = context.createLock({
    raceHook: async (stage) => {
      if (stage === 'before-break-verification') {
        await unlink(context.paths.loginLockPath);
      }
    },
  });

  assert.equal(await lock.tryBreakStale(await inspectStaleState(lock)), undefined);
  assert.equal(await pathExists(context.paths.loginLockPath), false);
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);
});

test('L6: lock replaced by a fresh foreign record before break verification stays intact', async () => {
  const context = await createLockTestContext();
  await writeRawFile(context.paths.loginLockPath, createRecordContent(DEAD_PROCESS_ID, context.clock.now()));
  const foreignContent = createRecordContent(LIVE_FOREIGN_PROCESS_ID, context.clock.now());
  const lock = context.createLock({
    raceHook: async (stage) => {
      if (stage === 'before-break-verification') {
        await writeFile(context.paths.loginLockPath, foreignContent);
      }
    },
  });

  assert.equal(await lock.tryBreakStale(await inspectStaleState(lock)), undefined);
  assert.equal(await readFile(context.paths.loginLockPath, TEXT_FILE_ENCODING), foreignContent);
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);
});

test('L7: regular acquisition after stale unlink keeps a single owner', async () => {
  const context = await createLockTestContext();
  await writeRawFile(context.paths.loginLockPath, createRecordContent(DEAD_PROCESS_ID, context.clock.now()));
  const otherLock = context.createLock();
  let otherHeldLock: HeldLoginLock | undefined;
  const lock = context.createLock({
    raceHook: async (stage) => {
      if (stage === 'after-stale-unlink') {
        otherHeldLock = await otherLock.tryAcquire();
      }
    },
  });

  assert.equal(await lock.tryBreakStale(await inspectStaleState(lock)), undefined);
  assert.ok(otherHeldLock);
  assert.deepEqual(await readRecordFile(context.paths.loginLockPath), otherHeldLock.record);
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);

  await otherHeldLock.release();
});

test('L8: another instance sees breaking while a stale lock is being replaced', async () => {
  const context = await createLockTestContext();
  await writeRawFile(context.paths.loginLockPath, createRecordContent(DEAD_PROCESS_ID, context.clock.now()));
  const otherLock = context.createLock();
  let observedState: LoginLockState | undefined;
  const lock = context.createLock({
    raceHook: async (stage) => {
      if (stage === 'after-stale-unlink') {
        observedState = await otherLock.inspect();
      }
    },
  });

  const heldLock = await lock.tryBreakStale(await inspectStaleState(lock));
  assert.ok(heldLock);
  assert.deepEqual(observedState, { kind: 'breaking' });

  await heldLock.release();
});

test('L9: fresh lock break reports breaking and is removed once its record is stale', async () => {
  const context = await createLockTestContext();
  const liveRecord: LoginLockRecord = {
    processId: LIVE_FOREIGN_PROCESS_ID,
    createdAtMilliseconds: context.clock.now(),
    nonce: 'live-foreign-nonce',
  };
  await writeRawFile(context.paths.loginLockPath, JSON.stringify(liveRecord));
  await writeRawFile(context.paths.loginLockBreakPath, createRecordContent(LIVE_FOREIGN_PROCESS_ID, context.clock.now()));
  const lock = context.createLock();

  assert.deepEqual(await lock.inspect(), { kind: 'breaking' });
  assert.equal(await pathExists(context.paths.loginLockBreakPath), true);

  context.clock.advance(11_000);
  assert.deepEqual(await lock.inspect(), { kind: 'live', record: liveRecord });
  assert.ok(context.messages.includes('stale lock break file removed'));
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);
});

test('L10: unreadable lock break is removed on the first inspect', async () => {
  const context = await createLockTestContext();
  await writeRawFile(context.paths.loginLockBreakPath, 'not a lock break record');

  assert.deepEqual(await context.createLock().inspect(), { kind: 'vacant' });
  assert.ok(context.messages.includes('stale lock break file removed'));
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);
});

test('L11: four instances breaking one stale lock produce exactly one owner in 20 repetitions', async () => {
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const context = await createLockTestContext();
    await writeRawFile(context.paths.loginLockPath, createRecordContent(DEAD_PROCESS_ID, context.clock.now()));

    const instancesAtVerification: number[] = [];
    const attempts: Array<Promise<HeldLoginLock | LoginLockState['kind'] | 'lock break busy'>> = [];
    let markAttemptsStarted: () => void = () => undefined;
    const attemptsStarted = new Promise<void>((resolve) => {
      markAttemptsStarted = resolve;
    });

    const locks = Array.from({ length: 4 }, (_, instanceIndex) =>
      context.createLock({
        raceHook: async (stage) => {
          if (stage !== 'before-break-verification') {
            return;
          }
          instancesAtVerification.push(instanceIndex);
          if (instancesAtVerification.length > 1) {
            throw new Error('second instance reached break verification');
          }
          await attemptsStarted;
          await Promise.allSettled(attempts.filter((_, attemptIndex) => attemptIndex !== instanceIndex));
        },
      }),
    );

    for (const lock of locks) {
      attempts.push(
        (async () => {
          const state = await lock.inspect();
          if (state.kind !== 'stale') {
            return state.kind;
          }
          return (await lock.tryBreakStale(state)) ?? 'lock break busy';
        })(),
      );
    }
    markAttemptsStarted();
    const outcomes = await Promise.all(attempts);

    const owners = outcomes.filter((outcome): outcome is HeldLoginLock => typeof outcome === 'object');
    assert.equal(owners.length, 1, `repetition ${repetition}`);
    assert.equal(instancesAtVerification.length, 1, `repetition ${repetition}`);
    assert.equal(outcomes.indexOf(owners[0]), instancesAtVerification[0]);
    for (const outcome of outcomes) {
      if (typeof outcome !== 'object') {
        assert.ok(outcome === 'breaking' || outcome === 'lock break busy', `unexpected outcome ${outcome}`);
      }
    }
    assert.deepEqual(await readRecordFile(context.paths.loginLockPath), owners[0].record);
    assert.equal(await pathExists(context.paths.loginLockBreakPath), false);

    await owners[0].release();
  }
});

test('L12: release waits for a fresh foreign lock break', async () => {
  const context = await createLockTestContext();
  const heldLock = await acquireOrFail(context.createLock());
  await writeRawFile(context.paths.loginLockBreakPath, createRecordContent(LIVE_FOREIGN_PROCESS_ID, context.clock.now()));

  let releaseSettled = false;
  const release = heldLock.release().then(() => {
    releaseSettled = true;
  });
  await context.clock.waitForPendingSleeps(1);
  assert.equal(releaseSettled, false);
  assert.equal(await pathExists(context.paths.loginLockPath), true);

  context.clock.advance(11_000);
  await release;
  assert.equal(await pathExists(context.paths.loginLockPath), false);
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);
});

test('L12: release gives up after its timeout while the lock break stays busy', async () => {
  const context = await createLockTestContext();
  const lock = context.createLock({
    timings: { ...DEFAULT_AUTHENTICATION_TIMINGS, lockReleaseTimeoutMilliseconds: 5_000 },
  });
  const heldLock = await acquireOrFail(lock);
  const foreignLockBreakContent = createRecordContent(LIVE_FOREIGN_PROCESS_ID, context.clock.now());
  await writeRawFile(context.paths.loginLockBreakPath, foreignLockBreakContent);

  const release = heldLock.release();
  await context.clock.waitForPendingSleeps(1);
  context.clock.advance(5_000);
  await release;

  assert.ok(context.messages.includes('login lock release skipped, lock break busy'));
  assert.deepEqual(await readRecordFile(context.paths.loginLockPath), heldLock.record);
  assert.equal(await readFile(context.paths.loginLockBreakPath, TEXT_FILE_ENCODING), foreignLockBreakContent);
});

test('L12: release resolves without waiting when the state directory was removed', async () => {
  const context = await createLockTestContext();
  const heldLock = await acquireOrFail(context.createLock());
  await rm(context.paths.stateDirectory, { recursive: true, force: true });

  await heldLock.release();

  assert.ok(context.messages.includes('login lock release failed (ENOENT)'));
  assert.equal(context.clock.pendingSleepCount(), 0);
});

type FixtureChildProcess = ChildProcessByStdio<null, Readable, Readable>;

interface FixtureProcess {
  child: FixtureChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitForOutputLine(line: string): Promise<void>;
}

function startFixtureProcess(fixtureFileName: string, fixtureArguments: string[]): FixtureProcess {
  const fixturePath = fileURLToPath(new URL(`../fixtures/${fixtureFileName}`, import.meta.url));
  const child = spawn(process.execPath, [fixturePath, ...fixtureArguments], { stdio: ['ignore', 'pipe', 'pipe'] });
  fixtureProcesses.push(child);

  let standardOutput = '';
  let standardError = '';
  const outputListeners = new Set<() => void>();
  child.stdout.setEncoding(TEXT_FILE_ENCODING);
  child.stderr.setEncoding(TEXT_FILE_ENCODING);
  child.stdout.on('data', (chunk: string) => {
    standardOutput += chunk;
    for (const listener of outputListeners) {
      listener();
    }
  });
  child.stderr.on('data', (chunk: string) => {
    standardError += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });

  const waitForOutputLine = (line: string) =>
    new Promise<void>((resolve, reject) => {
      const checkOutput = () => {
        if (standardOutput.split('\n').includes(line)) {
          outputListeners.delete(checkOutput);
          resolve();
        }
      };
      outputListeners.add(checkOutput);
      checkOutput();
      closed.then(() => reject(new Error(`fixture closed before printing ${line}: ${standardError}`)));
    });

  return { child, exited, waitForOutputLine };
}

async function waitWithDeadline<T>(promise: Promise<T>, deadlineMilliseconds: number, description: string): Promise<T> {
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error(`${description} did not happen in time`)), deadlineMilliseconds);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

test('L13: exit handler of a lock holder process removes the lock', { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const homeDirectory = await createTemporaryHome();
  const paths = resolveStatePaths(homeDirectory);
  const fixture = startFixtureProcess('lockHolderProcess.js', [homeDirectory, 'exit']);

  const { code } = await fixture.exited;
  assert.equal(code, 0);
  assert.equal(await pathExists(paths.loginLockPath), false);
  assert.equal(await pathExists(paths.loginLockBreakPath), false);
});

test('L14: lock of a killed holder process is stale and can be taken', { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const homeDirectory = await createTemporaryHome();
  const paths = resolveStatePaths(homeDirectory);
  const fixture = startFixtureProcess('lockHolderProcess.js', [homeDirectory, 'hang']);
  await fixture.waitForOutputLine('acquired');
  assert.equal(await pathExists(paths.loginLockPath), true);

  const childProcessId = fixture.child.pid;
  assert.ok(childProcessId !== undefined);
  fixture.child.kill('SIGKILL');
  const { signal } = await waitWithDeadline(fixture.exited, SIGNAL_EXIT_DEADLINE_MILLISECONDS, 'fixture exit');
  assert.equal(signal, 'SIGKILL');

  assert.equal(await pathExists(paths.loginLockPath), true);
  assert.equal(isProcessAlive(childProcessId), false);
  const messages: string[] = [];
  const lock = new LoginLock({
    paths,
    timings: DEFAULT_AUTHENTICATION_TIMINGS,
    logger: (message) => messages.push(message),
    clock: systemClock,
  });
  const staleState = await inspectStaleState(lock);
  assert.equal(staleState.reason, `holder process ${childProcessId} not running`);
  const heldLock = await lock.tryBreakStale(staleState);
  assert.ok(heldLock);
  await heldLock.release();
});

test('L15: exit handler survives a removed state directory on SIGTERM', { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const temporaryDirectory = await createTemporaryHome();
  const homeDirectory = join(temporaryDirectory, 'home');
  const markerPath = join(temporaryDirectory, 'marker');
  const paths = resolveStatePaths(homeDirectory);
  const fixture = startFixtureProcess('exitHandlerProcess.js', [homeDirectory, markerPath, 'remove-state-directory']);
  await fixture.waitForOutputLine('ready');

  await rm(paths.stateDirectory, { recursive: true, force: true });
  fixture.child.kill('SIGTERM');
  const { code, signal } = await waitWithDeadline(fixture.exited, SIGNAL_EXIT_DEADLINE_MILLISECONDS, 'fixture exit');

  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(await pathExists(markerPath), true);
});

test('L16: exit handler survives a removed lock file', { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const temporaryDirectory = await createTemporaryHome();
  const homeDirectory = join(temporaryDirectory, 'home');
  const markerPath = join(temporaryDirectory, 'marker');
  const paths = resolveStatePaths(homeDirectory);
  const fixture = startFixtureProcess('exitHandlerProcess.js', [homeDirectory, markerPath, 'remove-lock-file']);

  const { code } = await fixture.exited;
  assert.equal(code, 0);
  assert.equal(await pathExists(markerPath), true);
  assert.equal(await pathExists(paths.loginLockBreakPath), false);
});

test('L17: exit handler treats a lock break with its own process id as its own', { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const temporaryDirectory = await createTemporaryHome();
  const homeDirectory = join(temporaryDirectory, 'home');
  const markerPath = join(temporaryDirectory, 'marker');
  const paths = resolveStatePaths(homeDirectory);
  const fixture = startFixtureProcess('exitHandlerProcess.js', [homeDirectory, markerPath, 'own-break']);

  const { code } = await fixture.exited;
  assert.equal(code, 0);
  assert.equal(await pathExists(markerPath), true);
  assert.equal(await pathExists(paths.loginLockPath), false);
  assert.equal(await pathExists(paths.loginLockBreakPath), false);
});

test('L18: renew keeps the lock live beyond the stale age', async () => {
  const context = await createLockTestContext();
  const heldLock = await acquireOrFail(context.createLock());
  const originalContent = await readFile(context.paths.loginLockPath, TEXT_FILE_ENCODING);
  const originalNonce = heldLock.record.nonce;

  context.clock.advance(300_000);
  assert.equal(await heldLock.renew(), 'renewed');
  assert.equal(heldLock.record.createdAtMilliseconds, START_MILLISECONDS + 300_000);
  assert.equal(heldLock.record.nonce, originalNonce);
  assert.deepEqual(await readRecordFile(context.paths.loginLockPath), heldLock.record);

  context.clock.advance(300_000);
  assert.equal(await heldLock.renew(), 'renewed');
  assert.equal(heldLock.record.createdAtMilliseconds, START_MILLISECONDS + 600_000);
  assert.equal(heldLock.record.nonce, originalNonce);

  context.clock.advance(100_000);
  assert.deepEqual(await context.createLock().inspect(), { kind: 'live', record: heldLock.record });

  const unrenewedPaths = resolveStatePaths(await createTemporaryHome());
  await writeRawFile(unrenewedPaths.loginLockPath, originalContent);
  assert.deepEqual(await context.createLock({ paths: unrenewedPaths }).inspect(), {
    kind: 'stale',
    rawContent: originalContent,
    reason: 'age 700 s',
  });

  await heldLock.release();
  assert.equal(await pathExists(context.paths.loginLockPath), false);
});

test('L19: renew reports lost when a foreign record replaced the lock', async () => {
  const context = await createLockTestContext();
  const heldLock = await acquireOrFail(context.createLock());
  const foreignContent = createRecordContent(LIVE_FOREIGN_PROCESS_ID, context.clock.now());
  await writeFile(context.paths.loginLockPath, foreignContent);

  assert.equal(await heldLock.renew(), 'lost');
  assert.equal(await readFile(context.paths.loginLockPath, TEXT_FILE_ENCODING), foreignContent);
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);

  await heldLock.release();
  assert.equal(await readFile(context.paths.loginLockPath, TEXT_FILE_ENCODING), foreignContent);
});

test('L19: renew does not throw when the state directory was removed', async () => {
  const context = await createLockTestContext();
  const heldLock = await acquireOrFail(context.createLock());
  await rm(context.paths.stateDirectory, { recursive: true, force: true });

  assert.equal(await heldLock.renew(), 'lost');
  assert.ok(context.messages.includes('login lock renewal failed (ENOENT)'));
  assert.equal(await pathExists(context.paths.stateDirectory), false);

  await heldLock.release();
});

test(
  'L19: renew does not throw when the state directory is not writable',
  { skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false },
  async () => {
    const context = await createLockTestContext();
    const heldLock = await acquireOrFail(context.createLock());
    const originalContent = await readFile(context.paths.loginLockPath, TEXT_FILE_ENCODING);
    await chmod(context.paths.stateDirectory, 0o500);
    try {
      assert.equal(await heldLock.renew(), 'lost');
      assert.ok(context.messages.includes('login lock renewal failed (EACCES)'));
      const entries = await readdir(context.paths.stateDirectory);
      assert.deepEqual(entries.filter((entry) => entry.endsWith('.renew.tmp')), []);
      assert.equal(await readFile(context.paths.loginLockPath, TEXT_FILE_ENCODING), originalContent);
    } finally {
      await chmod(context.paths.stateDirectory, PRIVATE_DIRECTORY_MODE);
    }

    await heldLock.release();
  },
);

test('L20: renew waits for a fresh foreign lock break and renews once it is stale', async () => {
  const context = await createLockTestContext();
  const heldLock = await acquireOrFail(context.createLock());
  const originalNonce = heldLock.record.nonce;
  await writeRawFile(context.paths.loginLockBreakPath, createRecordContent(LIVE_FOREIGN_PROCESS_ID, context.clock.now()));

  let renewalSettled = false;
  const renewal = heldLock.renew().finally(() => {
    renewalSettled = true;
  });
  await context.clock.waitForPendingSleeps(1);
  assert.equal(renewalSettled, false);

  context.clock.advance(11_000);
  assert.equal(await renewal, 'renewed');
  assert.equal(heldLock.record.createdAtMilliseconds, START_MILLISECONDS + 11_000);
  assert.equal(heldLock.record.nonce, originalNonce);
  assert.deepEqual(await readRecordFile(context.paths.loginLockPath), heldLock.record);
  assert.ok(context.messages.includes('stale lock break file removed'));
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);

  await heldLock.release();
});

test('L20: renew reports busy after its timeout while the lock break stays busy', async () => {
  const context = await createLockTestContext();
  const lock = context.createLock({
    timings: { ...DEFAULT_AUTHENTICATION_TIMINGS, lockReleaseTimeoutMilliseconds: 5_000 },
  });
  const heldLock = await acquireOrFail(lock);
  const originalRecord = heldLock.record;
  const foreignLockBreakContent = createRecordContent(LIVE_FOREIGN_PROCESS_ID, context.clock.now());
  await writeRawFile(context.paths.loginLockBreakPath, foreignLockBreakContent);

  const renewal = heldLock.renew();
  await context.clock.waitForPendingSleeps(1);
  context.clock.advance(5_000);

  assert.equal(await renewal, 'busy');
  assert.ok(context.messages.includes('login lock renewal skipped, lock break busy'));
  assert.deepEqual(heldLock.record, originalRecord);
  assert.deepEqual(await readRecordFile(context.paths.loginLockPath), originalRecord);
  assert.equal(await readFile(context.paths.loginLockBreakPath, TEXT_FILE_ENCODING), foreignLockBreakContent);

  await unlink(context.paths.loginLockBreakPath);
  await heldLock.release();
});

test('L21: renewal before stale break verification keeps the renewed record', async () => {
  const context = await createLockTestContext();
  const heldLock = await acquireOrFail(context.createLock());
  context.clock.advance(361_000);
  const breakerLock = context.createLock();

  const staleState = await inspectStaleState(breakerLock);
  assert.equal(staleState.reason, 'age 361 s');
  assert.equal(await heldLock.renew(), 'renewed');

  assert.equal(await breakerLock.tryBreakStale(staleState), undefined);
  assert.deepEqual(await readRecordFile(context.paths.loginLockPath), heldLock.record);
  assert.equal(heldLock.record.createdAtMilliseconds, START_MILLISECONDS + 361_000);
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);

  await heldLock.release();
});

test('L21: renewal racing with a stale break loses to the breaker', async () => {
  const context = await createLockTestContext();
  const heldLock = await acquireOrFail(context.createLock());
  context.clock.advance(361_000);

  let renewal: Promise<LoginLockRenewalResult> | undefined;
  const breakerLock = context.createLock({
    raceHook: async (stage) => {
      if (stage === 'before-break-verification') {
        renewal = heldLock.renew();
        /* Снимающий продолжает только когда renew() уже стоит на паузе у занятой вспомогательной блокировки */
        await context.clock.waitForPendingSleeps(1);
      }
    },
  });

  const breakerHeldLock = await breakerLock.tryBreakStale(await inspectStaleState(breakerLock));
  assert.ok(breakerHeldLock);
  assert.ok(renewal);

  await context.clock.waitForPendingSleeps(1);
  context.clock.advance(1_000);
  assert.equal(await renewal, 'lost');
  assert.deepEqual(await readRecordFile(context.paths.loginLockPath), breakerHeldLock.record);
  assert.equal(await pathExists(context.paths.loginLockBreakPath), false);

  await heldLock.release();
  await breakerHeldLock.release();
});
