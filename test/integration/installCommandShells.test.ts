import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { buildChromiumInstallCommand } from '../../src/authentication/browserLogin.js';
import { removeDirectories, runProcess } from '../fixtures/runProcess.js';

const CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS = 60_000;
const INSTALL_COMMAND_TAIL = ' npx playwright@1.63.0 install chromium --no-shell';
const PRINT_BROWSERS_PATH_TAIL = ' node -e "process.stdout.write(process.env.PLAYWRIGHT_BROWSERS_PATH)"';
const README_COMMAND_PREFIX = 'PLAYWRIGHT_BROWSERS_PATH=~/.config/mattermost-mcp/browsers';

const temporaryDirectories: string[] = [];

after(() => removeDirectories(temporaryDirectories));

function isShellAvailable(shell: string): boolean {
  return spawnSync(shell, ['-c', 'true']).error === undefined;
}

async function createTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-install-command-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** HOME во временной папке: оболочки не читают файлы настроек пользователя, node берётся из папки текущего Node */
function shellEnvironment(homeDirectory: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: homeDirectory, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
}

async function printBrowsersPath(shell: string, command: string, homeDirectory: string): Promise<string> {
  const result = await runProcess(shell, ['-c', command], shellEnvironment(homeDirectory));
  assert.equal(result.code, 0, `${shell}: ${result.standardError}`);
  return result.standardOutput.toString('utf8');
}

const zshAvailable = isShellAvailable('zsh');

test(
  'Q1: the manual install command passes the quoted browsers directory in sh, bash and zsh',
  { timeout: CHILD_PROCESS_TEST_TIMEOUT_MILLISECONDS },
  async (context) => {
    const homeDirectory = await createTemporaryHome();
    const browsersDirectory = join(homeDirectory, 'dir with space', "it's", 'browsers');
    const installCommand = buildChromiumInstallCommand(browsersDirectory);
    assert.ok(installCommand.endsWith(INSTALL_COMMAND_TAIL), installCommand);
    const printCommand = `${installCommand.slice(0, -INSTALL_COMMAND_TAIL.length)}${PRINT_BROWSERS_PATH_TAIL}`;
    const readmeCommand = `${README_COMMAND_PREFIX}${PRINT_BROWSERS_PATH_TAIL}`;
    const readmeBrowsersDirectory = join(homeDirectory, '.config', 'mattermost-mcp', 'browsers');

    await context.test('/bin/sh', async () => {
      assert.equal(await printBrowsersPath('/bin/sh', printCommand, homeDirectory), browsersDirectory);
    });

    await context.test('bash', async () => {
      assert.equal(await printBrowsersPath('bash', printCommand, homeDirectory), browsersDirectory);
      assert.equal(await printBrowsersPath('bash', readmeCommand, homeDirectory), readmeBrowsersDirectory);
    });

    await context.test('zsh', { skip: zshAvailable ? false : 'zsh is not installed' }, async () => {
      assert.equal(await printBrowsersPath('zsh', printCommand, homeDirectory), browsersDirectory);
      assert.equal(await printBrowsersPath('zsh', readmeCommand, homeDirectory), readmeBrowsersDirectory);
    });
  },
);
