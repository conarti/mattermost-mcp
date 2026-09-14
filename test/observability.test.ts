import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AUTHENTICATION_LOG_PREFIX } from '../src/authentication/constants.js';
import { createTokenProvider, createToolCallContext } from '../src/authentication/session.js';
import type { HttpFetch, HttpResponse } from '../src/types.js';
import { advanceClockUntilSettled, trackPromise } from './fixtures/asyncControl.js';
import { assertNoSecrets, assertOrderedFragments } from './fixtures/captureLogs.js';
import { FakeClock } from './fixtures/fakeClock.js';
import { FakeLoginBrowserContext, FakeLoginBrowserLauncher } from './fixtures/fakeLoginBrowser.js';
import { FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS } from './fixtures/fixtureConstants.js';
import { removeDirectories } from './fixtures/runProcess.js';

const START_MILLISECONDS = 1_000_000_000_000;
const FRESH_TOKEN = 'fresh-secret-token-0003';

const temporaryDirectories: string[] = [];

after(() => removeDirectories(temporaryDirectories));

function createResponse(status: number): HttpResponse {
  return {
    ok: status === 200,
    status,
    statusText: String(status),
    json: async () => ({ id: 'user-1' }),
    text: async () => '',
  };
}

test('O1: browser sign-in logs the expected lines to stderr without the token value', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async (t) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-observability-'));
  temporaryDirectories.push(homeDirectory);
  const clock = new FakeClock(START_MILLISECONDS);
  const errorOutput = t.mock.method(console, 'error', () => undefined);
  const browserContext = new FakeLoginBrowserContext({
    cookieSteps: [[], [{ name: 'MMAUTHTOKEN', value: FRESH_TOKEN, domain: 'chat.example.test' }]],
  });
  const fetchImplementation: HttpFetch = async (_url, request) =>
    createResponse(request.headers.Authorization === `Bearer ${FRESH_TOKEN}` ? 200 : 401);

  const provider = createTokenProvider(
    { mattermostUrl: 'https://chat.example.test/api/v4', token: '', teamId: 'team-test' },
    fetchImplementation,
    { homeDirectory, launcher: new FakeLoginBrowserLauncher(browserContext), clock },
  );
  const callContext = createToolCallContext({
    progressToken: undefined,
    sendProgressNotification: async () => undefined,
    cancellationSignal: new AbortController().signal,
    logger: () => undefined,
  });

  const tokenRequest = trackPromise(provider.getToken(callContext));
  await advanceClockUntilSettled(clock, tokenRequest, { maximumSteps: 20 });
  assert.equal(await tokenRequest.promise, FRESH_TOKEN);

  const printedLines = errorOutput.mock.calls.map((call) => call.arguments.map(String).join(' '));
  const authenticationLines = printedLines.filter((line) => line.startsWith(`${AUTHENTICATION_LOG_PREFIX} `));
  assertOrderedFragments(authenticationLines, [
    '[auth] no token file, sign-in required',
    '[auth] login lock acquired, opening browser window https://chat.example.test/login',
    '[auth] session token saved',
  ]);
  assert.equal(browserContext.cookieReadCount, 2);
  assertNoSecrets(printedLines, [FRESH_TOKEN]);
});
