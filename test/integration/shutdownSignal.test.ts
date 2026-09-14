import assert from 'node:assert/strict';
import { ChildProcessByStdio, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLOSE_EVENT,
  DATA_EVENT,
  PLAYWRIGHT_BROWSERS_PATH_VARIABLE,
  PROCESS_EXIT_EVENT,
  TEXT_FILE_ENCODING,
} from '../../src/authentication/constants.js';
import { isProcessAlive } from '../../src/authentication/loginLock.js';
import { resolveStatePaths } from '../../src/authentication/stateFiles.js';
import {
  FIXTURE_FILE_NAMES,
  FIXTURE_HANGUP_SIGNAL,
  FIXTURE_INTERRUPT_SIGNAL,
  FIXTURE_KILL_SIGNAL,
  FIXTURE_OUTPUT_LINES,
  FIXTURE_TERMINATION_SIGNAL,
  OUTPUT_LINE_SEPARATOR,
  SIGNAL_DURING_LOGIN_FIXTURE_MODES,
} from '../fixtures/fixtureConstants.js';
import { environmentWithout, removeDirectories } from '../fixtures/runProcess.js';

const CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS = 30_000;
const SHUTDOWN_LIMIT_MILLISECONDS = 2_000;
const PROCESS_POLL_INTERVAL_MILLISECONDS = 20;
const PROCESS_STATUS_COMMAND = 'ps';
const PROCESS_COMMAND_LINE_ARGUMENTS = ['-ww', '-o', 'command=', '-p'] as const;

const temporaryDirectories: string[] = [];
const startedChildren: Array<ChildProcessByStdio<null, Readable, Readable>> = [];
const fakeCliProcessIdPaths: string[] = [];
const fakeCliPath = fileURLToPath(new URL(`../fixtures/${FIXTURE_FILE_NAMES.FAKE_PLAYWRIGHT_CLI}`, import.meta.url));

after(async () => {
  /* Упавший тест не должен оставлять свои процессы: сигнал только по PID своих детей и фейкового cli.js */
  for (const child of startedChildren) {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      process.kill(child.pid, FIXTURE_KILL_SIGNAL);
    }
  }
  for (const processIdPath of fakeCliProcessIdPaths) {
    const processId = readProcessId(processIdPath);
    /* PID из файла мог уже достаться чужому процессу, поэтому сигнал только процессу с путём фейкового cli.js в команде */
    if (processId !== undefined && readProcessCommandLine(processId)?.includes(fakeCliPath)) {
      process.kill(processId, FIXTURE_KILL_SIGNAL);
    }
  }
  await removeDirectories(temporaryDirectories);
});

