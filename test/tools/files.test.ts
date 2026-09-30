import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { StaticTokenProvider } from '../../src/authentication/session.js';
import { MattermostClient } from '../../src/client.js';
import type { Config } from '../../src/config.js';
import {
  DOWNLOAD_DIRECTORY_NAME,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_SKIPPED_SIZE_REASON,
  INVALID_FILE_ID_MESSAGE,
  PARTIAL_FILE_SUFFIX,
  createFileForbiddenMessage,
  createFileNotFoundMessage,
  createInlineSkippedTypeReason,
  decideInlineImage,
  expandHomeDirectory,
  handleDownloadFile,
  handleGetFileInfo,
  resolveDownloadTarget,
  sanitizeFileName,
} from '../../src/tools/files.js';
import type { FileInfo } from '../../src/types.js';
import { FakeHttp, FakeHttpReply } from '../fixtures/fakeHttp.js';
import { removeDirectories } from '../fixtures/runProcess.js';

const MATTERMOST_URL = 'https://chat.example.test/api/v4';
const CONFIG: Config = { mattermostUrl: MATTERMOST_URL, token: 'static-secret-token-0001', teamId: 'team-test' };
const FILE_ID = 'abcdefghijklmnopqrstuvwxyz';
const SERVER_FILE_ID = '0123456789abcdefghijklmnop';
const FILE_INFO_URL = `${MATTERMOST_URL}/files/${FILE_ID}/info`;
const FILE_URL = `${MATTERMOST_URL}/files/${FILE_ID}`;
const FILE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0xff]);
const PNG_FILE_INFO: FileInfo = {
  id: FILE_ID,
  name: 'screenshot.png',
  extension: 'png',
  size: FILE_BYTES.byteLength,
  mime_type: 'image/png',
  width: 800,
  height: 600,
  post_id: 'post00000000000000000000aa',
};
const PDF_FILE_INFO: FileInfo = { id: FILE_ID, name: 'report.pdf', extension: 'pdf', size: FILE_BYTES.byteLength, mime_type: 'application/pdf' };
const SVG_FILE_INFO: FileInfo = { id: FILE_ID, name: 'logo.svg', extension: 'svg', size: FILE_BYTES.byteLength, mime_type: 'image/svg+xml' };

const temporaryDirectories: string[] = [];

after(() => removeDirectories(temporaryDirectories));

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-files-'));
  temporaryDirectories.push(directory);
  return directory;
}

interface DownloadEnvironment {
  temporaryDirectory: string;
  homeDirectory: string;
  cwd: string;
}

async function createDownloadEnvironment(): Promise<DownloadEnvironment> {
  const rootDirectory = await createTemporaryDirectory();
  const environment = {
    temporaryDirectory: join(rootDirectory, 'temporary'),
    homeDirectory: join(rootDirectory, 'home'),
    cwd: join(rootDirectory, 'working'),
  };
  await Promise.all(Object.values(environment).map((directory) => mkdir(directory)));
  return environment;
}

function createFileHttp(fileInfo: FileInfo, createDownloadReply: () => FakeHttpReply = () => ({ status: 200, body: FILE_BYTES })): FakeHttp {
  return new FakeHttp((_token, record) => (record.url === FILE_INFO_URL ? { status: 200, body: fileInfo } : createDownloadReply()));
}

function createClient(http: FakeHttp): MattermostClient {
  return new MattermostClient({ config: CONFIG, tokenProvider: new StaticTokenProvider(CONFIG.token), fetchImplementation: http.fetch });
}

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function parseTextContent(result: ToolResult): any {
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text ?? '');
}

async function listPartialFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(PARTIAL_FILE_SUFFIX));
}

test('D1: file names from the server are reduced to a basename', () => {
  assert.equal(sanitizeFileName('../../etc/passwd', FILE_ID), 'passwd');
  assert.equal(sanitizeFileName('..\\x.png', FILE_ID), 'x.png');
  assert.equal(sanitizeFileName('report.pdf', FILE_ID), 'report.pdf');
  for (const unsafeName of ['', '.', '..', 'folder/', 'a/..']) {
    assert.equal(sanitizeFileName(unsafeName, FILE_ID), FILE_ID, unsafeName);
  }
});

