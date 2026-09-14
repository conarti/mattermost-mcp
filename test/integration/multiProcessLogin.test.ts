import assert from 'node:assert/strict';
import { ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveSiteUrl } from '../../src/authentication/browserLogin.js';
import {
  AUTHENTICATION_ERROR_CODES,
  AUTHENTICATION_LOG_PREFIX,
  AuthenticationTimings,
  CLOSE_EVENT,
  DATA_EVENT,
  PLAYWRIGHT_BROWSERS_PATH_VARIABLE,
  PRIVATE_FILE_MODE,
  PROCESS_EXIT_EVENT,
  TEXT_FILE_ENCODING,
} from '../../src/authentication/constants.js';
import { LoginLockRecord, isProcessAlive } from '../../src/authentication/loginLock.js';
import { createFileTokenStore, ensureStateDirectory, resolveStatePaths } from '../../src/authentication/stateFiles.js';
import { assertNoSecrets } from '../fixtures/captureLogs.js';
import {
  FIXTURE_FILE_NAMES,
  FIXTURE_KILL_SIGNAL,
  FIXTURE_MATTERMOST_URL,
  FIXTURE_OUTPUT_LINES,
  LOG_ENTRY_FIELD_SEPARATOR,
  LOGIN_WORKER_FILE_NAMES,
  LOGIN_WORKER_LOG_ENTRY_KINDS,
  LOGIN_WORKER_RESULTS,
  LOGIN_WORKER_SCENARIOS,
  LOGIN_WORKER_TOKENS,
  OUTPUT_LINE_SEPARATOR,
  PERMISSION_BITS_MASK,
} from '../fixtures/fixtureConstants.js';
import { environmentWithout, removeDirectories } from '../fixtures/runProcess.js';

const CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS = 30_000;
const SUCCESS_REPEAT_COUNT = 5;
const STALE_LOCK_REPEAT_COUNT = 5;
const INSTALLATION_REPEAT_COUNT = 2;
const TWO_WORKERS = 2;
const THREE_WORKERS = 3;
const JSON_LINE_START = '{';

/* Порог брошенности 8000 мс больше границы удержания 5000 + 200 + 500 + 500 = 6200 мс */
const LOGIN_WORKER_TIMINGS: Partial<AuthenticationTimings> = {
  loginTimeoutMilliseconds: 5_000,
  progressIntervalMilliseconds: 200,
  lockStaleAgeMilliseconds: 8_000,
  lockBreakStaleAgeMilliseconds: 1_000,
  lockPollIntervalMilliseconds: 50,
  lockReleaseTimeoutMilliseconds: 1_500,
  cookiePollIntervalMilliseconds: 50,
  cookieReadTimeoutMilliseconds: 200,
  tokenValidationTimeoutMilliseconds: 500,
  loginPageNavigationTimeoutMilliseconds: 500,
  browserLaunchTimeoutMilliseconds: 1_000,
  browserCloseTimeoutMilliseconds: 500,
};

/*
 * Граница удержания после обновления 1500 + 100 + 200 + 200 = 2000 мс меньше порога 3000 мс,
 * а установка 4000 мс длиннее и порога, и срока ожидания 1500 мс
 */
const INSTALLATION_WORKER_TIMINGS: Partial<AuthenticationTimings> = {
  ...LOGIN_WORKER_TIMINGS,
  lockStaleAgeMilliseconds: 3_000,
  lockRenewIntervalMilliseconds: 300,
  loginTimeoutMilliseconds: 1_500,
  cookieReadTimeoutMilliseconds: 100,
  tokenValidationTimeoutMilliseconds: 200,
  browserCloseTimeoutMilliseconds: 200,
};

const temporaryDirectories: string[] = [];
const startedChildren: Array<ChildProcessByStdio<null, Readable, Readable>> = [];

after(async () => {
  /* Упавший тест не должен оставлять свои процессы: сигнал только по PID своих детей */
  for (const child of startedChildren) {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      process.kill(child.pid, FIXTURE_KILL_SIGNAL);
    }
  }
  await removeDirectories(temporaryDirectories);
});

type LoginWorkerResult =
  | { result: typeof LOGIN_WORKER_RESULTS.OK }
  | { result: typeof LOGIN_WORKER_RESULTS.ERROR; code: string };

interface FinishedWorker {
  processId: number;
  result: LoginWorkerResult;
  standardOutput: string;
  standardError: string;
}

