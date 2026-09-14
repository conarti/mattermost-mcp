import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTHENTICATION_MODES, CURRENT_USER_API_PATH } from '../../src/authentication/constants.js';
import { RequestCallContext, createToolCallContext } from '../../src/authentication/session.js';
import { MattermostClient } from '../../src/client.js';
import type { AuthenticationMode, Config, MonitoringConfig } from '../../src/config.js';
import { TopicMonitor } from '../../src/monitor/index.js';
import { createDeferred, flushAsyncWork, waitForCondition } from '../fixtures/asyncControl.js';
import { FakeHttp, FakeHttpScenario } from '../fixtures/fakeHttp.js';
import { RecordingTokenProvider, TOKEN_PROVIDER_CALL_KINDS } from '../fixtures/recordingTokenProvider.js';

type MonitoringModule = typeof import('../../src/tools/monitoring.js');

const MATTERMOST_URL = 'https://chat.example.test/api/v4';
const TEAM_ID = 'team-test';
const SESSION_TOKEN = 'session-secret-token-0001';
const CHANNELS_URL = `${MATTERMOST_URL}/teams/${TEAM_ID}/channels?page=0&per_page=100`;
const CURRENT_USER_URL = `${MATTERMOST_URL}${CURRENT_USER_API_PATH}`;
const MONITORED_CHANNEL_NAME = 'town-square';
const START_FAILURE_MESSAGE = 'monitor start failed in the test';
const DISABLED_MONITORING_ERROR = 'Topic monitoring is disabled in configuration';

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
  if (record.url === CHANNELS_URL) {
    return { status: 200, body: [{ id: 'channel-1', name: MONITORED_CHANNEL_NAME, type: 'O' }] };
  }
  if (record.url === CURRENT_USER_URL) {
    return { status: 200, body: { id: 'user-1' } };
  }
  return { status: 200, body: { order: [], posts: {} } };
};

let monitoringModuleLoadCount = 0;

/** Зарегистрированный монитор и общий запуск живут в состоянии модуля, поэтому каждый тест берёт свой экземпляр модуля */
async function importFreshMonitoringModule(): Promise<MonitoringModule> {
  monitoringModuleLoadCount += 1;
  const moduleUrl = new URL(`../../src/tools/monitoring.js?instance=${monitoringModuleLoadCount}`, import.meta.url);
  return (await import(moduleUrl.href)) as MonitoringModule;
}

function createInteractiveContext(): RequestCallContext {
  return createToolCallContext({
    progressToken: undefined,
    sendProgressNotification: async () => undefined,
    cancellationSignal: new AbortController().signal,
    logger: () => undefined,
  });
}

function createClient(mode: AuthenticationMode): { client: MattermostClient; tokenProvider: RecordingTokenProvider; http: FakeHttp } {
  const http = new FakeHttp(MONITORING_SCENARIO);
  const tokenProvider = new RecordingTokenProvider(mode, SESSION_TOKEN);
  const config: Config = { mattermostUrl: MATTERMOST_URL, token: mode === AUTHENTICATION_MODES.STATIC ? SESSION_TOKEN : '', teamId: TEAM_ID };
  const client = new MattermostClient({ config, tokenProvider, fetchImplementation: http.fetch });
  return { client, tokenProvider, http };
}

function readResultText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((item) => item.text).join('\n');
}

function countingLoader(monitoringConfig: MonitoringConfig | undefined): { load: () => MonitoringConfig | undefined; readonly callCount: number } {
  let callCount = 0;
  return {
    load: () => {
      callCount += 1;
      return monitoringConfig;
    },
    get callCount() {
      return callCount;
    },
  };
}

test('R1: two parallel run monitoring calls in browser mode start the monitor once', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const monitoring = await importFreshMonitoringModule();
  const startReleased = createDeferred<void>();
  const start = t.mock.method(TopicMonitor.prototype, 'start', async () => {
    await startReleased.promise;
  });
  const { client, http } = createClient(AUTHENTICATION_MODES.BROWSER);
  const loader = countingLoader(MONITORING_CONFIG);

  const calls = Promise.all([
    monitoring.handleRunMonitoring(client.withCallContext(createInteractiveContext()), {}, loader.load),
    monitoring.handleRunMonitoring(client.withCallContext(createInteractiveContext()), {}, loader.load),
  ]);
  /* Оба вызова прошли вход и проверку экземпляра, пока первый запуск ещё не завершён */
  await waitForCondition(() => http.records.filter((record) => record.url === CURRENT_USER_URL).length === 2);
  await waitForCondition(() => start.mock.callCount() > 0);
  await flushAsyncWork();
  startReleased.resolve();
  const results = await calls;

  for (const result of results) {
    assert.equal(result.isError, undefined, readResultText(result));
  }
  assert.equal(start.mock.callCount(), 1);
  assert.equal(loader.callCount, 2);
  assert.equal(http.records.filter((record) => record.url === CHANNELS_URL).length, 2);
});