test('D2: a leading ~ expands to the home directory, ~user stays unchanged', () => {
  const homeDirectory = join(tmpdir(), 'fake-home');
  assert.equal(expandHomeDirectory('~', homeDirectory), homeDirectory);
  assert.equal(expandHomeDirectory('~/a', homeDirectory), join(homeDirectory, 'a'));
  assert.equal(expandHomeDirectory('~\\a', homeDirectory), join(homeDirectory, 'a'));
  assert.equal(expandHomeDirectory('~user/a', homeDirectory), '~user/a');
  assert.equal(expandHomeDirectory('downloads/~/a', homeDirectory), 'downloads/~/a');
});

test('D3: the download target follows the default, directory, trailing separator, ~, file and relative path rules', async () => {
  const environment = await createDownloadEnvironment();
  const existingDirectory = join(environment.cwd, 'existing');
  await mkdir(existingDirectory);
  const fileInfo = { id: SERVER_FILE_ID, name: '../screenshot.png' };
  const resolveFor = (outputPath: string | undefined) => resolveDownloadTarget({ outputPath, fileInfo, ...environment });

  assert.equal(
    await resolveFor(undefined),
    join(environment.temporaryDirectory, DOWNLOAD_DIRECTORY_NAME, `${SERVER_FILE_ID}_screenshot.png`),
  );
  assert.equal(await resolveFor(existingDirectory), join(existingDirectory, 'screenshot.png'));
  assert.equal(await resolveFor(join(environment.cwd, 'new-directory') + '/'), join(environment.cwd, 'new-directory', 'screenshot.png'));
  assert.equal(await resolveFor(join(environment.cwd, 'other-directory') + '\\'), join(environment.cwd, 'other-directory', 'screenshot.png'));
  assert.equal(await resolveFor('~/new-directory/'), join(environment.homeDirectory, 'new-directory', 'screenshot.png'));
  assert.equal(await resolveFor('~/saved.png'), join(environment.homeDirectory, 'saved.png'));
  assert.equal(await resolveFor(join(environment.cwd, 'nested', 'saved.png')), join(environment.cwd, 'nested', 'saved.png'));
  assert.equal(await resolveFor('relative/saved.png'), join(environment.cwd, 'relative', 'saved.png'));
  assert.equal(await resolveFor('existing'), join(existingDirectory, 'screenshot.png'));

  const accessDenied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  await assert.rejects(
    resolveDownloadTarget({
      outputPath: 'blocked/saved.png',
      fileInfo,
      ...environment,
      stat: async () => {
        throw accessDenied;
      },
    }),
    accessDenied,
  );
});

test('D4: inline is allowed only for png, jpeg, gif and webp up to 1 MB', () => {
  for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    assert.deepEqual(decideInlineImage(mimeType, INLINE_IMAGE_MAX_BYTES), { inline: true }, mimeType);
  }
  assert.deepEqual(decideInlineImage('image/png', INLINE_IMAGE_MAX_BYTES + 1), { inline: false, reason: INLINE_SKIPPED_SIZE_REASON });
  assert.deepEqual(decideInlineImage('image/svg+xml', 10), {
    inline: false,
    reason: 'Inline skipped: image/svg+xml is not one of image/png, image/jpeg, image/gif, image/webp',
  });
  assert.deepEqual(decideInlineImage('application/pdf', 10), { inline: false, reason: createInlineSkippedTypeReason('application/pdf') });
});

test('D5: an invalid file_id returns isError without any HTTP request', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const environment = await createDownloadEnvironment();
  const http = createFileHttp(PNG_FILE_INFO);
  const client = createClient(http);

  for (const invalidId of ['../x', FILE_ID.toUpperCase(), FILE_ID.slice(1)]) {
    const results: ToolResult[] = [
      await handleGetFileInfo(client, { file_id: invalidId }),
      await handleDownloadFile(client, { file_id: invalidId }, environment),
    ];
    for (const result of results) {
      assert.equal(result.isError, true, invalidId);
      assert.equal(parseTextContent(result).error, INVALID_FILE_ID_MESSAGE);
    }
  }
  assert.equal(http.records.length, 0);
});

