/**
 * Процесс сервера для многопроцессных тестов входа: настоящие часы, общая домашняя папка,
 * фейковые окно входа, установщик Chromium и HTTP.
 * Печатает ready, ждёт файл-барьер, вызывает интерактивный getMe и печатает итог одной строкой JSON.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { InstallBrowser } from '../../src/authentication/browserInstallation.js';
import type {
  BrowserInstallationState,
  LoginBrowserContext,
  LoginBrowserLauncher,
} from '../../src/authentication/browserLogin.js';
import {
  AuthenticationTimings,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  SESSION_COOKIE_NAME,
  UNKNOWN_ERROR_CODE,
} from '../../src/authentication/constants.js';
import { createStderrAuthenticationLogger, getErrorCode } from '../../src/authentication/runtime.js';
import { createTokenProvider, createToolCallContext } from '../../src/authentication/session.js';
import { MattermostClient } from '../../src/client.js';
import type { Config } from '../../src/config.js';
import { FakeHttp, createTokenScenario } from './fakeHttp.js';
import { FakeLoginBrowserContext } from './fakeLoginBrowser.js';
import {
  FIXTURE_MATTERMOST_URL,
  FIXTURE_OUTPUT_LINES,
  FIXTURE_TEAM_ID,
  LOG_ENTRY_FIELD_SEPARATOR,
  LOGIN_WORKER_FILE_NAMES,
  LOGIN_WORKER_LOG_ENTRY_KINDS,
  LOGIN_WORKER_RESULTS,
  LOGIN_WORKER_SCENARIOS,
  LOGIN_WORKER_TOKENS,
  OUTPUT_LINE_SEPARATOR,
} from './fixtureConstants.js';

const FIXTURE_FAILURE_EXIT_CODE = 2;
const BARRIER_POLL_INTERVAL_MILLISECONDS = 10;
const SESSION_COOKIE_DELAY_MILLISECONDS = 400;
const WINDOW_CLOSE_DELAY_MILLISECONDS = 1_500;
const INSTALLATION_DURATION_MILLISECONDS = 4_000;
const FAKE_EXECUTABLE_PATH = '/fake/browsers/chromium-1243/chrome';
const CURRENT_USER_ID = 'user-1';

const [homeDirectory, windowLogPath, scenario, barrierFilePath, timingsJson] = process.argv.slice(2);
if (!Object.values<string>(LOGIN_WORKER_SCENARIOS).includes(scenario)) {
  process.stderr.write(`unknown login worker scenario ${scenario}\n`);
  process.exit(FIXTURE_FAILURE_EXIT_CODE);
}

const timings = JSON.parse(timingsJson) as Partial<AuthenticationTimings>;
const installationLogPath = join(dirname(windowLogPath), LOGIN_WORKER_FILE_NAMES.INSTALLATION_LOG);
const browsersInstalledMarkerPath = join(homeDirectory, LOGIN_WORKER_FILE_NAMES.BROWSERS_INSTALLED_MARKER);

function appendLogEntry(logPath: string, kind: string): void {
  appendFileSync(logPath, `${kind}${LOG_ENTRY_FIELD_SEPARATOR}${process.pid}${OUTPUT_LINE_SEPARATOR}`);
}

const launcher: LoginBrowserLauncher = {
  inspectInstallation: async (): Promise<BrowserInstallationState> => {
    const installed =
      scenario !== LOGIN_WORKER_SCENARIOS.INSTALL_THEN_SUCCESS || existsSync(browsersInstalledMarkerPath);
    return { kind: installed ? 'installed' : 'missing', executablePath: FAKE_EXECUTABLE_PATH };
  },
  launch: async (): Promise<LoginBrowserContext> => {
    appendLogEntry(windowLogPath, LOGIN_WORKER_LOG_ENTRY_KINDS.WINDOW);
    const context = new FakeLoginBrowserContext({ cookieSteps: [[]] });
    if (scenario === LOGIN_WORKER_SCENARIOS.CLOSE_WINDOW) {
      setTimeout(() => context.emitClose(), WINDOW_CLOSE_DELAY_MILLISECONDS);
    } else {
      setTimeout(
        () => context.cookieSteps.push([{ name: SESSION_COOKIE_NAME, value: LOGIN_WORKER_TOKENS.FRESH }]),
        SESSION_COOKIE_DELAY_MILLISECONDS,
      );
    }
    return context;
  },
};

const installBrowser: InstallBrowser = async () => {
  appendLogEntry(installationLogPath, LOGIN_WORKER_LOG_ENTRY_KINDS.INSTALL);
  await delay(INSTALLATION_DURATION_MILLISECONDS);
  writeFileSync(browsersInstalledMarkerPath, '');
};

const config: Config = { mattermostUrl: FIXTURE_MATTERMOST_URL, token: '', teamId: FIXTURE_TEAM_ID };
const fakeHttp = new FakeHttp(
  createTokenScenario(
    { [LOGIN_WORKER_TOKENS.FRESH]: { status: HTTP_STATUS_OK, body: { id: CURRENT_USER_ID } } },
    { status: HTTP_STATUS_UNAUTHORIZED },
  ),
);
const logger = createStderrAuthenticationLogger();
const tokenProvider = createTokenProvider(config, fakeHttp.fetch, {
  homeDirectory,
  launcher,
  installBrowser,
  timings,
  logger,
});
const client = new MattermostClient({ config, tokenProvider, fetchImplementation: fakeHttp.fetch });
const interactiveContext = createToolCallContext({
  progressToken: undefined,
  sendProgressNotification: async () => undefined,
  cancellationSignal: new AbortController().signal,
  logger,
});

process.stdout.write(`${FIXTURE_OUTPUT_LINES.READY}${OUTPUT_LINE_SEPARATOR}`);
while (!existsSync(barrierFilePath)) {
  await delay(BARRIER_POLL_INTERVAL_MILLISECONDS);
}

let resultLine: string;
try {
  await client.withCallContext(interactiveContext).getMe();
  resultLine = JSON.stringify({ result: LOGIN_WORKER_RESULTS.OK });
} catch (error) {
  resultLine = JSON.stringify({ result: LOGIN_WORKER_RESULTS.ERROR, code: getErrorCode(error) ?? UNKNOWN_ERROR_CODE });
  process.stderr.write(`login worker call failed: ${error instanceof Error ? error.message : String(error)}\n`);
}
/* Запись в трубу на macOS асинхронная, поэтому выход только после сброса строки итога */
process.stdout.write(`${resultLine}${OUTPUT_LINE_SEPARATOR}`, () => process.exit(0));
