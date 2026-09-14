import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { AUTHENTICATION_MODES, PROGRESS_NOTIFICATION_METHOD } from '../../src/authentication/constants.js';
import type { ProgressUpdate, RequestCallContext, TokenProvider } from '../../src/authentication/session.js';
import { CallToolHandlerDependencies, createCallToolHandler } from '../../src/callToolHandler.js';
import { MattermostClient } from '../../src/client.js';
import type { AuthenticationMode, Config } from '../../src/config.js';
import { FakeHttp } from '../fixtures/fakeHttp.js';

const MATTERMOST_URL = 'https://chat.example.test/api/v4';
const TEAM_ID = 'team-test';
const CONFIG: Config = { mattermostUrl: MATTERMOST_URL, token: '', teamId: TEAM_ID };
const SESSION_TOKEN = 'session-secret-token-0001';
const LIST_CHANNELS_TOOL_NAME = 'mattermost_list_channels';
const PROGRESS_TOKEN = 'progress-token-1';
const PROGRESS_UPDATE: ProgressUpdate = { progress: 3, message: 'Waiting for Mattermost sign-in in the browser window (3 s)' };

/** Провайдер браузерного режима: запоминает контекст вызова и сообщает прогресс, как ожидание входа */
class ProgressReportingTokenProvider implements TokenProvider {
  readonly mode: AuthenticationMode = AUTHENTICATION_MODES.BROWSER;
  readonly callContexts: RequestCallContext[] = [];

  async getToken(callContext: RequestCallContext): Promise<string> {
    this.callContexts.push(callContext);
    callContext.reportProgress?.(PROGRESS_UPDATE);
    return SESSION_TOKEN;
  }

  async recoverFromUnauthorized(): Promise<string | undefined> {
    return undefined;
  }
}

function createHandler(): {
  handler: ReturnType<typeof createCallToolHandler>;
  tokenProvider: ProgressReportingTokenProvider;
  http: FakeHttp;
  notifications: unknown[];
} {
  const http = new FakeHttp(() => ({ status: 200, body: [] }));
  const tokenProvider = new ProgressReportingTokenProvider();
  const client = new MattermostClient({ config: CONFIG, tokenProvider, fetchImplementation: http.fetch });
  const notifications: unknown[] = [];
  const server: CallToolHandlerDependencies['server'] = {
    notification: async (notification) => {
      notifications.push(notification);
    },
  };
  const handler = createCallToolHandler({ server, client, logger: () => undefined });
  return { handler, tokenProvider, http, notifications };
}

function createRequest(parameters: CallToolRequest['params']): CallToolRequest {
  return { method: 'tools/call', params: parameters };
}

test('H1: a tools/call request runs the tool with an interactive context, progress notifications and the request abort signal', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { handler, tokenProvider, http, notifications } = createHandler();
  const requestAbortController = new AbortController();

  const result = await handler(
    createRequest({ name: LIST_CHANNELS_TOOL_NAME, arguments: {}, _meta: { progressToken: PROGRESS_TOKEN } }),
    { signal: requestAbortController.signal },
  );

  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(http.records.length, 1);
  assert.equal(tokenProvider.callContexts.length, 1);
  const [callContext] = tokenProvider.callContexts;
  assert.equal(callContext.interactive, true);
  assert.equal(callContext.cancellationSignal, requestAbortController.signal);
  assert.equal(http.records[0].signal, requestAbortController.signal);
  assert.deepEqual(notifications, [
    {
      method: PROGRESS_NOTIFICATION_METHOD,
      params: { progressToken: PROGRESS_TOKEN, progress: PROGRESS_UPDATE.progress, message: PROGRESS_UPDATE.message },
    },
  ]);
});

test('H2: without a progress token no notification is sent, and missing arguments keep the previous error result', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { handler, tokenProvider, notifications } = createHandler();
  const signal = new AbortController().signal;

  const result = await handler(createRequest({ name: LIST_CHANNELS_TOOL_NAME, arguments: {} }), { signal });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(tokenProvider.callContexts[0].interactive, true);
  assert.deepEqual(notifications, []);

  const missingArgumentsResult = await handler(createRequest({ name: LIST_CHANNELS_TOOL_NAME }), { signal });
  assert.deepEqual(missingArgumentsResult, {
    content: [{ type: 'text', text: JSON.stringify({ error: 'No arguments provided' }) }],
    isError: true,
  });
  assert.equal(tokenProvider.callContexts.length, 1);
});
