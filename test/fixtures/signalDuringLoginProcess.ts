/**
 * Держатель login.lock с открытым фейковым окном входа, которое не отдаёт cookie.
 * Печатает строку waiting, когда появился login.lock, и ждёт сигнала от теста.
 */
import { existsSync } from 'node:fs';
import { createStderrAuthenticationLogger, installProcessShutdownHandlers } from '../../src/authentication/runtime.js';
import { createTokenProvider, createToolCallContext } from '../../src/authentication/session.js';
import { resolveStatePaths } from '../../src/authentication/stateFiles.js';
import type { Config } from '../../src/config.js';
import type { HttpFetch } from '../../src/types.js';
import { FakeLoginBrowserContext, FakeLoginBrowserLauncher } from './fakeLoginBrowser.js';
import {
  FIXTURE_FILE_POLL_INTERVAL_MILLISECONDS,
  FIXTURE_MATTERMOST_URL,
  FIXTURE_OUTPUT_LINES,
  FIXTURE_TEAM_ID,
  OUTPUT_LINE_SEPARATOR,
  SIGNAL_DURING_LOGIN_FIXTURE_MODES,
} from './fixtureConstants.js';

const FIXTURE_FAILURE_EXIT_CODE = 2;

const [homeDirectory, mode] = process.argv.slice(2);
if (!Object.values<string>(SIGNAL_DURING_LOGIN_FIXTURE_MODES).includes(mode)) {
  process.stderr.write(`unknown signal during login fixture mode ${mode}\n`);
  process.exit(FIXTURE_FAILURE_EXIT_CODE);
}

const config: Config = { mattermostUrl: FIXTURE_MATTERMOST_URL, token: '', teamId: FIXTURE_TEAM_ID };
const offlineFetch: HttpFetch = async () => {
  throw new Error('network is disabled in the signal fixture');
};
const logger = createStderrAuthenticationLogger();
const tokenProvider = createTokenProvider(config, offlineFetch, {
  homeDirectory,
  launcher: new FakeLoginBrowserLauncher(new FakeLoginBrowserContext({ cookieSteps: [[]] })),
  logger,
});

installProcessShutdownHandlers(() => {
  if (mode === SIGNAL_DURING_LOGIN_FIXTURE_MODES.THROWING_SHUTDOWN) {
    throw new Error('shutdown callback failed in the signal fixture');
  }
});

const { loginLockPath } = resolveStatePaths(homeDirectory);
const lockPollHandle = setInterval(() => {
  if (existsSync(loginLockPath)) {
    clearInterval(lockPollHandle);
    process.stdout.write(`${FIXTURE_OUTPUT_LINES.WAITING}${OUTPUT_LINE_SEPARATOR}`);
  }
}, FIXTURE_FILE_POLL_INTERVAL_MILLISECONDS);

const callContext = createToolCallContext({
  progressToken: undefined,
  sendProgressNotification: async () => undefined,
  cancellationSignal: new AbortController().signal,
  logger,
});

tokenProvider.getToken(callContext).then(
  () => {
    process.stderr.write('signal during login fixture unexpectedly received a token\n');
    process.exit(FIXTURE_FAILURE_EXIT_CODE);
  },
  (error: unknown) => {
    process.stderr.write(`signal during login fixture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(FIXTURE_FAILURE_EXIT_CODE);
  },
);
