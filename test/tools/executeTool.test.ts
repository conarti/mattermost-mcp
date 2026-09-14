import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTHENTICATION_MODES } from '../../src/authentication/constants.js';
import { BACKGROUND_CALL_CONTEXT, createToolCallContext } from '../../src/authentication/session.js';
import { MattermostClient } from '../../src/client.js';
import type { Config } from '../../src/config.js';
import { executeTool } from '../../src/tools/index.js';
import { FakeHttp } from '../fixtures/fakeHttp.js';
import { RecordingTokenProvider } from '../fixtures/recordingTokenProvider.js';

const MATTERMOST_URL = 'https://chat.example.test/api/v4';
const CONFIG: Config = { mattermostUrl: MATTERMOST_URL, token: '', teamId: 'team-test' };
const SESSION_TOKEN = 'session-secret-token-0001';
const LIST_CHANNELS_TOOL_NAME = 'mattermost_list_channels';
const UNKNOWN_TOOL_NAME = 'mattermost_unknown_tool';

function createBrowserModeClient(): { client: MattermostClient; tokenProvider: RecordingTokenProvider; http: FakeHttp } {
  const http = new FakeHttp(() => ({ status: 200, body: [] }));
  const tokenProvider = new RecordingTokenProvider(AUTHENTICATION_MODES.BROWSER, SESSION_TOKEN);
  const client = new MattermostClient({ config: CONFIG, tokenProvider, fetchImplementation: http.fetch });
  return { client, tokenProvider, http };
}

test('T1: the interactive tool call context reaches the token provider', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { client, tokenProvider, http } = createBrowserModeClient();
  const callContext = createToolCallContext({
    progressToken: undefined,
    sendProgressNotification: async () => undefined,
    cancellationSignal: new AbortController().signal,
    logger: () => undefined,
  });

  const result = await executeTool(client, LIST_CHANNELS_TOOL_NAME, {}, callContext);

  assert.equal('isError' in result, false);
  assert.equal(http.records.length, 1);
  assert.equal(tokenProvider.calls.length, 1);
  assert.equal(tokenProvider.calls[0].callContext, callContext);
  assert.equal(tokenProvider.calls[0].callContext.interactive, true);
});

test('T2: without a call context the token provider sees a background request', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { client, tokenProvider } = createBrowserModeClient();

  await executeTool(client, LIST_CHANNELS_TOOL_NAME, {});

  assert.equal(tokenProvider.calls.length, 1);
  assert.equal(tokenProvider.calls[0].callContext.interactive, false);
  assert.equal(tokenProvider.calls[0].callContext, BACKGROUND_CALL_CONTEXT);
});

test('T3: an unknown tool returns the previous isError result without calling the token provider', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { client, tokenProvider, http } = createBrowserModeClient();
  const callContext = createToolCallContext({
    progressToken: undefined,
    sendProgressNotification: async () => undefined,
    cancellationSignal: new AbortController().signal,
    logger: () => undefined,
  });

  const result = await executeTool(client, UNKNOWN_TOOL_NAME, {}, callContext);

  assert.deepEqual(result, {
    content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${UNKNOWN_TOOL_NAME}` }) }],
    isError: true,
  });
  assert.equal(tokenProvider.calls.length, 0);
  assert.equal(http.records.length, 0);
});
