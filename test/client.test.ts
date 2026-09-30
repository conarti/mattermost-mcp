import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { after, test } from 'node:test';
import { inspect } from 'node:util';
import {
  AUTHENTICATION_ERROR_CODES,
  AUTHENTICATION_MODES,
  JSON_CONTENT_TYPE,
  SESSION_COOKIE_NAME,
} from '../src/authentication/constants.js';
import { MattermostAuthenticationError } from '../src/authentication/runtime.js';
import {
  BACKGROUND_CALL_CONTEXT,
  RequestCallContext,
  StaticTokenProvider,
  TokenProvider,
  createTokenProvider,
  createToolCallContext,
} from '../src/authentication/session.js';
import { createFileTokenStore, resolveStatePaths } from '../src/authentication/stateFiles.js';
import { MattermostClient, MattermostRequestError } from '../src/client.js';
import type { AuthenticationMode, Config } from '../src/config.js';
import type { HttpFetch } from '../src/types.js';
import { advanceClockUntilSettled, trackPromise, waitForCondition } from './fixtures/asyncControl.js';
import { assertNoSecrets, createLogCapture } from './fixtures/captureLogs.js';
import { FakeClock } from './fixtures/fakeClock.js';
import { FakeHttp, FakeHttpRecord, FakeHttpReply, createTokenScenario } from './fixtures/fakeHttp.js';
import { FakeLoginBrowserContext, FakeLoginBrowserLauncher } from './fixtures/fakeLoginBrowser.js';
import { FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS } from './fixtures/fixtureConstants.js';
import { removeDirectories } from './fixtures/runProcess.js';

const START_MILLISECONDS = 1_000_000_000_000;
const SITE_URL = 'https://chat.example.test';
const MATTERMOST_URL = `${SITE_URL}/api/v4`;
const SITE_HOSTNAME = new URL(SITE_URL).hostname;
const TEAM_ID = 'team-test';
const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const STATIC_TOKEN = 'static-secret-token-0001';
const EXPIRED_TOKEN = 'expired-secret-token-0002';
const FRESH_TOKEN = 'fresh-secret-token-0003';
const FIRST_PROVIDER_TOKEN = 'first-provider-token';
const SECOND_PROVIDER_TOKEN = 'second-provider-token';
const SESSION_EXPIRED_BODY = '{"id":"api.context.session_expired.app_error"}';
const STILL_UNAUTHORIZED_LOG_LINE = '[auth] request still unauthorized after sign-in';
const REQUEST_CANCELLED_LOG_LINE = '[auth] caller cancelled, request not sent';
const SERVER_ERROR_BODY = '{"id":"app.internal_failure"}';
const CHANNEL_ID = 'channel-1';
const FILE_ID = 'file-1';
const FILE_URL = `${MATTERMOST_URL}/files/${FILE_ID}`;
const FILE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0x0a]);
const NON_API_MEMBER_NAMES = [
  'constructor',
  'withCallContext',
  'request',
  'authorizedSend',
  'requestBinary',
  'throwIfCallCancelled',
  'send',
  'createFailureError',
];

const CONFIG: Config = { mattermostUrl: MATTERMOST_URL, token: '', teamId: TEAM_ID };
const SUCCESS_REPLY: FakeHttpReply = { status: 200, body: { id: USER_ID, order: [], posts: {} } };
const UNAUTHORIZED_REPLY: FakeHttpReply = { status: 401 };

const temporaryDirectories: string[] = [];

after(() => removeDirectories(temporaryDirectories));

async function createTemporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-client-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

class ScriptedTokenProvider implements TokenProvider {
  readonly getTokenContexts: RequestCallContext[] = [];
  readonly recoverCalls: Array<{ rejectedToken: string; callContext: RequestCallContext }> = [];

  constructor(
    readonly mode: AuthenticationMode,
    public currentToken: string,
    private readonly recoveredToken: string | undefined,
  ) {}

  async getToken(callContext: RequestCallContext): Promise<string> {
    this.getTokenContexts.push(callContext);
    return this.currentToken;
  }

  async recoverFromUnauthorized(rejectedToken: string, callContext: RequestCallContext): Promise<string | undefined> {
    this.recoverCalls.push({ rejectedToken, callContext });
    return this.recoveredToken;
  }
}

function createInteractiveContext(): RequestCallContext {
  return createToolCallContext({
    progressToken: undefined,
    sendProgressNotification: async () => undefined,
    cancellationSignal: new AbortController().signal,
    logger: () => undefined,
  });
}

