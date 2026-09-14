import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  AUTHENTICATION_ERROR_CODES,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  TEMPORARY_FILE_EXTENSION,
} from '../../src/authentication/constants.js';
import { MattermostAuthenticationError } from '../../src/authentication/runtime.js';
import {
  StatePaths,
  createFileTokenStore,
  ensurePrivateDirectory,
  resolveStatePaths,
} from '../../src/authentication/stateFiles.js';
import { PERMISSION_BITS_MASK } from '../fixtures/fixtureConstants.js';

const SITE_URL = 'https://chat.example.test';
const OTHER_SITE_URL = 'https://other.example.test';
const WIDE_FILE_MODE = 0o644;
const WIDE_DIRECTORY_MODE = 0o755;
const SPECIAL_FILE_TEST_TIMEOUT_MILLISECONDS = 5_000;
const MAKE_FIFO_COMMAND = 'mkfifo';

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-state-files-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createLogSpy(): { logger: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { logger: (message) => messages.push(message), messages };
}

async function readPermissionBits(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & PERMISSION_BITS_MASK;
}

test('S1: resolveStatePaths builds seven paths inside the state directory', () => {
  const paths = resolveStatePaths('/tmp/home');
  assert.deepEqual(paths, {
    stateDirectory: '/tmp/home/.config/mattermost-mcp',
    profileDirectory: '/tmp/home/.config/mattermost-mcp/profile',
    browsersDirectory: '/tmp/home/.config/mattermost-mcp/browsers',
    tokenFilePath: '/tmp/home/.config/mattermost-mcp/token',
    loginLockPath: '/tmp/home/.config/mattermost-mcp/login.lock',
    loginLockBreakPath: '/tmp/home/.config/mattermost-mcp/login.lock.break',
    installationTemporaryDirectory: '/tmp/home/.config/mattermost-mcp/tmp',
  });
  assert.equal(Object.keys(paths).length, 7);
});

test('S2: token write sets private permissions and tightens existing ones', async () => {
  const freshPaths = resolveStatePaths(await createTemporaryHome());
  const freshStore = createFileTokenStore(freshPaths, createLogSpy().logger);
  await freshStore.writeToken(SITE_URL, 'secret-token-0001');
  assert.equal(await readPermissionBits(freshPaths.stateDirectory), PRIVATE_DIRECTORY_MODE);
  assert.equal(await readPermissionBits(freshPaths.tokenFilePath), PRIVATE_FILE_MODE);

  const existingPaths = resolveStatePaths(await createTemporaryHome());
  await mkdir(existingPaths.stateDirectory, { recursive: true });
  await chmod(existingPaths.stateDirectory, 0o755);
  await writeFile(existingPaths.tokenFilePath, 'old content');
  await chmod(existingPaths.tokenFilePath, 0o644);
  const existingStore = createFileTokenStore(existingPaths, createLogSpy().logger);
  await existingStore.writeToken(SITE_URL, 'secret-token-0002');
  assert.equal(await readPermissionBits(existingPaths.stateDirectory), PRIVATE_DIRECTORY_MODE);
  assert.equal(await readPermissionBits(existingPaths.tokenFilePath), PRIVATE_FILE_MODE);
  assert.equal(await existingStore.readToken(SITE_URL), 'secret-token-0002');
});

test('S3: symbolic link state directory is rejected and nothing is written', async () => {
  const homeDirectory = await createTemporaryHome();
  const paths = resolveStatePaths(homeDirectory);
  const linkTarget = join(homeDirectory, 'link-target');
  await mkdir(linkTarget);
  await mkdir(join(homeDirectory, '.config'));
  await symlink(linkTarget, paths.stateDirectory);

  const store = createFileTokenStore(paths, createLogSpy().logger);
  await assert.rejects(store.writeToken(SITE_URL, 'secret-token-0003'), (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, AUTHENTICATION_ERROR_CODES.STATE_DIRECTORY_UNSAFE);
    assert.ok(error.message.includes(paths.stateDirectory));
    assert.ok(!error.message.includes('secret-token-0003'));
    return true;
  });
  assert.deepEqual(await readdir(linkTarget), []);
});

