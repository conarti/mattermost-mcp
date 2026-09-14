import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildChromiumInstallCommand } from '../../src/authentication/browserLogin.js';
import { environmentWithout, removeDirectories, runProcess } from '../fixtures/runProcess.js';

const CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS = 60_000;

const temporaryDirectories: string[] = [];

after(() => removeDirectories(temporaryDirectories));

interface InstallationHostRun {
  browsersDirectory: string;
  temporaryRootDirectory: string;
  recordPath: string;
  result: Awaited<ReturnType<typeof runProcess>>;
}

async function runInstallationHost(mode: 'success' | 'failure'): Promise<InstallationHostRun> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-installer-host-'));
  temporaryDirectories.push(temporaryDirectory);
  const browsersDirectory = join(temporaryDirectory, 'browsers');
  const temporaryRootDirectory = join(temporaryDirectory, 'state-tmp');
  const recordPath = join(temporaryDirectory, 'fake-cli-record.json');
  const hostPath = fileURLToPath(new URL('../fixtures/installationHostProcess.js', import.meta.url));
  const fakeCliPath = fileURLToPath(new URL('../fixtures/fakePlaywrightCli.js', import.meta.url));

  const result = await runProcess(process.execPath, [hostPath, browsersDirectory, temporaryRootDirectory, fakeCliPath, mode], {
    ...environmentWithout('PLAYWRIGHT_BROWSERS_PATH'),
    FAKE_PLAYWRIGHT_CLI_RECORD_PATH: recordPath,
  });
  return { browsersDirectory, temporaryRootDirectory, recordPath, result };
}

test(
  'Y1: installer output never reaches the stdout of the server process',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const success = await runInstallationHost('success');
    assert.equal(success.result.standardOutput.length, 0);
    assert.ok(success.result.standardError.includes('[auth] Chromium download 40% of 182.1 MiB'), success.result.standardError);
    assert.ok(success.result.standardError.includes('[auth] FFmpeg download 0% of 1 MiB'), success.result.standardError);
    assert.equal(success.result.code, 0, success.result.standardError);

    const record = JSON.parse(readFileSync(success.recordPath, 'utf8')) as {
      commandArguments: string[];
      browsersPath: string;
      temporaryDirectoryVariable: string;
      operatingSystemTemporaryDirectory: string;
    };
    const installationDirectoryPrefix = join(success.temporaryRootDirectory, 'installation-');
    assert.deepEqual(record.commandArguments, ['install', 'chromium', '--no-shell']);
    assert.equal(record.browsersPath, success.browsersDirectory);
    assert.ok(record.temporaryDirectoryVariable.startsWith(installationDirectoryPrefix), record.temporaryDirectoryVariable);
    assert.ok(
      record.operatingSystemTemporaryDirectory.startsWith(installationDirectoryPrefix),
      record.operatingSystemTemporaryDirectory,
    );
    assert.deepEqual(
      (await readdir(success.temporaryRootDirectory)).filter((name) => name.startsWith('installation-')),
      [],
    );
    assert.equal(existsSync(join(record.operatingSystemTemporaryDirectory, 'playwright-download-fake', 'partial.zip')), false);

    const failure = await runInstallationHost('failure');
    assert.equal(failure.result.standardOutput.length, 0);
    assert.ok(failure.result.standardError.includes('[BROWSER_INSTALLATION_FAILED]'), failure.result.standardError);
    assert.ok(failure.result.standardError.includes('getaddrinfo ENOTFOUND cdn.playwright.dev'));
    assert.ok(failure.result.standardError.includes(buildChromiumInstallCommand(failure.browsersDirectory)));
    assert.equal(failure.result.code, 3);
  },
);
