import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildInstallationEnvironment, resolvePlaywrightCliPath } from '../../src/authentication/browserInstallation.js';
import { CHROMIUM_INSTALL_ARGUMENTS } from '../../src/authentication/constants.js';
import { environmentWithout, removeDirectories, runProcess } from '../fixtures/runProcess.js';

const CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS = 60_000;

const temporaryDirectories: string[] = [];

after(() => removeDirectories(temporaryDirectories));

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-browsers-path-'));
  temporaryDirectories.push(directory);
  return directory;
}

function readChromiumRevision(): string {
  const browsersManifestPath = join(dirname(resolvePlaywrightCliPath()), 'browsers.json');
  const manifest = JSON.parse(readFileSync(browsersManifestPath, 'utf8')) as { browsers: Array<{ name: string; revision: string }> };
  const chromium = manifest.browsers.find((browser) => browser.name === 'chromium');
  assert.ok(chromium, 'chromium entry is missing in browsers.json');
  return chromium.revision;
}

test(
  'W1: the real Playwright import resolves Chromium inside the configured browsers directory',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const temporaryDirectory = await createTemporaryDirectory();
    const browsersDirectory = join(temporaryDirectory, 'browsers');
    const fixturePath = fileURLToPath(new URL('../fixtures/printChromiumExecutablePathProcess.js', import.meta.url));

    const result = await runProcess(
      process.execPath,
      [fixturePath, browsersDirectory],
      environmentWithout('PLAYWRIGHT_BROWSERS_PATH'),
    );

    assert.equal(result.code, 0, result.standardError);
    assert.ok(
      result.standardOutput.toString('utf8').startsWith(join(browsersDirectory, `chromium-${readChromiumRevision()}`) + sep),
      result.standardOutput.toString('utf8'),
    );
    assert.equal(existsSync(browsersDirectory), false);
  },
);

test(
  'W2: the resolved Playwright CLI reports the install location in the browsers directory without downloading',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const cliPath = resolvePlaywrightCliPath();
    assert.equal(existsSync(cliPath), true);

    const temporaryDirectory = await createTemporaryDirectory();
    const browsersDirectory = join(temporaryDirectory, 'browsers');
    const installerTemporaryDirectory = join(temporaryDirectory, 'installer-tmp');
    const result = await runProcess(
      process.execPath,
      [cliPath, ...CHROMIUM_INSTALL_ARGUMENTS, '--dry-run'],
      buildInstallationEnvironment(
        browsersDirectory,
        installerTemporaryDirectory,
        environmentWithout('PLAYWRIGHT_BROWSERS_PATH'),
      ),
    );
    const standardOutput = result.standardOutput.toString('utf8');

    assert.equal(result.code, 0, result.standardError);
    assert.ok(
      standardOutput.includes(`Install location:    ${join(browsersDirectory, `chromium-${readChromiumRevision()}`)}`),
      standardOutput,
    );
    assert.ok(standardOutput.includes(`${join(browsersDirectory, 'ffmpeg-')}`), standardOutput);
    assert.equal(standardOutput.includes('chromium_headless_shell'), false);
    assert.equal(existsSync(browsersDirectory), false);
    assert.equal(existsSync(installerTemporaryDirectory), false);
  },
);