test('S4: missing, malformed and foreign token files are ignored with logs on state change only', async () => {
  const paths = resolveStatePaths(await createTemporaryHome());
  const { logger, messages } = createLogSpy();
  const store = createFileTokenStore(paths, logger);

  assert.equal(await store.readToken(SITE_URL), undefined);
  assert.deepEqual([...messages], []);

  await mkdir(paths.stateDirectory, { recursive: true });
  await writeFile(paths.tokenFilePath, '{"siteUrl": "https://chat.example.test", "token": "secret-to', { mode: PRIVATE_FILE_MODE });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await store.readToken(SITE_URL), undefined);
  }
  assert.deepEqual([...messages], ['token file is malformed, ignoring']);

  await writeFile(paths.tokenFilePath, JSON.stringify({ siteUrl: SITE_URL, token: '' }));
  assert.equal(await store.readToken(SITE_URL), undefined);
  assert.deepEqual([...messages], ['token file is malformed, ignoring']);

  await writeFile(paths.tokenFilePath, JSON.stringify({ siteUrl: OTHER_SITE_URL, token: 'secret-token-0004' }));
  assert.equal(await store.readToken(SITE_URL), undefined);
  assert.deepEqual([...messages], ['token file is malformed, ignoring', 'token file belongs to another server, ignoring']);

  assert.equal(await store.readToken(`${OTHER_SITE_URL}/`), 'secret-token-0004');
  for (const message of messages) {
    assert.ok(!message.includes('secret-to'));
  }
});

test('S5: token write leaves no temporary files', async () => {
  const paths = resolveStatePaths(await createTemporaryHome());
  const store = createFileTokenStore(paths, createLogSpy().logger);
  await store.writeToken(SITE_URL, 'secret-token-0005');
  await store.writeToken(SITE_URL, 'secret-token-0006');
  const entries = await readdir(paths.stateDirectory);
  assert.deepEqual(entries.filter((entry) => entry.endsWith(TEMPORARY_FILE_EXTENSION)), []);
  assert.equal(await store.readToken(SITE_URL), 'secret-token-0006');
});

test('S6: parallel writes and reads never observe values outside the written set', async () => {
  const paths = resolveStatePaths(await createTemporaryHome());
  const store = createFileTokenStore(paths, createLogSpy().logger);
  const writtenTokens = Array.from({ length: 50 }, (_, index) => `secret-token-parallel-${index}`);

  const writes: Array<Promise<void>> = [];
  const reads: Array<Promise<string | undefined>> = [];
  for (const token of writtenTokens) {
    writes.push(store.writeToken(SITE_URL, token));
    reads.push(store.readToken(SITE_URL));
  }
  const [, readResults] = await Promise.all([Promise.all(writes), Promise.all(reads)]);

  const allowedValues = new Set<string | undefined>([undefined, ...writtenTokens]);
  for (const readResult of readResults) {
    assert.ok(allowedValues.has(readResult));
  }
  const finalToken = await store.readToken(SITE_URL);
  assert.ok(finalToken !== undefined && writtenTokens.includes(finalToken));
  const entries = await readdir(paths.stateDirectory);
  assert.deepEqual(entries.filter((entry) => entry.endsWith(TEMPORARY_FILE_EXTENSION)), []);
});

async function readTokenWithFreshStore(paths: StatePaths): Promise<{ token: string | undefined; messages: string[] }> {
  const { logger, messages } = createLogSpy();
  const token = await createFileTokenStore(paths, logger).readToken(SITE_URL);
  return { token, messages };
}

function assertUnsafeStateDirectoryError(error: unknown, directory: string, problem: string): true {
  assert.ok(error instanceof MattermostAuthenticationError);
  assert.equal(error.code, AUTHENTICATION_ERROR_CODES.STATE_DIRECTORY_UNSAFE);
  assert.ok(error.message.includes(`${directory} ${problem}`));
  return true;
}

test(
  'S7: symbolic link, special file and wide permissions token files are ignored without logging content',
  { timeout: SPECIAL_FILE_TEST_TIMEOUT_MILLISECONDS },
  async () => {
    const homeDirectory = await createTemporaryHome();
    const paths = resolveStatePaths(homeDirectory);
    await createFileTokenStore(paths, createLogSpy().logger).writeToken(SITE_URL, 'secret-token-0007');

    await chmod(paths.tokenFilePath, WIDE_FILE_MODE);
    const widePermissionsResult = await readTokenWithFreshStore(paths);
    assert.equal(widePermissionsResult.token, undefined);
    assert.deepEqual(widePermissionsResult.messages, ['token file permissions are wider than 0600, ignoring']);
    assert.equal(await readPermissionBits(paths.tokenFilePath), WIDE_FILE_MODE);

    await chmod(paths.tokenFilePath, PRIVATE_FILE_MODE);
    assert.equal((await readTokenWithFreshStore(paths)).token, 'secret-token-0007');

    const linkTarget = join(homeDirectory, 'link-target-token');
    await writeFile(linkTarget, JSON.stringify({ siteUrl: SITE_URL, token: 'secret-token-0008' }), { mode: PRIVATE_FILE_MODE });
    await unlink(paths.tokenFilePath);
    await symlink(linkTarget, paths.tokenFilePath);
    const symbolicLinkResult = await readTokenWithFreshStore(paths);
    assert.equal(symbolicLinkResult.token, undefined);
    assert.deepEqual(symbolicLinkResult.messages, ['token file is a symbolic link, ignoring']);

    await unlink(paths.tokenFilePath);
    await mkdir(paths.tokenFilePath);
    const directoryResult = await readTokenWithFreshStore(paths);
    assert.equal(directoryResult.token, undefined);
    assert.deepEqual(directoryResult.messages, ['token file is not a regular file, ignoring']);

    await rm(paths.tokenFilePath, { recursive: true });
    assert.equal(spawnSync(MAKE_FIFO_COMMAND, [paths.tokenFilePath]).status, 0);
    const fifoResult = await readTokenWithFreshStore(paths);
    assert.equal(fifoResult.token, undefined);
    assert.deepEqual(fifoResult.messages, ['token file is not a regular file, ignoring']);

    const allMessages = [
      ...widePermissionsResult.messages,
      ...symbolicLinkResult.messages,
      ...directoryResult.messages,
      ...fifoResult.messages,
    ];
    for (const message of allMessages) {
      assert.ok(!message.includes('secret-token'));
    }
  },
);