test('D6: get file info returns the file metadata', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = createFileHttp(PNG_FILE_INFO);

  const result: ToolResult = await handleGetFileInfo(createClient(http), { file_id: FILE_ID });

  assert.equal(result.isError, undefined);
  assert.deepEqual(parseTextContent(result), {
    id: FILE_ID,
    name: 'screenshot.png',
    extension: 'png',
    size: FILE_BYTES.byteLength,
    mime_type: 'image/png',
    width: 800,
    height: 600,
    post_id: PNG_FILE_INFO.post_id,
  });
  assert.deepEqual(
    http.records.map(({ method, url }) => ({ method, url })),
    [{ method: 'GET', url: FILE_INFO_URL }],
  );
});

test('D7: download writes the streamed bytes to the default path and overwrites an existing file without leftovers', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const environment = await createDownloadEnvironment();
  const client = createClient(createFileHttp(PDF_FILE_INFO));
  const expectedPath = join(environment.temporaryDirectory, DOWNLOAD_DIRECTORY_NAME, `${FILE_ID}_report.pdf`);

  const firstResult: ToolResult = await handleDownloadFile(client, { file_id: FILE_ID }, environment);
  assert.equal(firstResult.isError, undefined);
  assert.equal(firstResult.content.length, 1);
  const output = parseTextContent(firstResult);
  assert.equal(isAbsolute(output.path), true);
  assert.deepEqual(output, { path: expectedPath, id: FILE_ID, name: 'report.pdf', size: FILE_BYTES.byteLength, mime_type: 'application/pdf' });
  assert.deepEqual(await readFile(expectedPath), FILE_BYTES);

  await writeFile(expectedPath, 'previous content that is longer than the download');
  const secondResult: ToolResult = await handleDownloadFile(client, { file_id: FILE_ID }, environment);
  assert.equal(secondResult.isError, undefined);
  assert.deepEqual(await readFile(expectedPath), FILE_BYTES);
  assert.deepEqual(await listPartialFiles(join(environment.temporaryDirectory, DOWNLOAD_DIRECTORY_NAME)), []);
});

test('D8: download creates missing directories for trailing separators, ~ and file paths', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const environment = await createDownloadEnvironment();
  const client = createClient(createFileHttp(PDF_FILE_INFO));
  const cases = [
    { outputPath: 'created-directory/', expectedPath: join(environment.cwd, 'created-directory', 'report.pdf') },
    { outputPath: '~/newdir/', expectedPath: join(environment.homeDirectory, 'newdir', 'report.pdf') },
    { outputPath: 'deep/parents/saved.pdf', expectedPath: join(environment.cwd, 'deep', 'parents', 'saved.pdf') },
  ];

  for (const { outputPath, expectedPath } of cases) {
    const result: ToolResult = await handleDownloadFile(client, { file_id: FILE_ID, output_path: outputPath }, environment);
    assert.equal(result.isError, undefined, outputPath);
    assert.equal(parseTextContent(result).path, expectedPath);
    assert.deepEqual(await readFile(expectedPath), FILE_BYTES, outputPath);
  }
});

test('D9: a stream failing in the middle returns isError, removes the partial file and keeps the previous file', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const environment = await createDownloadEnvironment();
  const targetDirectory = join(environment.cwd, 'target');
  await mkdir(targetDirectory);
  const failingHttp = createFileHttp(PDF_FILE_INFO, () => ({
    status: 200,
    bodyStream: Readable.from(
      (async function* () {
        yield FILE_BYTES.subarray(0, 4);
        throw new Error('connection reset');
      })(),
    ),
  }));

  const newFileResult: ToolResult = await handleDownloadFile(
    createClient(failingHttp),
    { file_id: FILE_ID, output_path: join(targetDirectory, 'new.pdf') },
    environment,
  );
  assert.equal(newFileResult.isError, true);
  assert.equal(parseTextContent(newFileResult).error, 'connection reset');
  assert.deepEqual(await readdir(targetDirectory), []);

  const previousFilePath = join(targetDirectory, 'previous.pdf');
  await writeFile(previousFilePath, 'previous content');
  const overwriteResult: ToolResult = await handleDownloadFile(
    createClient(failingHttp),
    { file_id: FILE_ID, output_path: previousFilePath },
    environment,
  );
  assert.equal(overwriteResult.isError, true);
  assert.equal(await readFile(previousFilePath, 'utf8'), 'previous content');
  assert.deepEqual(await readdir(targetDirectory), ['previous.pdf']);
});

