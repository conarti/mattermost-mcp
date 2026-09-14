import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  AUTHENTICATION_ERROR_CODES,
  AUTHENTICATION_MODES,
  CURRENT_USER_API_PATH,
} from '../../src/authentication/constants.js';
import { MattermostAuthenticationError } from '../../src/authentication/runtime.js';
import {
  BACKGROUND_CALL_CONTEXT,
  RequestCallContext,
  createTokenProvider,
  createToolCallContext,
} from '../../src/authentication/session.js';
import { resolveStatePaths } from '../../src/authentication/stateFiles.js';
import { MattermostClient } from '../../src/client.js';
import type { Config, MonitoringConfig } from '../../src/config.js';
import { TopicMonitor } from '../../src/monitor/index.js';
import { handleRunMonitoring, setTopicMonitorInstance } from '../../src/tools/monitoring.js';
import { createLogCapture } from '../fixtures/captureLogs.js';
import { FakeClock } from '../fixtures/fakeClock.js';
import { FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS } from '../fixtures/fixtureConstants.js';
import { FakeHttp, FakeHttpScenario } from '../fixtures/fakeHttp.js';
import { FakeLoginBrowserLauncher } from '../fixtures/fakeLoginBrowser.js';
import { TOKEN_PROVIDER_CALL_KINDS, RecordingTokenProvider } from '../fixtures/recordingTokenProvider.js';
import { removeDirectories } from '../fixtures/runProcess.js';

const START_MILLISECONDS = 1_000_000_000_000;
const MATTERMOST_URL = 'https://chat.example.test/api/v4';
const TEAM_ID = 'team-test';
const BROWSER_CONFIG: Config = { mattermostUrl: MATTERMOST_URL, token: '', teamId: TEAM_ID };
const STATIC_TOKEN = 'static-secret-token-0001';
const SESSION_TOKEN = 'session-secret-token-0002';
const MONITORED_CHANNEL_NAME = 'town-square';
const MONITORED_CHANNEL_ID = 'channel-1';
const CHANNELS_URL = `${MATTERMOST_URL}/teams/${TEAM_ID}/channels?page=0&per_page=100`;
const POSTS_URL = `${MATTERMOST_URL}/channels/${MONITORED_CHANNEL_ID}/posts?page=0&per_page=10`;
const CURRENT_USER_URL = `${MATTERMOST_URL}${CURRENT_USER_API_PATH}`;
const MONITORING_SKIPPED_LOG_LINE = `[auth] monitoring run skipped: ${AUTHENTICATION_ERROR_CODES.AUTHENTICATION_REQUIRED}`;

const MONITORING_CONFIG: MonitoringConfig = {
  enabled: true,
  schedule: '*/5 * * * *',
  channels: [MONITORED_CHANNEL_NAME],
  topics: ['release'],
  messageLimit: 10,
  notificationChannelId: 'notification-channel',
  userId: 'user-1',
};

const MONITORING_SCENARIO: FakeHttpScenario = (_token, record) => {
  if (record.url.startsWith(`${MATTERMOST_URL}/teams/${TEAM_ID}/channels`)) {
    return { status: 200, body: [{ id: MONITORED_CHANNEL_ID, name: MONITORED_CHANNEL_NAME, type: 'O' }] };
  }
  return { status: 200, body: { order: [], posts: {} } };
};

const temporaryDirectories: string[] = [];

after(() => removeDirectories(temporaryDirectories));

async function createTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-topic-monitor-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createInteractiveContext(): RequestCallContext {
  return createToolCallContext({
    progressToken: undefined,
    sendProgressNotification: async () => undefined,
    cancellationSignal: new AbortController().signal,
    logger: () => undefined,
  });
}

function printedLines(calls: ReadonlyArray<{ arguments: unknown[] }>): string[] {
  return calls.map((call) => call.arguments.map(String).join(' '));
}

function readResultText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((item) => item.text).join('\n');
}

function isAuthenticationRequiredError(error: unknown): boolean {
  assert.ok(error instanceof MattermostAuthenticationError);
  assert.equal(error.code, AUTHENTICATION_ERROR_CODES.AUTHENTICATION_REQUIRED);
  return true;
}

test('M1: scheduled and immediate monitor runs call the token provider only as background requests', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(MONITORING_SCENARIO);
  const tokenProvider = new RecordingTokenProvider(AUTHENTICATION_MODES.BROWSER, SESSION_TOKEN);
  const client = new MattermostClient({ config: BROWSER_CONFIG, tokenProvider, fetchImplementation: http.fetch });
  const monitor = new TopicMonitor(client.withCallContext(createInteractiveContext()), MONITORING_CONFIG);
  const scheduler = Reflect.get(monitor, 'scheduler') as { runNow(): Promise<void> };

  await scheduler.runNow();
  const scheduledCallCount = tokenProvider.calls.length;
  await monitor.runNow();

  assert.ok(scheduledCallCount > 0);
  assert.ok(tokenProvider.calls.length > scheduledCallCount);
  assert.deepEqual(
    http.records.map((record) => record.url),
    [CHANNELS_URL, POSTS_URL, CHANNELS_URL, POSTS_URL],
  );
  for (const call of tokenProvider.calls) {
    assert.equal(call.callContext.interactive, false);
    assert.equal(call.callContext, BACKGROUND_CALL_CONTEXT);
  }
});