function createClient(tokenProvider: TokenProvider, http: FakeHttp): MattermostClient {
  return new MattermostClient({ config: CONFIG, tokenProvider, fetchImplementation: http.fetch });
}

function describeRequests(records: readonly FakeHttpRecord[]): Array<Pick<FakeHttpRecord, 'method' | 'url' | 'body'>> {
  return records.map(({ method, url, body }) => ({ method, url, body }));
}

function printedLines(calls: ReadonlyArray<{ arguments: unknown[] }>): string[] {
  return calls.map((call) => call.arguments.map(String).join(' '));
}

interface PublicMethodCall {
  name: string;
  call: (client: MattermostClient) => Promise<unknown>;
  expectedRequests: Array<Pick<FakeHttpRecord, 'method' | 'url' | 'body'>>;
  /** Текст ошибки, когда последний запрос метода получил 500 с телом SERVER_ERROR_BODY: у методов 1.1.2 это их текст из git show 3c6dd0d:src/client.ts, у новых методов текст в том же формате */
  serverErrorMessage: string;
}

const SERVER_ERROR_STATUS_DESCRIPTION = '500 Internal Server Error';

const PUBLIC_METHOD_CALLS: readonly PublicMethodCall[] = [
  {
    name: 'getChannels',
    call: (client) => client.getChannels(),
    expectedRequests: [{ method: 'GET', url: `${MATTERMOST_URL}/teams/${TEAM_ID}/channels?page=0&per_page=100`, body: undefined }],
    serverErrorMessage: `Failed to get channels: ${SERVER_ERROR_STATUS_DESCRIPTION} - ${SERVER_ERROR_BODY}`,
  },
  {
    name: 'getChannel',
    call: (client) => client.getChannel('channel-1'),
    expectedRequests: [{ method: 'GET', url: `${MATTERMOST_URL}/channels/channel-1`, body: undefined }],
    serverErrorMessage: `Failed to get channel: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'createPost',
    call: (client) => client.createPost('channel-1', 'hello', 'root-1'),
    expectedRequests: [
      { method: 'POST', url: `${MATTERMOST_URL}/posts`, body: '{"channel_id":"channel-1","message":"hello","root_id":"root-1"}' },
    ],
    serverErrorMessage: `Failed to create post: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'getPostsForChannel',
    call: (client) => client.getPostsForChannel('channel-1', 10, 2, { since: 1_700_000_000_000, before: 'post-0', after: 'post-9' }),
    expectedRequests: [
      {
        method: 'GET',
        url: `${MATTERMOST_URL}/channels/channel-1/posts?page=2&per_page=10&since=1700000000000&before=post-0&after=post-9`,
        body: undefined,
      },
    ],
    serverErrorMessage: `Failed to get posts: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'getAllPostsForChannel',
    call: (client) => client.getAllPostsForChannel('channel-1'),
    expectedRequests: [{ method: 'GET', url: `${MATTERMOST_URL}/channels/channel-1/posts?page=0&per_page=200`, body: undefined }],
    serverErrorMessage: `Failed to get posts: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'getPost',
    call: (client) => client.getPost('post-1'),
    expectedRequests: [{ method: 'GET', url: `${MATTERMOST_URL}/posts/post-1`, body: undefined }],
    serverErrorMessage: `Failed to get post: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'patchPost',
    call: (client) => client.patchPost('post-1', 'edited'),
    expectedRequests: [{ method: 'PUT', url: `${MATTERMOST_URL}/posts/post-1/patch`, body: '{"message":"edited"}' }],
    serverErrorMessage: `Failed to edit post: ${SERVER_ERROR_STATUS_DESCRIPTION} - ${SERVER_ERROR_BODY}`,
  },
  {
    name: 'getPostThread',
    call: (client) => client.getPostThread('post-1'),
    expectedRequests: [{ method: 'GET', url: `${MATTERMOST_URL}/posts/post-1/thread`, body: undefined }],
    serverErrorMessage: `Failed to get post thread: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'getFileInfo',
    call: (client) => client.getFileInfo(FILE_ID),
    expectedRequests: [{ method: 'GET', url: `${FILE_URL}/info`, body: undefined }],
    serverErrorMessage: `Failed to get file info: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'downloadFile',
    call: (client) => client.downloadFile(FILE_ID),
    expectedRequests: [{ method: 'GET', url: FILE_URL, body: undefined }],
    serverErrorMessage: `Failed to download file: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'addReaction',
    call: (client) => client.addReaction('post-1', 'thumbsup'),
    expectedRequests: [{ method: 'POST', url: `${MATTERMOST_URL}/reactions`, body: '{"post_id":"post-1","emoji_name":"thumbsup"}' }],
    serverErrorMessage: `Failed to add reaction: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'getUsers',
    call: (client) => client.getUsers(),
    expectedRequests: [{ method: 'GET', url: `${MATTERMOST_URL}/users?page=0&per_page=100`, body: undefined }],
    serverErrorMessage: `Failed to get users: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'getUserProfile',
    call: (client) => client.getUserProfile(OTHER_USER_ID),
    expectedRequests: [{ method: 'GET', url: `${MATTERMOST_URL}/users/${OTHER_USER_ID}`, body: undefined }],
    serverErrorMessage: `Failed to get user profile: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'getMe',
    call: (client) => client.getMe(),
    expectedRequests: [{ method: 'GET', url: `${MATTERMOST_URL}/users/me`, body: undefined }],
    serverErrorMessage: `Failed to get current user: ${SERVER_ERROR_STATUS_DESCRIPTION}`,
  },
  {
    name: 'getMyChannels',
    call: (client) => client.getMyChannels(),
    expectedRequests: [{ method: 'GET', url: `${MATTERMOST_URL}/users/me/channels?page=0&per_page=100`, body: undefined }],
    serverErrorMessage: `Failed to get user channels: ${SERVER_ERROR_STATUS_DESCRIPTION} - ${SERVER_ERROR_BODY}`,
  },
  {
    name: 'createDirectMessageChannel',
    call: (client) => client.createDirectMessageChannel(OTHER_USER_ID),
    expectedRequests: [
      { method: 'GET', url: `${MATTERMOST_URL}/users/me`, body: undefined },
      { method: 'POST', url: `${MATTERMOST_URL}/channels/direct`, body: `["${USER_ID}","${OTHER_USER_ID}"]` },
    ],
    serverErrorMessage: `Failed to create direct message channel: ${SERVER_ERROR_STATUS_DESCRIPTION} - ${SERVER_ERROR_BODY}`,
  },
];

test('C1: every public method sends the current provider token and keeps its request shape', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const prototypeMethodNames = Object.getOwnPropertyNames(MattermostClient.prototype).filter(
    (name) =>
      typeof Object.getOwnPropertyDescriptor(MattermostClient.prototype, name)?.value === 'function' &&
      !NON_API_MEMBER_NAMES.includes(name),
  );
  assert.equal(PUBLIC_METHOD_CALLS.length, 16);
  assert.deepEqual([...prototypeMethodNames].sort(), PUBLIC_METHOD_CALLS.map(({ name }) => name).sort());

  const provider = new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, FIRST_PROVIDER_TOKEN, undefined);
  const http = new FakeHttp(
    createTokenScenario({ [FIRST_PROVIDER_TOKEN]: SUCCESS_REPLY, [SECOND_PROVIDER_TOKEN]: SUCCESS_REPLY }, UNAUTHORIZED_REPLY),
  );
  const client = createClient(provider, http);

  for (const currentToken of [FIRST_PROVIDER_TOKEN, SECOND_PROVIDER_TOKEN]) {
    provider.currentToken = currentToken;
    for (const { name, call, expectedRequests } of PUBLIC_METHOD_CALLS) {
      const firstRecordIndex = http.records.length;
      await call(client);
      const newRecords = http.records.slice(firstRecordIndex);
      assert.deepEqual(describeRequests(newRecords), expectedRequests, name);
      assert.deepEqual(
        newRecords.map((record) => record.redirect),
        expectedRequests.map(() => undefined),
        name,
      );
      assert.deepEqual(
        newRecords.map((record) => record.authorization),
        expectedRequests.map(() => `Bearer ${currentToken}`),
        name,
      );
    }
  }

  assert.equal(provider.recoverCalls.length, 0);
  assert.ok(provider.getTokenContexts.every((callContext) => callContext === BACKGROUND_CALL_CONTEXT));

  const interactiveContext = createInteractiveContext();
  const view = client.withCallContext(interactiveContext);
  assert.equal(view.authenticationMode, AUTHENTICATION_MODES.BROWSER);
  await view.getMe();
  assert.equal(provider.getTokenContexts.at(-1), interactiveContext);
  await client.getMe();
  assert.equal(provider.getTokenContexts.at(-1), BACKGROUND_CALL_CONTEXT);
});

test('C2: a second 401 after the single retry gives UNAUTHORIZED_AFTER_RETRY', async (t) => {
  const errorOutput = t.mock.method(console, 'error', () => undefined);
  const interactiveContext = createInteractiveContext();

  const recoveringProvider = new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, EXPIRED_TOKEN, FRESH_TOKEN);
  const recoveringHttp = new FakeHttp(createTokenScenario({ [FRESH_TOKEN]: SUCCESS_REPLY }, UNAUTHORIZED_REPLY));
  const recoveredUser = await createClient(recoveringProvider, recoveringHttp).withCallContext(interactiveContext).getMe();
  assert.equal(recoveredUser.id, USER_ID);
  assert.deepEqual(
    recoveringHttp.records.map((record) => record.authorization),
    [`Bearer ${EXPIRED_TOKEN}`, `Bearer ${FRESH_TOKEN}`],
  );
  assert.equal(recoveringProvider.recoverCalls.length, 1);

  const provider = new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, EXPIRED_TOKEN, FRESH_TOKEN);
  const http = new FakeHttp(() => UNAUTHORIZED_REPLY);
  const view = createClient(provider, http).withCallContext(interactiveContext);

  await assert.rejects(view.getMe(), (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, AUTHENTICATION_ERROR_CODES.UNAUTHORIZED_AFTER_RETRY);
    assert.equal(error.message, '[UNAUTHORIZED_AFTER_RETRY] Failed to get current user: 401 Unauthorized after sign-in');
    return true;
  });
  assert.equal(http.records.length, 2);
  assert.deepEqual(
    http.records.map((record) => record.authorization),
    [`Bearer ${EXPIRED_TOKEN}`, `Bearer ${FRESH_TOKEN}`],
  );
  assert.equal(provider.recoverCalls.length, 1);
  assert.equal(provider.recoverCalls[0].rejectedToken, EXPIRED_TOKEN);
  assert.equal(provider.recoverCalls[0].callContext, interactiveContext);
  assert.equal(provider.getTokenContexts[0], interactiveContext);
  assert.equal(printedLines(errorOutput.mock.calls).filter((line) => line === STILL_UNAUTHORIZED_LOG_LINE).length, 1);
});

test('C3: 403 and 500 responses keep the previous error texts without a sign-in attempt', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const provider = new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, FRESH_TOKEN, FRESH_TOKEN);
  const http = new FakeHttp(() => UNAUTHORIZED_REPLY);
  const client = createClient(provider, http);

  const cases: Array<{ reply: FakeHttpReply; call: () => Promise<unknown>; expectedMessage: string }> = [
    {
      reply: { status: 403, body: 'forbidden body' },
      call: () => client.getChannel('channel-1'),
      expectedMessage: 'Failed to get channel: 403 Forbidden',
    },
    {
      reply: { status: 500, body: 'internal failure' },
      call: () => client.getChannels(),
      expectedMessage: 'Failed to get channels: 500 Internal Server Error - internal failure',
    },
    {
      reply: { status: 403, body: '{"id":"api.context.permissions.app_error"}' },
      call: () => client.getMyChannels(),
      expectedMessage: 'Failed to get user channels: 403 Forbidden - {"id":"api.context.permissions.app_error"}',
    },
    {
      reply: { status: 500 },
      call: () => client.createPost('channel-1', 'hello'),
      expectedMessage: 'Failed to create post: 500 Internal Server Error',
    },
  ];

  for (const { reply, call, expectedMessage } of cases) {
    http.setScenario(() => reply);
    const firstRecordIndex = http.records.length;
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof MattermostAuthenticationError, false);
      assert.equal(error.message, expectedMessage);
      return true;
    });
    assert.equal(http.records.length - firstRecordIndex, 1, expectedMessage);
  }
  assert.equal(provider.recoverCalls.length, 0);
});

test('C4: static mode returns the 1.1.2 error for 401 after one request and never creates the state directory', async (t) => {
  const errorOutput = t.mock.method(console, 'error', () => undefined);
  const homeDirectory = await createTemporaryHome();
  const staticConfig: Config = { ...CONFIG, token: STATIC_TOKEN };
  const http = new FakeHttp(() => ({ status: 401, body: SESSION_EXPIRED_BODY }));
  const tokenProvider = createTokenProvider(staticConfig, http.fetch, { homeDirectory });
  assert.ok(tokenProvider instanceof StaticTokenProvider);
  const client = new MattermostClient({ config: staticConfig, tokenProvider, fetchImplementation: http.fetch });
  assert.equal(client.authenticationMode, AUTHENTICATION_MODES.STATIC);

  await assert.rejects(client.getChannels(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `Failed to get channels: 401 Unauthorized - ${SESSION_EXPIRED_BODY}`);
    return true;
  });
  assert.equal(http.records.length, 1);
  assert.equal(http.records[0].authorization, `Bearer ${STATIC_TOKEN}`);
  assert.deepEqual(printedLines(errorOutput.mock.calls), [
    `Fetching channels from URL: ${MATTERMOST_URL}/teams/${TEAM_ID}/channels?page=0&per_page=100`,
    'Response status: 401 Unauthorized',
    `Error response body: ${SESSION_EXPIRED_BODY}`,
    `Error fetching channels: Failed to get channels: 401 Unauthorized - ${SESSION_EXPIRED_BODY}`,
  ]);

  await assert.rejects(client.withCallContext(createInteractiveContext()).getChannel('channel-1'), {
    message: 'Failed to get channel: 401 Unauthorized',
  });
  assert.equal(http.records.length, 2);
  assert.equal(await pathExists(join(homeDirectory, '.config', 'mattermost-mcp')), false);

  const defaultProviderHttp = new FakeHttp(() => ({ status: 401, body: SESSION_EXPIRED_BODY }));
  const defaultProviderClient = new MattermostClient({ config: staticConfig, fetchImplementation: defaultProviderHttp.fetch });
  assert.equal(defaultProviderClient.authenticationMode, AUTHENTICATION_MODES.STATIC);
  await assert.rejects(defaultProviderClient.getMyChannels(), {
    message: `Failed to get user channels: 401 Unauthorized - ${SESSION_EXPIRED_BODY}`,
  });
  assert.equal(defaultProviderHttp.records.length, 1);
});

test('C5: token values never reach logs, error messages or inspected errors', async (t) => {
  const errorOutput = t.mock.method(console, 'error', () => undefined);
  const errors: unknown[] = [];
  const collectError = async (operation: Promise<unknown>): Promise<void> => {
    await assert.rejects(
      operation.catch((error: unknown) => {
        errors.push(error);
        throw error;
      }),
    );
  };

  const staticHttp = new FakeHttp(() => ({ status: 401, body: SESSION_EXPIRED_BODY }));
  const staticClient = createClient(new StaticTokenProvider(STATIC_TOKEN), staticHttp);
  await collectError(staticClient.getChannels());
  await collectError(staticClient.getMyChannels());

  const retryHttp = new FakeHttp(() => ({ status: 401, body: SESSION_EXPIRED_BODY }));
  const retryProvider = new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, EXPIRED_TOKEN, FRESH_TOKEN);
  const retryClient = createClient(retryProvider, retryHttp).withCallContext(createInteractiveContext());
  await collectError(retryClient.getChannels());
  await collectError(retryClient.createDirectMessageChannel(OTHER_USER_ID));

  const failureHttp = new FakeHttp(() => ({ status: 500, body: 'internal failure' }));
  const failureClient = createClient(new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, FRESH_TOKEN, FRESH_TOKEN), failureHttp);
  await collectError(failureClient.getChannels());
  await collectError(failureClient.createDirectMessageChannel(OTHER_USER_ID));

  const sentAuthorizations = [...staticHttp.records, ...retryHttp.records, ...failureHttp.records].map(
    (record) => record.authorization,
  );
  for (const token of [STATIC_TOKEN, EXPIRED_TOKEN, FRESH_TOKEN]) {
    assert.ok(sentAuthorizations.includes(`Bearer ${token}`), 'the fake server received every token');
  }

  const logLines = printedLines(errorOutput.mock.calls);
  assert.ok(logLines.includes(STILL_UNAUTHORIZED_LOG_LINE));
  assert.equal(errors.length, 6);
  const errorTexts = errors.flatMap((error) => [error instanceof Error ? error.message : String(error), inspect(error)]);
  assertNoSecrets([...logLines, ...errorTexts], [STATIC_TOKEN, EXPIRED_TOKEN, FRESH_TOKEN]);
});

test('C6: two call views that get 401 at the same time share one browser sign-in', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const homeDirectory = await createTemporaryHome();
  const clock = new FakeClock(START_MILLISECONDS);
  const logs = createLogCapture();
  const browserContext = new FakeLoginBrowserContext({
    cookieSteps: [[], [], [{ name: SESSION_COOKIE_NAME, value: FRESH_TOKEN, domain: SITE_HOSTNAME }]],
  });
  const launcher = new FakeLoginBrowserLauncher(browserContext);
  const http = new FakeHttp(createTokenScenario({ [FRESH_TOKEN]: { status: 200, body: { id: USER_ID } } }, UNAUTHORIZED_REPLY));
  const tokenProvider = createTokenProvider(CONFIG, http.fetch, { homeDirectory, launcher, clock, logger: logs.logger });
  await createFileTokenStore(resolveStatePaths(homeDirectory), () => undefined).writeToken(SITE_URL, EXPIRED_TOKEN);
  const client = new MattermostClient({ config: CONFIG, tokenProvider, fetchImplementation: http.fetch });
  assert.equal(client.authenticationMode, AUTHENTICATION_MODES.BROWSER);

  const firstCall = trackPromise(client.withCallContext(createInteractiveContext()).getMe());
  const secondCall = trackPromise(client.withCallContext(createInteractiveContext()).getMe());
  await waitForCondition(() => logs.count('joining sign-in already in progress') === 1);
  assert.equal(firstCall.settled || secondCall.settled, false);

  const bothCalls = trackPromise(Promise.all([firstCall.promise, secondCall.promise]));
  await advanceClockUntilSettled(clock, bothCalls, { maximumSteps: 20 });
  const results = await bothCalls.promise;

  assert.deepEqual(
    results.map((user) => user.id),
    [USER_ID, USER_ID],
  );
  assert.equal(launcher.launchCalls.length, 1);
  assert.equal(logs.count('401 received, checking token file'), 2);
  const rejectedRequests = http.records.filter(
    (record) => record.url === `${MATTERMOST_URL}/users/me` && record.authorization === `Bearer ${EXPIRED_TOKEN}`,
  );
  assert.equal(rejectedRequests.length, 2);
  /* Редиректы выключены только у проверки токена из окна входа, запросы клиента идут как в 1.1.2 */
  const validationRequests = http.records.filter((record) => record.redirect === 'manual');
  assert.equal(validationRequests.length, 1);
  assert.equal(validationRequests[0].url, `${MATTERMOST_URL}/users/me`);
  assert.equal(http.records.filter((record) => record.redirect !== 'manual' && record.redirect !== undefined).length, 0);
});

test('C7: a call cancelled while waiting for sign-in sends no action request, and the sign-in still saves the token', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async (t) => {
  const errorOutput = t.mock.method(console, 'error', () => undefined);
  const postsUrl = `${MATTERMOST_URL}/posts`;
  const cases = [
    { description: 'without a token file the wait is in getToken', storedToken: undefined, expectedPostRequestCount: 0 },
    { description: 'with an expired token the wait is in recoverFromUnauthorized', storedToken: EXPIRED_TOKEN, expectedPostRequestCount: 1 },
  ];

  for (const { description, storedToken, expectedPostRequestCount } of cases) {
    const homeDirectory = await createTemporaryHome();
    const clock = new FakeClock(START_MILLISECONDS);
    const logs = createLogCapture();
    const launcher = new FakeLoginBrowserLauncher(
      new FakeLoginBrowserContext({ cookieSteps: [[], [], [{ name: SESSION_COOKIE_NAME, value: FRESH_TOKEN, domain: SITE_HOSTNAME }]] }),
    );
    const http = new FakeHttp(createTokenScenario({ [FRESH_TOKEN]: { status: 200, body: { id: USER_ID } } }, UNAUTHORIZED_REPLY));
    const tokenProvider = createTokenProvider(CONFIG, http.fetch, { homeDirectory, launcher, clock, logger: logs.logger });
    const tokenStore = createFileTokenStore(resolveStatePaths(homeDirectory), () => undefined);
    if (storedToken !== undefined) {
      await tokenStore.writeToken(SITE_URL, storedToken);
    }
    const client = new MattermostClient({ config: CONFIG, tokenProvider, fetchImplementation: http.fetch });
    const cancellation = new AbortController();
    const callContext = createToolCallContext({
      progressToken: undefined,
      sendProgressNotification: async () => undefined,
      cancellationSignal: cancellation.signal,
      logger: logs.logger,
    });
    const cancelledLogCountBefore = printedLines(errorOutput.mock.calls).filter((line) => line === REQUEST_CANCELLED_LOG_LINE).length;

    const call = trackPromise(client.withCallContext(callContext).createPost(CHANNEL_ID, 'hello'));
    await waitForCondition(() => launcher.launchCalls.length === 1);
    cancellation.abort();
    await advanceClockUntilSettled(clock, call, { maximumSteps: 20 });

    assert.ok(call.error instanceof MattermostAuthenticationError, `${description}: ${String(call.error ?? call.value)}`);
    assert.equal(call.error.code, AUTHENTICATION_ERROR_CODES.REQUEST_CANCELLED, description);
    assert.equal(call.error.message, '[REQUEST_CANCELLED] Failed to create post: request cancelled by caller', description);
    assert.equal(http.records.filter((record) => record.url === postsUrl).length, expectedPostRequestCount, description);
    assert.equal(logs.count('session token saved'), 1, description);
    assert.equal(await tokenStore.readToken(SITE_URL), FRESH_TOKEN, description);
    assert.equal(
      printedLines(errorOutput.mock.calls).filter((line) => line === REQUEST_CANCELLED_LOG_LINE).length - cancelledLogCountBefore,
      1,
      description,
    );
  }
});

test('C8: browser mode passes the call cancellation signal to HTTP requests, static mode ignores cancellation as in 1.1.2', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const cancellation = new AbortController();
  const callContext = createToolCallContext({
    progressToken: undefined,
    sendProgressNotification: async () => undefined,
    cancellationSignal: cancellation.signal,
    logger: () => undefined,
  });

  const browserHttp = new FakeHttp(() => SUCCESS_REPLY);
  const browserClient = createClient(new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, FRESH_TOKEN, undefined), browserHttp);
  await browserClient.withCallContext(callContext).getMe();
  await browserClient.getMe();
  assert.deepEqual(
    browserHttp.records.map((record) => record.signal),
    [cancellation.signal, undefined],
  );

  const staticHttp = new FakeHttp(() => SUCCESS_REPLY);
  const staticClient = createClient(new StaticTokenProvider(STATIC_TOKEN), staticHttp);
  cancellation.abort();
  await staticClient.withCallContext(callContext).createPost(CHANNEL_ID, 'hello');
  assert.equal(staticHttp.records.length, 1);
  assert.equal(staticHttp.records[0].signal, undefined);

  await assert.rejects(browserClient.withCallContext(callContext).createPost(CHANNEL_ID, 'hello'), {
    code: AUTHENTICATION_ERROR_CODES.REQUEST_CANCELLED,
  });
  assert.equal(browserHttp.records.length, 2);
});

test('C9: a 500 response with a body keeps the 1.1.2 error text of every public method in both modes', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const providers: TokenProvider[] = [
    new StaticTokenProvider(STATIC_TOKEN),
    new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, FRESH_TOKEN, FRESH_TOKEN),
  ];

  for (const tokenProvider of providers) {
    for (const { name, call, expectedRequests, serverErrorMessage } of PUBLIC_METHOD_CALLS) {
      const failingRequest = expectedRequests[expectedRequests.length - 1];
      const http = new FakeHttp((_token, record) =>
        record.method === failingRequest.method && record.url === failingRequest.url
          ? { status: 500, body: SERVER_ERROR_BODY }
          : SUCCESS_REPLY,
      );
      const description = `${tokenProvider.mode} ${name}`;

      await assert.rejects(call(createClient(tokenProvider, http)), (error: unknown) => {
        assert.ok(error instanceof Error, description);
        assert.equal(error instanceof MattermostAuthenticationError, false, description);
        assert.equal(error.message, serverErrorMessage, description);
        return true;
      });
      assert.deepEqual(describeRequests(http.records), expectedRequests, description);
    }
  }
});

test('C10: downloadFile streams the body after one sign-in retry, drains the rejected body and fails after a second 401', async (t) => {
  const errorOutput = t.mock.method(console, 'error', () => undefined);
  const interactiveContext = createInteractiveContext();
  const recoveringProvider = new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, EXPIRED_TOKEN, FRESH_TOKEN);
  const recoveringHttp = new FakeHttp(
    createTokenScenario({ [FRESH_TOKEN]: { status: 200, body: FILE_BYTES } }, { status: 401, body: SESSION_EXPIRED_BODY }),
  );
  const drainedStatuses: number[] = [];
  const drainingFetch: HttpFetch = async (url, request) => {
    const response = await recoveringHttp.fetch(url, request);
    return {
      ...response,
      text: async () => {
        drainedStatuses.push(response.status);
        return response.text();
      },
    };
  };
  const recoveringClient = new MattermostClient({
    config: CONFIG,
    tokenProvider: recoveringProvider,
    fetchImplementation: drainingFetch,
  }).withCallContext(interactiveContext);

  const body = await recoveringClient.downloadFile(FILE_ID);

  assert.deepEqual(new Uint8Array(await buffer(body)), FILE_BYTES);
  assert.equal(recoveringProvider.recoverCalls.length, 1);
  assert.equal(recoveringProvider.recoverCalls[0].rejectedToken, EXPIRED_TOKEN);
  assert.deepEqual(drainedStatuses, [401]);
  assert.deepEqual(
    recoveringHttp.records.map((record) => record.authorization),
    [`Bearer ${EXPIRED_TOKEN}`, `Bearer ${FRESH_TOKEN}`],
  );

  const provider = new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, EXPIRED_TOKEN, FRESH_TOKEN);
  const http = new FakeHttp(() => UNAUTHORIZED_REPLY);
  await assert.rejects(createClient(provider, http).withCallContext(interactiveContext).downloadFile(FILE_ID), (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, AUTHENTICATION_ERROR_CODES.UNAUTHORIZED_AFTER_RETRY);
    assert.equal(error.message, '[UNAUTHORIZED_AFTER_RETRY] Failed to download file: 401 Unauthorized after sign-in');
    return true;
  });
  assert.equal(http.records.length, 2);
  assert.equal(provider.recoverCalls.length, 1);
  assert.equal(printedLines(errorOutput.mock.calls).filter((line) => line === STILL_UNAUTHORIZED_LOG_LINE).length, 1);
});

test('C11: a downloadFile call cancelled before sending sends no request', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const cancellation = new AbortController();
  cancellation.abort();
  const callContext = createToolCallContext({
    progressToken: undefined,
    sendProgressNotification: async () => undefined,
    cancellationSignal: cancellation.signal,
    logger: () => undefined,
  });
  const http = new FakeHttp(() => ({ status: 200, body: FILE_BYTES }));
  const client = createClient(new ScriptedTokenProvider(AUTHENTICATION_MODES.BROWSER, FRESH_TOKEN, undefined), http);

  await assert.rejects(client.withCallContext(callContext).downloadFile(FILE_ID), (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, AUTHENTICATION_ERROR_CODES.REQUEST_CANCELLED);
    assert.equal(error.message, '[REQUEST_CANCELLED] Failed to download file: request cancelled by caller');
    return true;
  });
  assert.equal(http.records.length, 0);
});

test('C12: the binary download sends no JSON Content-Type while JSON requests keep it', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp((_token, record) => (record.url === FILE_URL ? { status: 200, body: FILE_BYTES } : SUCCESS_REPLY));
  const client = createClient(new StaticTokenProvider(STATIC_TOKEN), http);

  await client.getFileInfo(FILE_ID);
  await buffer(await client.downloadFile(FILE_ID));
  await client.createPost(CHANNEL_ID, 'hello');

  assert.deepEqual(
    http.records.map(({ url, contentType }) => ({ url, contentType })),
    [
      { url: `${FILE_URL}/info`, contentType: JSON_CONTENT_TYPE },
      { url: FILE_URL, contentType: undefined },
      { url: `${MATTERMOST_URL}/posts`, contentType: JSON_CONTENT_TYPE },
    ],
  );
});

test('C13: failed responses carry the HTTP status in MattermostRequestError without changing the message', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const http = new FakeHttp(() => UNAUTHORIZED_REPLY);
  const client = createClient(new StaticTokenProvider(STATIC_TOKEN), http);
  const cases = [
    { status: 404, call: () => client.getFileInfo(FILE_ID), expectedMessage: 'Failed to get file info: 404 Not Found' },
    { status: 403, call: () => client.downloadFile(FILE_ID), expectedMessage: 'Failed to download file: 403 Forbidden' },
    {
      status: 403,
      call: () => client.getMyChannels(),
      expectedMessage: `Failed to get user channels: 403 Forbidden - ${SERVER_ERROR_BODY}`,
    },
  ];

  for (const { status, call, expectedMessage } of cases) {
    http.setScenario(() => ({ status, body: SERVER_ERROR_BODY }));
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof MattermostRequestError, expectedMessage);
      assert.equal(error.status, status, expectedMessage);
      assert.equal(error.message, expectedMessage);
      return true;
    });
  }
});
