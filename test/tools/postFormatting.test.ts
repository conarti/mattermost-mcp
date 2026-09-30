import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTHENTICATION_MODES } from '../../src/authentication/constants.js';
import { MattermostClient } from '../../src/client.js';
import type { Config } from '../../src/config.js';
import { handleGetChannelHistory } from '../../src/tools/channels.js';
import { handleGetThreadReplies } from '../../src/tools/messages.js';
import { formatPostAttachments } from '../../src/tools/postFormatting.js';
import type { FileInfo, Post, PostsResponse } from '../../src/types.js';
import { FakeHttp } from '../fixtures/fakeHttp.js';
import { RecordingTokenProvider } from '../fixtures/recordingTokenProvider.js';

const MATTERMOST_URL = 'https://chat.example.test/api/v4';
const CONFIG: Config = { mattermostUrl: MATTERMOST_URL, token: '', teamId: 'team-test' };
const SESSION_TOKEN = 'session-secret-token-0001';
const CHANNEL_ID = 'channel-1';
const ROOT_POST_ID = 'post-root';
const REPLY_POST_ID = 'post-reply';
const PLAIN_POST_ID = 'post-plain';
const IMAGE_FILE: FileInfo = {
  id: 'file-image',
  name: 'screenshot.png',
  extension: 'png',
  size: 2048,
  mime_type: 'image/png',
  width: 800,
  height: 600,
  post_id: ROOT_POST_ID,
  create_at: 1_700_000_000_000,
};
const DOCUMENT_FILE: FileInfo = {
  id: 'file-document',
  name: 'report.pdf',
  extension: 'pdf',
  size: 4096,
  mime_type: 'application/pdf',
};
const FORMATTED_IMAGE_FILE = { id: 'file-image', name: 'screenshot.png', extension: 'png', size: 2048, mime_type: 'image/png', width: 800, height: 600 };
const FORMATTED_DOCUMENT_FILE = { id: 'file-document', name: 'report.pdf', extension: 'pdf', size: 4096, mime_type: 'application/pdf' };

function createPost(overrides: Partial<Post>): Post {
  return {
    id: PLAIN_POST_ID,
    create_at: 1_700_000_000_000,
    update_at: 1_700_000_000_000,
    delete_at: 0,
    edit_at: 0,
    user_id: 'user-1',
    channel_id: CHANNEL_ID,
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

function createPostsResponse(posts: Post[]): PostsResponse {
  return {
    order: posts.map((post) => post.id),
    posts: Object.fromEntries(posts.map((post) => [post.id, post])),
    next_post_id: '',
    prev_post_id: '',
  };
}

function createClient(http: FakeHttp): MattermostClient {
  const tokenProvider = new RecordingTokenProvider(AUTHENTICATION_MODES.BROWSER, SESSION_TOKEN);
  return new MattermostClient({ config: CONFIG, tokenProvider, fetchImplementation: http.fetch });
}

function parseTextContent(result: { content: Array<{ type: string; text?: string }> }): any {
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text ?? '');
}

const ROOT_POST = createPost({ id: ROOT_POST_ID, file_ids: [IMAGE_FILE.id, DOCUMENT_FILE.id], metadata: { files: [IMAGE_FILE, DOCUMENT_FILE] } });
const REPLY_POST = createPost({ id: REPLY_POST_ID, root_id: ROOT_POST_ID, file_ids: [DOCUMENT_FILE.id] });
const PLAIN_POST = createPost({ id: PLAIN_POST_ID, metadata: { embeds: [] } });

test('A1: file_ids appear for a non-empty list, files only with metadata.files, and posts without attachments get no keys', () => {
  assert.deepEqual(formatPostAttachments(REPLY_POST), { file_ids: [DOCUMENT_FILE.id] });
  assert.deepEqual(formatPostAttachments(ROOT_POST), {
    file_ids: [IMAGE_FILE.id, DOCUMENT_FILE.id],
    files: [FORMATTED_IMAGE_FILE, FORMATTED_DOCUMENT_FILE],
  });
  assert.deepEqual(formatPostAttachments(PLAIN_POST), {});
  assert.deepEqual(formatPostAttachments(createPost({ file_ids: [], metadata: { files: [] } })), {});
});

test('A2: channel history shows attachments only on posts that have them', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => ({ status: 200, body: createPostsResponse([ROOT_POST, REPLY_POST, PLAIN_POST]) }));

  const result = await handleGetChannelHistory(createClient(http), { channel_id: CHANNEL_ID, limit: 10 });

  assert.equal('isError' in result, false);
  const posts = parseTextContent(result).posts;
  assert.deepEqual(posts[0].file_ids, [IMAGE_FILE.id, DOCUMENT_FILE.id]);
  assert.deepEqual(posts[0].files, [FORMATTED_IMAGE_FILE, FORMATTED_DOCUMENT_FILE]);
  assert.deepEqual(posts[1].file_ids, [DOCUMENT_FILE.id]);
  assert.equal('files' in posts[1], false);
  assert.equal('file_ids' in posts[2], false);
  assert.equal('files' in posts[2], false);
});

test('A3: thread replies and root_post show attachments', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => ({ status: 200, body: createPostsResponse([ROOT_POST, REPLY_POST, PLAIN_POST]) }));

  const result = await handleGetThreadReplies(createClient(http), { channel_id: CHANNEL_ID, post_id: ROOT_POST_ID });

  assert.equal('isError' in result, false);
  const output = parseTextContent(result);
  assert.deepEqual(output.root_post.file_ids, [IMAGE_FILE.id, DOCUMENT_FILE.id]);
  assert.deepEqual(output.root_post.files, [FORMATTED_IMAGE_FILE, FORMATTED_DOCUMENT_FILE]);
  assert.deepEqual(output.posts[1].file_ids, [DOCUMENT_FILE.id]);
  assert.equal('file_ids' in output.posts[2], false);
  assert.equal('files' in output.posts[2], false);
  assert.equal(http.records[0].url, `${MATTERMOST_URL}/posts/${ROOT_POST_ID}/thread`);
});