interface StartedWorker {
  processId: number;
  ready: Promise<void>;
  finished: Promise<FinishedWorker>;
}

interface WorkerRun {
  homeDirectory: string;
  workers: FinishedWorker[];
  windowProcessIds: number[];
  installationProcessIds: number[];
}

interface WorkerRunOptions {
  scenario: string;
  workerCount: number;
  timings: Partial<AuthenticationTimings>;
  prepareHomeDirectory?: (homeDirectory: string) => Promise<void>;
}

function parseResultLine(standardOutput: string, standardError: string): LoginWorkerResult {
  const resultLine = standardOutput
    .split(OUTPUT_LINE_SEPARATOR)
    .filter((line) => line.startsWith(JSON_LINE_START))
    .at(-1);
  assert.ok(resultLine !== undefined, `login worker printed no result\nstdout:\n${standardOutput}\nstderr:\n${standardError}`);
  return JSON.parse(resultLine) as LoginWorkerResult;
}

function startWorker(fixtureArguments: readonly string[]): StartedWorker {
  const fixturePath = fileURLToPath(new URL(`../fixtures/${FIXTURE_FILE_NAMES.LOGIN_WORKER}`, import.meta.url));
  const child = spawn(process.execPath, [fixturePath, ...fixtureArguments], {
    env: environmentWithout(PLAYWRIGHT_BROWSERS_PATH_VARIABLE, 'MATTERMOST_TOKEN'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedChildren.push(child);
  const processId = child.pid;
  assert.ok(processId !== undefined);

  let standardOutput = '';
  let standardError = '';
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  child.stdout.setEncoding(TEXT_FILE_ENCODING);
  child.stderr.setEncoding(TEXT_FILE_ENCODING);
  child.stdout.on(DATA_EVENT, (chunk: string) => {
    standardOutput += chunk;
    if (standardOutput.split(OUTPUT_LINE_SEPARATOR).includes(FIXTURE_OUTPUT_LINES.READY)) {
      resolveReady();
    }
  });
  child.stderr.on(DATA_EVENT, (chunk: string) => {
    standardError += chunk;
  });

  const finished = new Promise<FinishedWorker>((resolve, reject) => {
    child.once(CLOSE_EVENT, (code, signal) => {
      if (code !== 0) {
        reject(new Error(`login worker ${processId} exited with ${code ?? signal}\nstderr:\n${standardError}`));
        return;
      }
      resolve({ processId, result: parseResultLine(standardOutput, standardError), standardOutput, standardError });
    });
  });
  /* Воркер, упавший до ready, не должен подвешивать ожидание барьера */
  const readyOrFailure = Promise.race([
    ready,
    finished.then(() => {
      throw new Error(`login worker ${processId} exited before printing ${FIXTURE_OUTPUT_LINES.READY}\nstderr:\n${standardError}`);
    }),
  ]);
  return { processId, ready: readyOrFailure, finished };
}

function readLogProcessIds(logPath: string, expectedKind: string): number[] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, TEXT_FILE_ENCODING)
    .split(OUTPUT_LINE_SEPARATOR)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [kind, processIdText] = line.split(LOG_ENTRY_FIELD_SEPARATOR);
      assert.equal(kind, expectedKind);
      return Number(processIdText);
    });
}

async function runWorkers(options: WorkerRunOptions): Promise<WorkerRun> {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-multi-process-login-'));
  temporaryDirectories.push(homeDirectory);
  const windowLogPath = join(homeDirectory, LOGIN_WORKER_FILE_NAMES.WINDOW_LOG);
  const installationLogPath = join(homeDirectory, LOGIN_WORKER_FILE_NAMES.INSTALLATION_LOG);
  const barrierFilePath = join(homeDirectory, LOGIN_WORKER_FILE_NAMES.BARRIER);
  await options.prepareHomeDirectory?.(homeDirectory);

  const timingsJson = JSON.stringify(options.timings);
  const startedWorkers = Array.from({ length: options.workerCount }, () =>
    startWorker([homeDirectory, windowLogPath, options.scenario, barrierFilePath, timingsJson]),
  );
  await Promise.all(startedWorkers.map((worker) => worker.ready));
  await writeFile(barrierFilePath, '');
  const workers = await Promise.all(startedWorkers.map((worker) => worker.finished));

  return {
    homeDirectory,
    workers,
    windowProcessIds: readLogProcessIds(windowLogPath, LOGIN_WORKER_LOG_ENTRY_KINDS.WINDOW),
    installationProcessIds: readLogProcessIds(installationLogPath, LOGIN_WORKER_LOG_ENTRY_KINDS.INSTALL),
  };
}