test('S8: private directory is created with tight permissions and a symbolic link or file is rejected', async () => {
  const paths = resolveStatePaths(await createTemporaryHome());
  await mkdir(paths.stateDirectory, { recursive: true });
  await ensurePrivateDirectory(paths.profileDirectory);
  assert.equal(await readPermissionBits(paths.profileDirectory), PRIVATE_DIRECTORY_MODE);
  await chmod(paths.profileDirectory, WIDE_DIRECTORY_MODE);
  await ensurePrivateDirectory(paths.profileDirectory);
  assert.equal(await readPermissionBits(paths.profileDirectory), PRIVATE_DIRECTORY_MODE);

  const linkedHomeDirectory = await createTemporaryHome();
  const linkedPaths = resolveStatePaths(linkedHomeDirectory);
  const linkTarget = join(linkedHomeDirectory, 'link-target-profile');
  await mkdir(linkTarget);
  await chmod(linkTarget, WIDE_DIRECTORY_MODE);
  await mkdir(linkedPaths.stateDirectory, { recursive: true });
  await symlink(linkTarget, linkedPaths.profileDirectory);
  await assert.rejects(ensurePrivateDirectory(linkedPaths.profileDirectory), (error: unknown) =>
    assertUnsafeStateDirectoryError(error, linkedPaths.profileDirectory, 'is a symbolic link'),
  );
  assert.equal(await readPermissionBits(linkTarget), WIDE_DIRECTORY_MODE);

  const filePaths = resolveStatePaths(await createTemporaryHome());
  await mkdir(filePaths.stateDirectory, { recursive: true });
  await writeFile(filePaths.profileDirectory, '', { mode: WIDE_FILE_MODE });
  await assert.rejects(ensurePrivateDirectory(filePaths.profileDirectory), (error: unknown) =>
    assertUnsafeStateDirectoryError(error, filePaths.profileDirectory, 'is not a directory'),
  );
  assert.equal(await readPermissionBits(filePaths.profileDirectory), WIDE_FILE_MODE);
});

test('S9: token write removes temporary token files of dead processes only', async () => {
  const paths = resolveStatePaths(await createTemporaryHome());
  await mkdir(paths.stateDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

  const deadProcessId = spawnSync(process.execPath, ['-e', '']).pid;
  assert.ok(deadProcessId !== undefined && deadProcessId > 0);
  const temporaryFileName = (owner: string | number) => `token.${owner}.${randomUUID()}${TEMPORARY_FILE_EXTENSION}`;
  const abandonedFileName = temporaryFileName(deadProcessId);
  const keptFileNames = [
    temporaryFileName(process.pid),
    temporaryFileName(process.ppid),
    temporaryFileName('not-a-process'),
    `login.lock.${deadProcessId}.${randomUUID()}${TEMPORARY_FILE_EXTENSION}`,
  ];
  for (const fileName of [abandonedFileName, ...keptFileNames]) {
    await writeFile(join(paths.stateDirectory, fileName), 'secret-token-abandoned', { mode: PRIVATE_FILE_MODE });
  }

  const store = createFileTokenStore(paths, createLogSpy().logger);
  await store.writeToken(SITE_URL, 'secret-token-0009');

  const entries = await readdir(paths.stateDirectory);
  assert.ok(!entries.includes(abandonedFileName));
  assert.deepEqual(entries.filter((entry) => entry.endsWith(TEMPORARY_FILE_EXTENSION)).sort(), [...keptFileNames].sort());
  assert.equal(await store.readToken(SITE_URL), 'secret-token-0009');
});
