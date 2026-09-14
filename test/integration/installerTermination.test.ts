import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBrowserInstaller } from '../../src/authentication/browserInstallation.js';
import {
  DEFAULT_AUTHENTICATION_TIMINGS,
  FILE_SYSTEM_ERROR_CODES,
  INSTALLATION_ABORT_REASONS,
  INSTALLATION_TEMPORARY_DIRECTORY_PREFIX,
  PROCESS_EXIT_EVENT,
  TEXT_FILE_ENCODING,
} from '../../src/authentication/constants.js';
import { MattermostAuthenticationError } from '../../src/authentication/runtime.js';
import {
  FIXTURE_FILE_NAMES,
  PLAYWRIGHT_CLI_FIXTURE_MODES,
  PLAYWRIGHT_CLI_FIXTURE_VARIABLES,
} from '../fixtures/fixtureConstants.js';
import { environmentWithout, removeDirectories } from '../fixtures/runProcess.js';

const CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS = 30_000;
const SHORT_INSTALLATION_TIMEOUT_MILLISECONDS = 1_000;
const SHORT_TERMINATION_GRACE_MILLISECONDS = 1_000;
const SIGNAL_ONLY_PROBE = 0;

const temporaryDirectories: string[] = [];

after(() => removeDirectories(temporaryDirectories));

interface HangingInstallation {
  temporaryRootDirectory: string;
  processIdPath: string;
  abortController: AbortController;
  /** Разрешается, когда фейковый CLI записал PID и строку прогресса */
  progressReceived: Promise<void>;
  installation: Promise<void>;
}

async function startHangingInstallation(installationTimeoutMilliseconds: number): Promise<HangingInstallation> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-installer-termination-'));
  temporaryDirectories.push(temporaryDirectory);
  const temporaryRootDirectory = join(temporaryDirectory, 'state-tmp');
  const processIdPath = join(temporaryDirectory, 'fake-cli.pid');
  const fakeCliPath = fileURLToPath(new URL(`../fixtures/${FIXTURE_FILE_NAMES.FAKE_PLAYWRIGHT_CLI}`, import.meta.url));
  const abortController = new AbortController();

  let resolveProgressReceived: () => void = () => undefined;
  const progressReceived = new Promise<void>((resolve) => {
    resolveProgressReceived = resolve;
  });

  const installBrowser = createBrowserInstaller({
    timings: {
      browserInstallationTimeoutMilliseconds: installationTimeoutMilliseconds,
      installationTerminationGraceMilliseconds: SHORT_TERMINATION_GRACE_MILLISECONDS,
    },
    logger: () => undefined,
    resolveCliPath: () => fakeCliPath,
    environment: {
      ...environmentWithout('PLAYWRIGHT_BROWSERS_PATH'),
      [PLAYWRIGHT_CLI_FIXTURE_VARIABLES.MODE]: PLAYWRIGHT_CLI_FIXTURE_MODES.HANG,
      [PLAYWRIGHT_CLI_FIXTURE_VARIABLES.PROCESS_ID_PATH]: processIdPath,
    },
  });
  const installation = installBrowser({
    browsersDirectory: join(temporaryDirectory, 'browsers'),
    temporaryRootDirectory,
    cancellationSignal: abortController.signal,
    onProgress: () => resolveProgressReceived(),
  });
  /* Отказ проверяется позже в assertInstallerStopped, а здесь не должен стать необработанным */
  installation.catch(() => undefined);
  return { temporaryRootDirectory, processIdPath, abortController, progressReceived, installation };
}

async function assertInstallerStopped(hanging: HangingInstallation, expectedDescription: string): Promise<void> {
  await assert.rejects(hanging.installation, (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.ok(error.message.includes(expectedDescription), error.message);
    return true;
  });
  /* Файл с PID фейковый CLI пишет первым делом, до строки прогресса */
  const processId = Number(readFileSync(hanging.processIdPath, TEXT_FILE_ENCODING));
  assert.ok(Number.isInteger(processId) && processId > 0, String(processId));
  assert.throws(() => process.kill(processId, SIGNAL_ONLY_PROBE), { code: FILE_SYSTEM_ERROR_CODES.NO_SUCH_PROCESS });
  assert.deepEqual(
    (await readdir(hanging.temporaryRootDirectory)).filter((name) => name.startsWith(INSTALLATION_TEMPORARY_DIRECTORY_PREFIX)),
    [],
  );
}

test(
  'Y2: a hanging installer child process is terminated after cancellation and after the deadline',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const exitListenerCountBefore = process.listenerCount(PROCESS_EXIT_EVENT);

    const cancelled = await startHangingInstallation(DEFAULT_AUTHENTICATION_TIMINGS.browserInstallationTimeoutMilliseconds);
    await cancelled.progressReceived;
    assert.equal(process.listenerCount(PROCESS_EXIT_EVENT), exitListenerCountBefore + 1);
    cancelled.abortController.abort(INSTALLATION_ABORT_REASONS.CANCELLED);
    await assertInstallerStopped(cancelled, 'Chromium installation cancelled, installer terminated');
    assert.equal(process.listenerCount(PROCESS_EXIT_EVENT), exitListenerCountBefore);

    const timedOut = await startHangingInstallation(SHORT_INSTALLATION_TIMEOUT_MILLISECONDS);
    await assertInstallerStopped(timedOut, 'Chromium installation timed out after 1 s, installer terminated');
    assert.equal(process.listenerCount(PROCESS_EXIT_EVENT), exitListenerCountBefore);
  },
);