function describeRun(run: WorkerRun): string {
  return run.workers
    .map((worker) => `worker ${worker.processId}\nstdout:\n${worker.standardOutput}\nstderr:\n${worker.standardError}`)
    .join('\n');
}

function findWorker(run: WorkerRun, processId: number): FinishedWorker {
  const worker = run.workers.find((candidate) => candidate.processId === processId);
  assert.ok(worker !== undefined, `no worker with process ${processId}\n${describeRun(run)}`);
  return worker;
}

function countWorkersWithOutput(run: WorkerRun, fragment: string): number {
  return run.workers.filter((worker) => worker.standardError.includes(fragment)).length;
}

async function writeExpiredToken(homeDirectory: string): Promise<void> {
  const tokenStore = createFileTokenStore(resolveStatePaths(homeDirectory), () => undefined);
  await tokenStore.writeToken(deriveSiteUrl(FIXTURE_MATTERMOST_URL), LOGIN_WORKER_TOKENS.EXPIRED);
}

async function obtainExitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const processId = child.pid;
  assert.ok(processId !== undefined);
  await new Promise<void>((resolve) => child.once(PROCESS_EXIT_EVENT, () => resolve()));
  return processId;
}

function assertAllResultsOk(run: WorkerRun): void {
  for (const worker of run.workers) {
    assert.deepEqual(worker.result, { result: LOGIN_WORKER_RESULTS.OK }, describeRun(run));
  }
}

function assertLockFilesRemoved(homeDirectory: string): void {
  const { loginLockPath, loginLockBreakPath } = resolveStatePaths(homeDirectory);
  assert.equal(existsSync(loginLockPath), false);
  assert.equal(existsSync(loginLockBreakPath), false);
}

function assertFreshTokenSaved(homeDirectory: string): void {
  const { tokenFilePath } = resolveStatePaths(homeDirectory);
  const storedContent = JSON.parse(readFileSync(tokenFilePath, TEXT_FILE_ENCODING)) as { token: unknown };
  assert.equal(storedContent.token === LOGIN_WORKER_TOKENS.FRESH, true, 'token file does not contain the fresh token');
  assert.equal(statSync(tokenFilePath).mode & PERMISSION_BITS_MASK, PRIVATE_FILE_MODE);
}

test(
  'X1: two processes with an expired token open exactly one sign-in window and both calls succeed',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    for (let repeat = 0; repeat < SUCCESS_REPEAT_COUNT; repeat += 1) {
      const run = await runWorkers({
        scenario: LOGIN_WORKER_SCENARIOS.SUCCESS,
        workerCount: TWO_WORKERS,
        timings: LOGIN_WORKER_TIMINGS,
        prepareHomeDirectory: writeExpiredToken,
      });

      assert.equal(run.windowProcessIds.length, 1, describeRun(run));
      assert.equal(run.installationProcessIds.length, 0);
      assertAllResultsOk(run);
      assertFreshTokenSaved(run.homeDirectory);
      assertLockFilesRemoved(run.homeDirectory);
      assert.equal(countWorkersWithOutput(run, `${AUTHENTICATION_LOG_PREFIX} login lock busy`), 1, describeRun(run));
    }
  },
);

test(
  'X2: when the holder window is closed the holder gets LOGIN_WINDOW_CLOSED and the waiter gets LOGIN_NOT_COMPLETED',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const run = await runWorkers({
      scenario: LOGIN_WORKER_SCENARIOS.CLOSE_WINDOW,
      workerCount: TWO_WORKERS,
      timings: LOGIN_WORKER_TIMINGS,
    });

    assert.equal(run.windowProcessIds.length, 1, describeRun(run));
    assert.equal(run.installationProcessIds.length, 0);
    const [holderProcessId] = run.windowProcessIds;
    const holder = findWorker(run, holderProcessId);
    const waiter = run.workers.find((worker) => worker.processId !== holderProcessId);
    assert.ok(waiter !== undefined);
    assert.deepEqual(
      holder.result,
      { result: LOGIN_WORKER_RESULTS.ERROR, code: AUTHENTICATION_ERROR_CODES.LOGIN_WINDOW_CLOSED },
      describeRun(run),
    );
    assert.deepEqual(
      waiter.result,
      { result: LOGIN_WORKER_RESULTS.ERROR, code: AUTHENTICATION_ERROR_CODES.LOGIN_NOT_COMPLETED },
      describeRun(run),
    );
    assertLockFilesRemoved(run.homeDirectory);
  },
);