test('R2: browser mode registers the monitor only after a successful start, so the tool retries after a failed start', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const monitoring = await importFreshMonitoringModule();
  let failingStartsLeft = 2;
  const start = t.mock.method(TopicMonitor.prototype, 'start', async () => {
    if (failingStartsLeft > 0) {
      failingStartsLeft -= 1;
      throw new Error(START_FAILURE_MESSAGE);
    }
  });
  const runNow = t.mock.method(TopicMonitor.prototype, 'runNow', async () => undefined);
  const { client, tokenProvider } = createClient(AUTHENTICATION_MODES.BROWSER);
  const loader = countingLoader(MONITORING_CONFIG);

  /* Как при старте сервера в index.ts: запуск без токена отклоняется */
  const startupMonitor = new TopicMonitor(client, MONITORING_CONFIG);
  await assert.rejects(monitoring.startAndRegisterTopicMonitor(startupMonitor, AUTHENTICATION_MODES.BROWSER), {
    message: START_FAILURE_MESSAGE,
  });

  const failedResult = await monitoring.handleRunMonitoring(client.withCallContext(createInteractiveContext()), {}, loader.load);
  assert.equal(failedResult.isError, true);
  assert.ok(readResultText(failedResult).includes(START_FAILURE_MESSAGE), readResultText(failedResult));

  const result = await monitoring.handleRunMonitoring(client.withCallContext(createInteractiveContext()), {}, loader.load);
  assert.equal(result.isError, undefined, readResultText(result));

  assert.equal(start.mock.callCount(), 3);
  assert.equal(loader.callCount, 2);
  assert.equal(runNow.mock.callCount(), 1);
  const startedMonitors = start.mock.calls.map((call) => call.this);
  assert.equal(startedMonitors[0], startupMonitor);
  assert.equal(new Set(startedMonitors).size, 3);
  assert.equal(runNow.mock.calls[0].this, startedMonitors[2]);
  assert.deepEqual(
    tokenProvider.calls.map((call) => [call.kind, call.callContext.interactive]),
    [
      [TOKEN_PROVIDER_CALL_KINDS.GET_TOKEN, true],
      [TOKEN_PROVIDER_CALL_KINDS.GET_TOKEN, true],
    ],
  );
});

test('R3: static mode registers the monitor before start as in 1.1.2, so the tool reuses it after a failed start', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const monitoring = await importFreshMonitoringModule();
  const start = t.mock.method(TopicMonitor.prototype, 'start', async () => {
    throw new Error(START_FAILURE_MESSAGE);
  });
  const runNow = t.mock.method(TopicMonitor.prototype, 'runNow', async () => undefined);
  const { client, tokenProvider, http } = createClient(AUTHENTICATION_MODES.STATIC);
  const loader = countingLoader(MONITORING_CONFIG);

  const startupMonitor = new TopicMonitor(client, MONITORING_CONFIG);
  await assert.rejects(monitoring.startAndRegisterTopicMonitor(startupMonitor, AUTHENTICATION_MODES.STATIC), {
    message: START_FAILURE_MESSAGE,
  });

  const result = await monitoring.handleRunMonitoring(client.withCallContext(createInteractiveContext()), {}, loader.load);

  assert.equal(result.isError, undefined, readResultText(result));
  assert.equal(start.mock.callCount(), 1);
  assert.equal(loader.callCount, 0);
  assert.equal(runNow.mock.callCount(), 1);
  assert.equal(runNow.mock.calls[0].this, startupMonitor);
  assert.equal(tokenProvider.calls.length, 0);
  assert.equal(http.records.length, 0);
});

test('R4: disabled monitoring returns the configuration error before any sign-in request', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const monitoring = await importFreshMonitoringModule();
  const start = t.mock.method(TopicMonitor.prototype, 'start', async () => undefined);

  for (const monitoringConfig of [{ ...MONITORING_CONFIG, enabled: false }, undefined]) {
    const { client, tokenProvider, http } = createClient(AUTHENTICATION_MODES.BROWSER);
    const loader = countingLoader(monitoringConfig);

    const result = await monitoring.handleRunMonitoring(client.withCallContext(createInteractiveContext()), {}, loader.load);

    assert.deepEqual(result, {
      content: [{ type: 'text', text: JSON.stringify({ error: DISABLED_MONITORING_ERROR }) }],
      isError: true,
    });
    assert.equal(loader.callCount, 1);
    assert.equal(tokenProvider.calls.length, 0);
    assert.equal(http.records.length, 0);
  }
  assert.equal(start.mock.callCount(), 0);
});