function readProcessCommandLine(processId: number): string | undefined {
  try {
    return execFileSync(PROCESS_STATUS_COMMAND, [...PROCESS_COMMAND_LINE_ARGUMENTS, String(processId)], {
      encoding: TEXT_FILE_ENCODING,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  exitedAtMilliseconds: number;
}

interface StartedFixture {
  child: ChildProcessByStdio<null, Readable, Readable>;
  readonly standardError: string;
  waitForLine(expectedLine: string): Promise<void>;
  exited: Promise<ExitResult>;
}

function readProcessId(processIdPath: string): number | undefined {
  try {
    const processId = Number(readFileSync(processIdPath, TEXT_FILE_ENCODING));
    return Number.isInteger(processId) && processId > 0 ? processId : undefined;
  } catch {
    return undefined;
  }
}

async function createTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-shutdown-signal-'));
  temporaryDirectories.push(directory);
  return directory;
}

function startFixture(fixtureFileName: string, fixtureArguments: readonly string[]): StartedFixture {
  const fixturePath = fileURLToPath(new URL(`../fixtures/${fixtureFileName}`, import.meta.url));
  const child = spawn(process.execPath, [fixturePath, ...fixtureArguments], {
    env: environmentWithout(PLAYWRIGHT_BROWSERS_PATH_VARIABLE, 'MATTERMOST_TOKEN'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedChildren.push(child);

  let standardOutput = '';
  let standardError = '';
  const lineWaiters: Array<{ expectedLine: string; resolve: () => void }> = [];
  const hasLine = (expectedLine: string): boolean => standardOutput.split(OUTPUT_LINE_SEPARATOR).includes(expectedLine);

  child.stdout.setEncoding(TEXT_FILE_ENCODING);
  child.stderr.setEncoding(TEXT_FILE_ENCODING);
  child.stdout.on(DATA_EVENT, (chunk: string) => {
    standardOutput += chunk;
    for (let index = lineWaiters.length - 1; index >= 0; index -= 1) {
      if (hasLine(lineWaiters[index].expectedLine)) {
        lineWaiters[index].resolve();
        lineWaiters.splice(index, 1);
      }
    }
  });
  child.stderr.on(DATA_EVENT, (chunk: string) => {
    standardError += chunk;
  });

  const exited = new Promise<ExitResult>((resolve) => {
    child.once(PROCESS_EXIT_EVENT, (code, signal) => resolve({ code, signal, exitedAtMilliseconds: Date.now() }));
  });
  const closed = new Promise<void>((resolve) => child.once(CLOSE_EVENT, () => resolve()));

  return {
    child,
    get standardError() {
      return standardError;
    },
    waitForLine: (expectedLine) =>
      new Promise<void>((resolve, reject) => {
        if (hasLine(expectedLine)) {
          resolve();
          return;
        }
        lineWaiters.push({ expectedLine, resolve });
        void closed.then(() =>
          reject(new Error(`fixture exited before printing ${expectedLine}\nstderr:\n${standardError}`)),
        );
      }),
    exited,
  };
}

async function sendSignalAndWaitForExit(fixture: StartedFixture, signal: NodeJS.Signals): Promise<ExitResult> {
  const { pid } = fixture.child;
  assert.ok(pid !== undefined);
  const signalSentAtMilliseconds = Date.now();
  process.kill(pid, signal);
  const result = await fixture.exited;
  const elapsedMilliseconds = result.exitedAtMilliseconds - signalSentAtMilliseconds;
  assert.equal(result.signal, null, fixture.standardError);
  assert.equal(result.code, 0, fixture.standardError);
  assert.ok(elapsedMilliseconds <= SHUTDOWN_LIMIT_MILLISECONDS, `exit took ${elapsedMilliseconds} ms`);
  return result;
}

async function waitUntilProcessStops(processId: number, sinceMilliseconds: number): Promise<void> {
  while (isProcessAlive(processId)) {
    const elapsedMilliseconds = Date.now() - sinceMilliseconds;
    assert.ok(elapsedMilliseconds <= SHUTDOWN_LIMIT_MILLISECONDS, `process ${processId} is alive after ${elapsedMilliseconds} ms`);
    await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_INTERVAL_MILLISECONDS));
  }
}

async function assertSignalDuringLoginExitsCleanly(signal: NodeJS.Signals, mode: string): Promise<void> {
  const homeDirectory = await createTemporaryHome();
  const { loginLockPath } = resolveStatePaths(homeDirectory);
  const fixture = startFixture(FIXTURE_FILE_NAMES.SIGNAL_DURING_LOGIN, [homeDirectory, mode]);

  await fixture.waitForLine(FIXTURE_OUTPUT_LINES.WAITING);
  assert.equal(existsSync(loginLockPath), true);
  await sendSignalAndWaitForExit(fixture, signal);
  assert.equal(existsSync(loginLockPath), false);
}

async function assertSignalDuringInstallationStopsInstaller(signal: NodeJS.Signals): Promise<void> {
  const homeDirectory = await createTemporaryHome();
  const { loginLockPath } = resolveStatePaths(homeDirectory);
  const fakeCliProcessIdPath = join(homeDirectory, 'fake-cli.pid');
  fakeCliProcessIdPaths.push(fakeCliProcessIdPath);
  const fixture = startFixture(FIXTURE_FILE_NAMES.SIGNAL_DURING_INSTALLATION, [homeDirectory, fakeCliProcessIdPath]);

  await fixture.waitForLine(FIXTURE_OUTPUT_LINES.INSTALLING);
  const fakeCliProcessId = readProcessId(fakeCliProcessIdPath);
  assert.ok(fakeCliProcessId !== undefined);
  assert.equal(isProcessAlive(fakeCliProcessId), true);
  assert.equal(existsSync(loginLockPath), true);

  const result = await sendSignalAndWaitForExit(fixture, signal);
  await waitUntilProcessStops(fakeCliProcessId, result.exitedAtMilliseconds);
  assert.equal(existsSync(loginLockPath), false);
}

test(
  'G1: SIGTERM while the sign-in window is open exits with code 0 and removes login.lock',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    await assertSignalDuringLoginExitsCleanly(FIXTURE_TERMINATION_SIGNAL, SIGNAL_DURING_LOGIN_FIXTURE_MODES.NORMAL);
  },
);

test(
  'G2: SIGHUP while the sign-in window is open exits with code 0 and removes login.lock',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    await assertSignalDuringLoginExitsCleanly(FIXTURE_HANGUP_SIGNAL, SIGNAL_DURING_LOGIN_FIXTURE_MODES.NORMAL);
  },
);

test(
  'G3: a throwing shutdown callback still exits with code 0 on SIGTERM',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    await assertSignalDuringLoginExitsCleanly(FIXTURE_TERMINATION_SIGNAL, SIGNAL_DURING_LOGIN_FIXTURE_MODES.THROWING_SHUTDOWN);
  },
);

test(
  'G4: SIGTERM and SIGINT during Chromium installation stop the installer child process and remove login.lock',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    await assertSignalDuringInstallationStopsInstaller(FIXTURE_TERMINATION_SIGNAL);
    await assertSignalDuringInstallationStopsInstaller(FIXTURE_INTERRUPT_SIGNAL);
  },
);