test(
  'X3: three processes and a stale login.lock of an exited process open one window without errors',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    for (let repeat = 0; repeat < STALE_LOCK_REPEAT_COUNT; repeat += 1) {
      const exitedProcessId = await obtainExitedProcessId();
      assert.equal(isProcessAlive(exitedProcessId), false);
      const run = await runWorkers({
        scenario: LOGIN_WORKER_SCENARIOS.SUCCESS,
        workerCount: THREE_WORKERS,
        timings: LOGIN_WORKER_TIMINGS,
        prepareHomeDirectory: async (homeDirectory) => {
          const paths = resolveStatePaths(homeDirectory);
          await ensureStateDirectory(paths);
          const staleRecord: LoginLockRecord = {
            processId: exitedProcessId,
            createdAtMilliseconds: Date.now(),
            nonce: randomUUID(),
          };
          await writeFile(paths.loginLockPath, JSON.stringify(staleRecord), { mode: PRIVATE_FILE_MODE });
        },
      });

      assert.equal(run.windowProcessIds.length, 1, describeRun(run));
      assert.equal(run.installationProcessIds.length, 0);
      assertAllResultsOk(run);
      assert.equal(
        countWorkersWithOutput(
          run,
          `${AUTHENTICATION_LOG_PREFIX} stale login lock removed (holder process ${exitedProcessId} not running)`,
        ),
        1,
        describeRun(run),
      );
      assertLockFilesRemoved(run.homeDirectory);
    }
  },
);

test(
  'X4: the output of all login worker processes contains no token values',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const run = await runWorkers({
      scenario: LOGIN_WORKER_SCENARIOS.SUCCESS,
      workerCount: TWO_WORKERS,
      timings: LOGIN_WORKER_TIMINGS,
      prepareHomeDirectory: writeExpiredToken,
    });

    assertAllResultsOk(run);
    const printedLines = run.workers.flatMap((worker) =>
      `${worker.standardOutput}${OUTPUT_LINE_SEPARATOR}${worker.standardError}`.split(OUTPUT_LINE_SEPARATOR),
    );
    assert.ok(printedLines.some((line) => line.startsWith(`${AUTHENTICATION_LOG_PREFIX} session token saved`)));
    assert.ok(printedLines.some((line) => line.startsWith(`${AUTHENTICATION_LOG_PREFIX} 401 received`)));
    assertNoSecrets(printedLines, [LOGIN_WORKER_TOKENS.EXPIRED, LOGIN_WORKER_TOKENS.FRESH]);
  },
);

test(
  'X5: Chromium installation longer than the stale age and the wait timeout runs once and both calls succeed',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    for (let repeat = 0; repeat < INSTALLATION_REPEAT_COUNT; repeat += 1) {
      const run = await runWorkers({
        scenario: LOGIN_WORKER_SCENARIOS.INSTALL_THEN_SUCCESS,
        workerCount: TWO_WORKERS,
        timings: INSTALLATION_WORKER_TIMINGS,
      });

      assert.equal(run.installationProcessIds.length, 1, describeRun(run));
      assert.equal(run.windowProcessIds.length, 1, describeRun(run));
      const [holderProcessId] = run.installationProcessIds;
      assert.equal(run.windowProcessIds[0], holderProcessId);
      assertAllResultsOk(run);

      const waiter = run.workers.find((worker) => worker.processId !== holderProcessId);
      assert.ok(waiter !== undefined);
      assert.equal(waiter.standardError.includes(AUTHENTICATION_ERROR_CODES.LOGIN_TIMEOUT), false, describeRun(run));
      assert.equal(waiter.standardError.includes('stale login lock removed'), false, describeRun(run));
      assert.ok(
        waiter.standardError.includes(
          `${AUTHENTICATION_LOG_PREFIX} login lock renewed by holder process ${holderProcessId}, extending wait`,
        ),
        describeRun(run),
      );
      assertFreshTokenSaved(run.homeDirectory);
      assertLockFilesRemoved(run.homeDirectory);
    }
  },
);
