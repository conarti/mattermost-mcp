/**
 * Держатель login.lock во время установки Chromium: настоящий установщик запускает фейковый cli.js в режиме hang.
 * Печатает строку installing, когда фейковый cli.js записал свой PID, и ждёт сигнала от теста.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBrowserInstaller } from '../../src/authentication/browserInstallation.js';
import { DEFAULT_AUTHENTICATION_TIMINGS, TEXT_FILE_ENCODING } from '../../src/authentication/constants.js';
import { createStderrAuthenticationLogger, installProcessShutdownHandlers } from '../../src/authentication/runtime.js';
import { createTokenProvider, createToolCallContext } from '../../src/authentication/session.js';
import type { Config } from '../../src/config.js';
import type { HttpFetch } from '../../src/types.js';
import { FakeLoginBrowserLauncher } from './fakeLoginBrowser.js';
import {
  FIXTURE_FILE_NAMES,
  FIXTURE_FILE_POLL_INTERVAL_MILLISECONDS,
  FIXTURE_MATTERMOST_URL,
  FIXTURE_OUTPUT_LINES,
  FIXTURE_TEAM_ID,
  OUTPUT_LINE_SEPARATOR,
  PLAYWRIGHT_CLI_FIXTURE_MODES,
  PLAYWRIGHT_CLI_FIXTURE_VARIABLES,
} from './fixtureConstants.js';

const FIXTURE_FAILURE_EXIT_CODE = 2;
const PROCESS_ID_CONTENT_PATTERN = /^[1-9]\d*$/;

const [homeDirectory, fakeCliProcessIdPath] = process.argv.slice(2);
const fakeCliPath = fileURLToPath(new URL(`./${FIXTURE_FILE_NAMES.FAKE_PLAYWRIGHT_CLI}`, import.meta.url));

const config: Config = { mattermostUrl: FIXTURE_MATTERMOST_URL, token: '', teamId: FIXTURE_TEAM_ID };
const offlineFetch: HttpFetch = async () => {
  throw new Error('network is disabled in the signal fixture');
};
const logger = createStderrAuthenticationLogger();
const installBrowser = createBrowserInstaller({
  timings: DEFAULT_AUTHENTICATION_TIMINGS,
  logger,
  resolveCliPath: () => fakeCliPath,
  environment: {
    ...process.env,
    [PLAYWRIGHT_CLI_FIXTURE_VARIABLES.MODE]: PLAYWRIGHT_CLI_FIXTURE_MODES.HANG,
    [PLAYWRIGHT_CLI_FIXTURE_VARIABLES.PROCESS_ID_PATH]: fakeCliProcessIdPath,
  },
});
const tokenProvider = createTokenProvider(config, offlineFetch, {
  homeDirectory,
  launcher: new FakeLoginBrowserLauncher(undefined, { installed: false }),
  installBrowser,
  logger,
});

installProcessShutdownHandlers(() => {});

function readFakeCliProcessId(): string | undefined {
  try {
    const content = readFileSync(fakeCliProcessIdPath, TEXT_FILE_ENCODING);
    return PROCESS_ID_CONTENT_PATTERN.test(content) ? content : undefined;
  } catch {
    return undefined;
  }
}

/* Файл с PID создаётся до записи содержимого, поэтому строка печатается только после полного PID */
const processIdPollHandle = setInterval(() => {
  if (readFakeCliProcessId() !== undefined) {
    clearInterval(processIdPollHandle);
    process.stdout.write(`${FIXTURE_OUTPUT_LINES.INSTALLING}${OUTPUT_LINE_SEPARATOR}`);
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
    process.stderr.write('signal during installation fixture unexpectedly received a token\n');
    process.exit(FIXTURE_FAILURE_EXIT_CODE);
  },
  (error: unknown) => {
    process.stderr.write(
      `signal during installation fixture failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(FIXTURE_FAILURE_EXIT_CODE);
  },
);