test('D10: inline returns the text block first and an image block only for small raster images', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const environment = await createDownloadEnvironment();

  const pngResult: ToolResult = await handleDownloadFile(createClient(createFileHttp(PNG_FILE_INFO)), { file_id: FILE_ID, inline: true }, environment);
  assert.equal(pngResult.isError, undefined);
  assert.equal(pngResult.content.length, 2);
  assert.equal('inline_skipped_reason' in parseTextContent(pngResult), false);
  assert.deepEqual(pngResult.content[1], { type: 'image', data: FILE_BYTES.toString('base64'), mimeType: 'image/png' });

  const withoutInlineResult: ToolResult = await handleDownloadFile(createClient(createFileHttp(PNG_FILE_INFO)), { file_id: FILE_ID }, environment);
  assert.equal(withoutInlineResult.content.length, 1);
  assert.equal('inline_skipped_reason' in parseTextContent(withoutInlineResult), false);

  const largeBytes = Buffer.alloc(INLINE_IMAGE_MAX_BYTES + 1);
  const cases: Array<{ description: string; fileInfo: FileInfo; bytes: Buffer; expectedReason: string }> = [
    {
      description: 'metadata size above the limit',
      fileInfo: { ...PNG_FILE_INFO, size: INLINE_IMAGE_MAX_BYTES + 1 },
      bytes: FILE_BYTES,
      expectedReason: INLINE_SKIPPED_SIZE_REASON,
    },
    {
      description: 'actual size above the limit with smaller metadata',
      fileInfo: PNG_FILE_INFO,
      bytes: largeBytes,
      expectedReason: INLINE_SKIPPED_SIZE_REASON,
    },
    { description: 'svg', fileInfo: SVG_FILE_INFO, bytes: FILE_BYTES, expectedReason: createInlineSkippedTypeReason('image/svg+xml') },
    { description: 'pdf', fileInfo: PDF_FILE_INFO, bytes: FILE_BYTES, expectedReason: createInlineSkippedTypeReason('application/pdf') },
  ];

  for (const { description, fileInfo, bytes, expectedReason } of cases) {
    const http = createFileHttp(fileInfo, () => ({ status: 200, body: bytes }));
    const result: ToolResult = await handleDownloadFile(createClient(http), { file_id: FILE_ID, inline: true }, environment);
    assert.equal(result.isError, undefined, description);
    assert.equal(result.content.length, 1, description);
    const output = parseTextContent(result);
    assert.equal(output.inline_skipped_reason, expectedReason, description);
    assert.deepEqual(await readFile(output.path), bytes, description);
  }
  assert.match(createInlineSkippedTypeReason('image/svg+xml'), /image\/svg\+xml/);
});

test('D11: 404 and 403 responses return isError with a clear text', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const environment = await createDownloadEnvironment();
  const cases = [
    { description: 'info 404', http: new FakeHttp(() => ({ status: 404 })), expectedError: createFileNotFoundMessage(FILE_ID) },
    { description: 'info 403', http: new FakeHttp(() => ({ status: 403 })), expectedError: createFileForbiddenMessage(FILE_ID) },
    { description: 'download 403', http: createFileHttp(PDF_FILE_INFO, () => ({ status: 403 })), expectedError: createFileForbiddenMessage(FILE_ID) },
    { description: 'download 500', http: createFileHttp(PDF_FILE_INFO, () => ({ status: 500 })), expectedError: 'Failed to download file: 500 Internal Server Error' },
  ];

  for (const { description, http, expectedError } of cases) {
    const client = createClient(http);
    const downloadResult: ToolResult = await handleDownloadFile(client, { file_id: FILE_ID }, environment);
    assert.equal(downloadResult.isError, true, description);
    assert.equal(parseTextContent(downloadResult).error, expectedError, description);
  }

  const infoResult: ToolResult = await handleGetFileInfo(createClient(new FakeHttp(() => ({ status: 404 }))), { file_id: FILE_ID });
  assert.equal(infoResult.isError, true);
  assert.equal(parseTextContent(infoResult).error, `File ${FILE_ID} not found or not accessible`);
  assert.equal(createFileForbiddenMessage(FILE_ID), `No permission to access file ${FILE_ID}`);
  assert.deepEqual(await listPartialFiles(join(environment.temporaryDirectory, DOWNLOAD_DIRECTORY_NAME)), []);
});
