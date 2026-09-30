import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaticTokenProvider } from '../../src/authentication/session.js';
import { MattermostClient } from '../../src/client.js';
import type { Config } from '../../src/config.js';
import {
  EDIT_POST_FORBIDDEN_HINT,
  INVALID_MESSAGE_MESSAGE,
  INVALID_POST_ID_MESSAGE,
  createPostNotFoundMessage,
  editPostTool,
  handleEditPost,
  handleGetPost,
} from '../../src/tools/messages.js';
import type { FileInfo, Post } from '../../src/types.js';
import { FakeHttp } from '../fixtures/fakeHttp.js';

const MATTERMOST_URL = 'https://chat.example.test/api/v4';
const CONFIG: Config = { mattermostUrl: MATTERMOST_URL, token: 'static-secret-token-0001', teamId: 'team-test' };
const POST_ID = 'abcdefghijklmnopqrstuvwxyz';
const ROOT_POST_ID = '0123456789abcdefghijklmnop';
const POST_URL = `${MATTERMOST_URL}/posts/${POST_ID}`;
const PATCH_URL = `${POST_URL}/patch`;
const CREATE_AT = 1_700_000_000_000;
const EDIT_AT = 1_700_000_100_000;
const EDITED_MESSAGE = 'edited text';
const IMAGE_FILE: FileInfo = { id: 'file-image', name: 'screenshot.png', extension: 'png', size: 2048, mime_type: 'image/png' };
const FORBIDDEN_BODY = '{"id":"api.context.permissions.app_error","message":"You do not have the appropriate permissions.","status_code":403}';
const TIME_LIMIT_BODY =
  '{"id":"api.post.update_post.permissions_time_limit.app_error","message":"Post edit is only allowed for 300 seconds.","status_code":400}';

function createPost(overrides: Partial<Post>): Post {
  return {
    id: POST_ID,
    create_at: CREATE_AT,
    update_at: CREATE_AT,
    delete_at: 0,
    edit_at: 0,
    user_id: 'user-1',
    channel_id: 'channel-1',
    root_id: '',
    original_id: '',
    message: 'hello',
    type: '',
    props: {},
    hashtags: '',
    pending_post_id: '',
    reply_count: 0,
    ...overrides,
  };
}

function createClient(http: FakeHttp): MattermostClient {
  return new MattermostClient({ config: CONFIG, tokenProvider: new StaticTokenProvider(CONFIG.token), fetchImplementation: http.fetch });
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parseTextContent(result: ToolResult): any {
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text ?? '');
}

test('E1: an invalid post_id returns isError without any HTTP request', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => ({ status: 200, body: createPost({}) }));
  const client = createClient(http);

  for (const invalidId of ['../x', POST_ID.toUpperCase(), POST_ID.slice(1), `${POST_ID}/patch`]) {
    const results: ToolResult[] = [
      await handleGetPost(client, { post_id: invalidId }),
      await handleEditPost(client, { post_id: invalidId, message: EDITED_MESSAGE }),
    ];
    for (const result of results) {
      assert.equal(result.isError, true, invalidId);
      assert.equal(parseTextContent(result).error, INVALID_POST_ID_MESSAGE);
    }
  }

  for (const invalidMessage of [undefined, null, 42, { text: 'x' }]) {
    const result: ToolResult = await handleEditPost(client, { post_id: POST_ID, message: invalidMessage as unknown as string });
    assert.equal(result.isError, true, String(invalidMessage));
    assert.equal(parseTextContent(result).error, INVALID_MESSAGE_MESSAGE);
  }
  assert.equal(http.records.length, 0);
});

test('E2: get post returns the post fields and attachments', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const post = createPost({ edit_at: EDIT_AT, root_id: ROOT_POST_ID, file_ids: [IMAGE_FILE.id], metadata: { files: [IMAGE_FILE] } });
  const http = new FakeHttp(() => ({ status: 200, body: post }));

  const result: ToolResult = await handleGetPost(createClient(http), { post_id: POST_ID });

  assert.equal(result.isError, undefined);
  assert.deepEqual(parseTextContent(result), {
    id: POST_ID,
    channel_id: 'channel-1',
    user_id: 'user-1',
    message: 'hello',
    create_at: new Date(CREATE_AT).toISOString(),
    edit_at: new Date(EDIT_AT).toISOString(),
    root_id: ROOT_POST_ID,
    file_ids: [IMAGE_FILE.id],
    files: [{ id: 'file-image', name: 'screenshot.png', extension: 'png', size: 2048, mime_type: 'image/png' }],
  });
  assert.deepEqual(
    http.records.map(({ method, url }) => ({ method, url })),
    [{ method: 'GET', url: POST_URL }],
  );
});

test('E3: get post without edits, root and attachments returns null edit_at and root_id', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => ({ status: 200, body: createPost({}) }));

  const result: ToolResult = await handleGetPost(createClient(http), { post_id: POST_ID });

  const formatted = parseTextContent(result);
  assert.equal(formatted.edit_at, null);
  assert.equal(formatted.root_id, null);
  assert.equal('file_ids' in formatted, false);
  assert.equal('files' in formatted, false);
});

test('E4: get post 404 returns isError with a clear text', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => ({ status: 404 }));

  const result: ToolResult = await handleGetPost(createClient(http), { post_id: POST_ID });

  assert.equal(result.isError, true);
  assert.equal(parseTextContent(result).error, createPostNotFoundMessage(POST_ID));
});

test('E5: edit post sends PUT to the patch endpoint and returns id, message and edit_at', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => ({ status: 200, body: createPost({ message: EDITED_MESSAGE, edit_at: EDIT_AT }) }));

  const result: ToolResult = await handleEditPost(createClient(http), { post_id: POST_ID, message: EDITED_MESSAGE });

  assert.equal(result.isError, undefined);
  assert.deepEqual(parseTextContent(result), { id: POST_ID, message: EDITED_MESSAGE, edit_at: new Date(EDIT_AT).toISOString() });
  assert.deepEqual(
    http.records.map(({ method, url, body }) => ({ method, url, body })),
    [{ method: 'PUT', url: PATCH_URL, body: JSON.stringify({ message: EDITED_MESSAGE }) }],
  );
});

test('E6: edit post 403 returns the server text and the author hint', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => ({ status: 403, body: FORBIDDEN_BODY }));

  const result: ToolResult = await handleEditPost(createClient(http), { post_id: POST_ID, message: EDITED_MESSAGE });

  assert.equal(result.isError, true);
  const error: string = parseTextContent(result).error;
  assert.ok(error.includes(FORBIDDEN_BODY), error);
  assert.ok(error.endsWith(` ${EDIT_POST_FORBIDDEN_HINT}`), error);
});

test('E7: edit post 400 passes the server text through', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => ({ status: 400, statusText: 'Bad Request', body: TIME_LIMIT_BODY }));

  const result: ToolResult = await handleEditPost(createClient(http), { post_id: POST_ID, message: EDITED_MESSAGE });

  assert.equal(result.isError, true);
  const error: string = parseTextContent(result).error;
  assert.equal(error, `Failed to edit post: 400 Bad Request - ${TIME_LIMIT_BODY}`);
  assert.equal(error.includes(EDIT_POST_FORBIDDEN_HINT), false);
});

test('E8: the edit tool description warns that the post is marked as Edited', () => {
  assert.ok(editPostTool.description?.includes('marks an edited post as "Edited" for everyone'), editPostTool.description);
});