test('M2: browser mode run monitoring tool signs in interactively first and reports LOGIN_WINDOW_CLOSED', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => ({ status: 401 }));
  const tokenProvider = new RecordingTokenProvider(AUTHENTICATION_MODES.BROWSER, SESSION_TOKEN, async () => {
    throw new MattermostAuthenticationError(
      AUTHENTICATION_ERROR_CODES.LOGIN_WINDOW_CLOSED,
      'The Mattermost sign-in window was closed before sign-in completed.',
    );
  });
  const client = new MattermostClient({ config: BROWSER_CONFIG, tokenProvider, fetchImplementation: http.fetch });
  const callContext = createInteractiveContext();

  const result = await handleRunMonitoring(client.withCallContext(callContext), {});

  assert.equal(result.isError, true);
  assert.ok(readResultText(result).includes(`[${AUTHENTICATION_ERROR_CODES.LOGIN_WINDOW_CLOSED}]`), readResultText(result));
  assert.equal(tokenProvider.calls[0].kind, TOKEN_PROVIDER_CALL_KINDS.GET_TOKEN);
  assert.equal(tokenProvider.calls[0].callContext, callContext);
  assert.equal(tokenProvider.calls[0].callContext.interactive, true);
  assert.deepEqual(
    tokenProvider.calls.map((call) => call.kind),
    [TOKEN_PROVIDER_CALL_KINDS.GET_TOKEN, TOKEN_PROVIDER_CALL_KINDS.RECOVER_FROM_UNAUTHORIZED],
  );
  assert.equal(tokenProvider.calls[1].callContext.interactive, true);
  assert.deepEqual(
    http.records.map((record) => record.url),
    [CURRENT_USER_URL],
  );
});

test('M3: a monitor run in a browser session without a token file is skipped with AUTHENTICATION_REQUIRED', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async (t) => {
  const errorOutput = t.mock.method(console, 'error', () => undefined);
  const homeDirectory = await createTemporaryHome();
  const logs = createLogCapture();
  const launcher = new FakeLoginBrowserLauncher();
  const http = new FakeHttp(MONITORING_SCENARIO);
  /* Ручные часы: ошибочный интерактивный путь не держит тест реальными ожиданиями входа */
  const tokenProvider = createTokenProvider(BROWSER_CONFIG, http.fetch, {
    homeDirectory,
    launcher,
    logger: logs.logger,
    clock: new FakeClock(START_MILLISECONDS),
  });
  const client = new MattermostClient({ config: BROWSER_CONFIG, tokenProvider, fetchImplementation: http.fetch });
  const monitor = new TopicMonitor(client.withCallContext(createInteractiveContext()), MONITORING_CONFIG);

  await assert.rejects(monitor.runNow(), isAuthenticationRequiredError);

  assert.ok(printedLines(errorOutput.mock.calls).includes(MONITORING_SKIPPED_LOG_LINE));
  assert.equal(logs.count('background request needs sign-in, skipped'), 1);
  assert.equal(launcher.launchCalls.length, 0);
  assert.equal(launcher.inspectCalls, 0);
  assert.equal(http.records.length, 0);
});

test('M4: static mode run monitoring tool sends no request to /users/me', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const homeDirectory = await createTemporaryHome();
  const staticConfig: Config = { ...BROWSER_CONFIG, token: STATIC_TOKEN };
  const http = new FakeHttp(MONITORING_SCENARIO);
  const tokenProvider = createTokenProvider(staticConfig, http.fetch, { homeDirectory });
  const client = new MattermostClient({ config: staticConfig, tokenProvider, fetchImplementation: http.fetch });
  assert.equal(client.authenticationMode, AUTHENTICATION_MODES.STATIC);
  setTopicMonitorInstance(new TopicMonitor(client, MONITORING_CONFIG));

  const result = await handleRunMonitoring(client.withCallContext(createInteractiveContext()), {});

  assert.equal(result.isError, undefined, readResultText(result));
  assert.equal(
    http.records.filter((record) => record.url.startsWith(CURRENT_USER_URL)).length,
    0,
  );
  assert.deepEqual(
    http.records.map((record) => record.url),
    [CHANNELS_URL, POSTS_URL],
  );
  assert.equal(existsSync(resolveStatePaths(homeDirectory).stateDirectory), false);
});

test('M5: monitor start in a browser session without a token file and without userId rejects with AUTHENTICATION_REQUIRED', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const homeDirectory = await createTemporaryHome();
  const launcher = new FakeLoginBrowserLauncher();
  const http = new FakeHttp(MONITORING_SCENARIO);
  const tokenProvider = createTokenProvider(BROWSER_CONFIG, http.fetch, {
    homeDirectory,
    launcher,
    logger: () => undefined,
    clock: new FakeClock(START_MILLISECONDS),
  });
  const client = new MattermostClient({ config: BROWSER_CONFIG, tokenProvider, fetchImplementation: http.fetch });
  const monitor = new TopicMonitor(client, { ...MONITORING_CONFIG, userId: '' });

  await assert.rejects(monitor.start(), isAuthenticationRequiredError);

  assert.equal(monitor.isRunning(), false);
  assert.equal(launcher.launchCalls.length, 0);
  assert.equal(http.records.length, 0);
});
