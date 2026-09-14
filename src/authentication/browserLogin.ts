import { access } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  API_PATH_SUFFIX,
  AUTHENTICATION_ERROR_CODES,
  AuthenticationTimings,
  BROWSER_INSTALLATION_COMPLETE_MARKER_FILE_NAME,
  CHROMIUM_INSTALL_ARGUMENTS,
  CLOSE_EVENT,
  CURRENT_USER_API_PATH,
  LOGIN_PAGE_PATH,
  LOGIN_PAGE_WAIT_CONDITION,
  LOGIN_WAITING_LOG_INTERVAL_MILLISECONDS,
  MILLISECONDS_PER_SECOND,
  MISSING_BROWSER_EXECUTABLE_MARKER,
  MISSING_SYSTEM_DEPENDENCIES_MARKER,
  PINNED_PLAYWRIGHT_VERSION,
  PLAYWRIGHT_BROWSERS_PATH_VARIABLE,
  PLAYWRIGHT_NPX_PACKAGE,
  PROFILE_IN_USE_MARKERS,
  SERVER_PACKAGE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_URL_PATH,
  SYSTEM_DEPENDENCIES_INSTALL_ARGUMENTS,
  TRAILING_SLASHES_PATTERN,
} from './constants.js';
import {
  AuthenticationLogger,
  Clock,
  MattermostAuthenticationError,
  getErrorFirstLine,
  systemClock,
} from './runtime.js';
import { StatePaths, ensurePrivateDirectory, ensureStateDirectory } from './stateFiles.js';

const PARENT_DIRECTORY_SEGMENT = '..';

export function deriveSiteUrl(mattermostApiUrl: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(mattermostApiUrl);
  } catch {
    throw new Error(`Invalid MATTERMOST_URL: ${mattermostApiUrl}`);
  }
  let path = parsedUrl.pathname.replace(TRAILING_SLASHES_PATTERN, '');
  if (path.endsWith(API_PATH_SUFFIX)) {
    path = path.slice(0, -API_PATH_SUFFIX.length);
  }
  path = path.replace(TRAILING_SLASHES_PATTERN, '');
  return `${parsedUrl.origin}${path}`;
}

export function buildLoginPageUrl(siteUrl: string): string {
  return `${siteUrl}${LOGIN_PAGE_PATH}`;
}

/** Путь cookie сравнивается через pathname.startsWith(cookie.path), поэтому адрес заканчивается на / */
export function buildSessionCookieUrl(siteUrl: string): string {
  return `${siteUrl}${SESSION_COOKIE_URL_PATH}`;
}

export interface LoginBrowserCookie {
  name: string;
  value: string;
}

export interface LoginBrowserPage {
  goto(url: string, options: { waitUntil: typeof LOGIN_PAGE_WAIT_CONDITION; timeout: number }): Promise<unknown>;
}

export interface LoginBrowserContext {
  pages(): LoginBrowserPage[];
  newPage(): Promise<LoginBrowserPage>;
  cookies(urls: string[]): Promise<LoginBrowserCookie[]>;
  on(event: typeof CLOSE_EVENT, listener: () => void): unknown;
  close(): Promise<void>;
}

export type BrowserInstallationState =
  | { kind: 'installed'; executablePath: string }
  | { kind: 'missing'; executablePath: string };

export interface LoginBrowserLauncher {
  /** Проверка без создания папок и без скачивания; вызывает только держатель login.lock */
  inspectInstallation(): Promise<BrowserInstallationState>;
  launch(profileDirectory: string): Promise<LoginBrowserContext>;
}

type PlaywrightSignalHandlerOption = 'handleSIGINT' | 'handleSIGTERM' | 'handleSIGHUP';

/** Обработчики сигналов Playwright выключены: сигналы обрабатывает сервер, а Chromium убивает обработчик exit Playwright */
export interface ChromiumLaunchOptions extends Record<PlaywrightSignalHandlerOption, false> {
  headless: false;
  timeout: number;
}

export function buildChromiumLaunchOptions(
  timings: Pick<AuthenticationTimings, 'browserLaunchTimeoutMilliseconds'>,
): ChromiumLaunchOptions {
  return {
    headless: false,
    timeout: timings.browserLaunchTimeoutMilliseconds,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildChromiumInstallCommand(browsersDirectory: string): string {
  return [
    `${PLAYWRIGHT_BROWSERS_PATH_VARIABLE}=${quoteForShell(browsersDirectory)}`,
    'npx',
    PLAYWRIGHT_NPX_PACKAGE,
    ...CHROMIUM_INSTALL_ARGUMENTS,
  ].join(' ');
}

export function buildSystemDependenciesInstallCommand(): string {
  return ['sudo', 'npx', PLAYWRIGHT_NPX_PACKAGE, ...SYSTEM_DEPENDENCIES_INSTALL_ARGUMENTS].join(' ');
}

export interface PlaywrightChromium {
  executablePath(): string;
  launchPersistentContext(userDataDirectory: string, options: ChromiumLaunchOptions): Promise<LoginBrowserContext>;
}

export type LoadPlaywright = () => Promise<{ chromium: PlaywrightChromium }>;

const importPlaywright: LoadPlaywright = () => import('playwright');

export async function loadChromium(
  browsersDirectory: string,
  loadPlaywright: LoadPlaywright = importPlaywright,
): Promise<PlaywrightChromium> {
  /* Playwright вычисляет папку сборок один раз при импорте, поэтому переменная ставится до него */
  process.env[PLAYWRIGHT_BROWSERS_PATH_VARIABLE] = browsersDirectory;
  try {
    const playwright = await loadPlaywright();
    return playwright.chromium;
  } catch (error) {
    throw new MattermostAuthenticationError(
      AUTHENTICATION_ERROR_CODES.BROWSER_NOT_INSTALLED,
      `Playwright ${PINNED_PLAYWRIGHT_VERSION} could not be loaded (${getErrorFirstLine(error)}). Reinstall ${SERVER_PACKAGE_NAME} and retry.`,
    );
  }
}

export interface PlaywrightChromiumLauncherOptions {
  paths: StatePaths;
  timings: AuthenticationTimings;
  loadPlaywright?: LoadPlaywright;
}

function createBrowserNotInstalledError(browsersDirectory: string): MattermostAuthenticationError {
  return new MattermostAuthenticationError(
    AUTHENTICATION_ERROR_CODES.BROWSER_NOT_INSTALLED,
    `Chromium for Playwright ${PINNED_PLAYWRIGHT_VERSION} is not installed in ${browsersDirectory}. Run: ${buildChromiumInstallCommand(browsersDirectory)}`,
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function inspectChromiumFiles(
  chromium: PlaywrightChromium,
  browsersDirectory: string,
): Promise<BrowserInstallationState> {
  let executablePath: string;
  try {
    executablePath = chromium.executablePath();
  } catch (error) {
    throw new MattermostAuthenticationError(
      AUTHENTICATION_ERROR_CODES.BROWSER_NOT_INSTALLED,
      `Chromium for Playwright ${PINNED_PLAYWRIGHT_VERSION} is not supported on this platform (${getErrorFirstLine(error)}). Downloading it will not help.`,
    );
  }

  const pathInsideBrowsersDirectory = relative(browsersDirectory, executablePath);
  const [revisionDirectoryName] = pathInsideBrowsersDirectory.split(sep);
  if (
    isAbsolute(pathInsideBrowsersDirectory) ||
    revisionDirectoryName === undefined ||
    revisionDirectoryName === '' ||
    revisionDirectoryName === PARENT_DIRECTORY_SEGMENT
  ) {
    return { kind: 'missing', executablePath };
  }

  /* Маркер Playwright пишет последним, поэтому распакованная наполовину сборка считается отсутствующей */
  const markerPath = join(browsersDirectory, revisionDirectoryName, BROWSER_INSTALLATION_COMPLETE_MARKER_FILE_NAME);
  const [executableExists, markerExists] = await Promise.all([fileExists(executablePath), fileExists(markerPath)]);
  return executableExists && markerExists ? { kind: 'installed', executablePath } : { kind: 'missing', executablePath };
}

export function createPlaywrightChromiumLauncher(options: PlaywrightChromiumLauncherOptions): LoginBrowserLauncher {
  const { paths, timings, loadPlaywright } = options;

  const loadAndInspect = async () => {
    const chromium = await loadChromium(paths.browsersDirectory, loadPlaywright);
    const state = await inspectChromiumFiles(chromium, paths.browsersDirectory);
    return { chromium, state };
  };

  return {
    inspectInstallation: async () => (await loadAndInspect()).state,
    launch: async (profileDirectory) => {
      const { chromium, state } = await loadAndInspect();
      if (state.kind === 'missing') {
        throw createBrowserNotInstalledError(paths.browsersDirectory);
      }
      await ensureStateDirectory(paths);
      await ensurePrivateDirectory(profileDirectory);
      try {
        return await chromium.launchPersistentContext(profileDirectory, buildChromiumLaunchOptions(timings));
      } catch (error) {
        throw translateBrowserLaunchError(error, paths);
      }
    },
  };
}

export function translateBrowserLaunchError(error: unknown, paths: StatePaths): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(MISSING_BROWSER_EXECUTABLE_MARKER)) {
    return createBrowserNotInstalledError(paths.browsersDirectory);
  }
  if (message.includes(MISSING_SYSTEM_DEPENDENCIES_MARKER)) {
    return new MattermostAuthenticationError(
      AUTHENTICATION_ERROR_CODES.BROWSER_SYSTEM_DEPENDENCIES_MISSING,
      `Chromium cannot start because system libraries are missing. Run: ${buildSystemDependenciesInstallCommand()}`,
    );
  }
  if (PROFILE_IN_USE_MARKERS.some((marker) => message.includes(marker))) {
    return new MattermostAuthenticationError(
      AUTHENTICATION_ERROR_CODES.LOGIN_PROFILE_BUSY,
      `Browser profile ${paths.profileDirectory} is already in use by another Chromium window. Close the other Mattermost sign-in window and retry.`,
    );
  }
  return new Error(`Failed to launch Chromium: ${getErrorFirstLine(error)}`);
}

export interface TokenValidationResult {
  kind: 'valid' | 'rejected' | 'unavailable';
  statusDescription: string;
}

export interface BrowserLoginRequest {
  siteUrl: string;
  profileDirectory: string;
  rejectedToken: string | undefined;
  deadlineMilliseconds: number;
  validateToken(candidateToken: string): Promise<TokenValidationResult>;
}

export type PerformBrowserLogin = (request: BrowserLoginRequest) => Promise<string>;

export interface BrowserLoginDependencies {
  launcher: LoginBrowserLauncher;
  timings: AuthenticationTimings;
  logger: AuthenticationLogger;
  clock?: Clock;
}

type RaceOutcome<T> = { kind: 'settled'; value: T } | { kind: 'failed'; error: unknown } | { kind: 'timed-out' };

/** Гонка операции с часами; ожидание снимается сразу после итога, чтобы не держать таймер */
async function raceWithClock<T>(operation: Promise<T>, milliseconds: number, clock: Clock): Promise<RaceOutcome<T>> {
  const sleepController = new AbortController();
  try {
    return await Promise.race<RaceOutcome<T>>([
      operation.then(
        (value): RaceOutcome<T> => ({ kind: 'settled', value }),
        (error: unknown): RaceOutcome<T> => ({ kind: 'failed', error }),
      ),
      clock.sleep(milliseconds, sleepController.signal).then((): RaceOutcome<T> => ({ kind: 'timed-out' })),
    ]);
  } finally {
    sleepController.abort();
  }
}

function toSeconds(milliseconds: number): number {
  return Math.round(milliseconds / MILLISECONDS_PER_SECOND);
}

const SESSION_COOKIE_NOT_FOUND_DESCRIPTION = 'session cookie not found';
const SESSION_COOKIE_ALREADY_REJECTED_DESCRIPTION = 'session cookie was already rejected';
const LOGIN_NOT_STARTED_DESCRIPTION = 'sign-in window was not opened';

export function createBrowserLogin(dependencies: BrowserLoginDependencies): PerformBrowserLogin {
  const { launcher, timings, logger, clock = systemClock } = dependencies;
  const loginTimeoutSeconds = toSeconds(timings.loginTimeoutMilliseconds);

  const createLoginTimeoutError = (lastCheckDescription: string) =>
    new MattermostAuthenticationError(
      AUTHENTICATION_ERROR_CODES.LOGIN_TIMEOUT,
      `Mattermost sign-in did not complete within ${loginTimeoutSeconds} s (last check: ${lastCheckDescription}). Complete the sign-in in the browser window and retry the tool call.`,
    );

  return async (request) => {
    const { siteUrl, profileDirectory, rejectedToken, deadlineMilliseconds, validateToken } = request;
    if (clock.now() >= deadlineMilliseconds) {
      throw createLoginTimeoutError(LOGIN_NOT_STARTED_DESCRIPTION);
    }

    const context = await launcher.launch(profileDirectory);
    let contextClosed = false;
    context.on(CLOSE_EVENT, () => {
      contextClosed = true;
    });

    const sessionCookieUrls = [buildSessionCookieUrl(siteUrl)];
    const rejectedCandidates = new Set<string>();
    let lastCheckDescription = SESSION_COOKIE_NOT_FOUND_DESCRIPTION;
    let lastCookies: LoginBrowserCookie[] = [];

    const readCookies = async (): Promise<LoginBrowserCookie[] | undefined> => {
      const outcome = await raceWithClock(
        context.cookies(sessionCookieUrls),
        timings.cookieReadTimeoutMilliseconds,
        clock,
      );
      if (outcome.kind === 'settled') {
        lastCookies = outcome.value;
        return outcome.value;
      }
      lastCheckDescription =
        outcome.kind === 'timed-out'
          ? `cookie read timed out after ${toSeconds(timings.cookieReadTimeoutMilliseconds)} s`
          : `cookie read failed (${getErrorFirstLine(outcome.error)})`;
      return undefined;
    };

    const findCandidate = (cookies: LoginBrowserCookie[]): string | undefined => {
      const sessionCookies = cookies.filter((cookie) => cookie.name === SESSION_COOKIE_NAME && cookie.value.length > 0);
      if (sessionCookies.length === 0) {
        lastCheckDescription = SESSION_COOKIE_NOT_FOUND_DESCRIPTION;
        return undefined;
      }
      /* Cookie с этим именем может быть несколько, например для разных путей, и отвергнутая может идти первой */
      const candidateCookie = sessionCookies.find(
        (cookie) => cookie.value !== rejectedToken && !rejectedCandidates.has(cookie.value),
      );
      if (candidateCookie === undefined) {
        lastCheckDescription = SESSION_COOKIE_ALREADY_REJECTED_DESCRIPTION;
        return undefined;
      }
      return candidateCookie.value;
    };

    const isCandidateAccepted = async (candidate: string): Promise<boolean> => {
      const outcome = await raceWithClock(validateToken(candidate), timings.tokenValidationTimeoutMilliseconds, clock);
      const result: TokenValidationResult =
        outcome.kind === 'settled'
          ? outcome.value
          : outcome.kind === 'timed-out'
            ? {
                kind: 'unavailable',
                statusDescription: `token validation timed out after ${toSeconds(timings.tokenValidationTimeoutMilliseconds)} s`,
              }
            : { kind: 'unavailable', statusDescription: `token validation failed (${getErrorFirstLine(outcome.error)})` };
      lastCheckDescription = result.statusDescription;
      if (result.kind === 'valid') {
        return true;
      }
      if (result.kind === 'rejected') {
        rejectedCandidates.add(candidate);
        logger(`session cookie rejected by ${CURRENT_USER_API_PATH} (${result.statusDescription}), waiting for sign-in`);
      }
      return false;
    };

    try {
      let page = context.pages()[0];
      if (page === undefined) {
        const newPageOutcome = await raceWithClock(
          context.newPage(),
          timings.loginPageNavigationTimeoutMilliseconds,
          clock,
        );
        if (newPageOutcome.kind !== 'settled') {
          const failureDescription =
            newPageOutcome.kind === 'timed-out'
              ? `did not open within ${toSeconds(timings.loginPageNavigationTimeoutMilliseconds)} s`
              : `could not be opened (${getErrorFirstLine(newPageOutcome.error)})`;
          logger(`sign-in page ${failureDescription}`);
          throw new MattermostAuthenticationError(
            AUTHENTICATION_ERROR_CODES.LOGIN_WINDOW_CLOSED,
            `The Mattermost sign-in page ${failureDescription}. Retry the tool call to open it again.`,
          );
        }
        page = newPageOutcome.value;
      }
      /* Вход определяется по cookie, поэтому ошибка и истечение навигации не прерывают ожидание */
      await raceWithClock(
        page.goto(buildLoginPageUrl(siteUrl), {
          waitUntil: LOGIN_PAGE_WAIT_CONDITION,
          timeout: timings.loginPageNavigationTimeoutMilliseconds,
        }),
        timings.loginPageNavigationTimeoutMilliseconds,
        clock,
      );

      let nextWaitingLogElapsedMilliseconds = LOGIN_WAITING_LOG_INTERVAL_MILLISECONDS;
      while (true) {
        if (contextClosed || context.pages().length === 0) {
          /* На macOS закрытие последнего окна не завершает Chromium, поэтому cookie ещё можно прочитать */
          const finalCookies = contextClosed ? lastCookies : ((await readCookies()) ?? lastCookies);
          const finalCandidate = findCandidate(finalCookies);
          if (finalCandidate !== undefined && (await isCandidateAccepted(finalCandidate))) {
            return finalCandidate;
          }
          logger('browser window closed before sign-in');
          throw new MattermostAuthenticationError(
            AUTHENTICATION_ERROR_CODES.LOGIN_WINDOW_CLOSED,
            'The Mattermost sign-in window was closed before sign-in completed. Retry the tool call to open it again.',
          );
        }

        const cookies = await readCookies();
        const candidate = cookies === undefined ? undefined : findCandidate(cookies);
        if (candidate !== undefined && (await isCandidateAccepted(candidate))) {
          return candidate;
        }

        const now = clock.now();
        if (now >= deadlineMilliseconds) {
          logger(`sign-in timed out after ${loginTimeoutSeconds} s (last check: ${lastCheckDescription})`);
          throw createLoginTimeoutError(lastCheckDescription);
        }

        const elapsedMilliseconds = timings.loginTimeoutMilliseconds - (deadlineMilliseconds - now);
        if (elapsedMilliseconds >= nextWaitingLogElapsedMilliseconds) {
          logger(`still waiting for sign-in (${toSeconds(elapsedMilliseconds)} s of ${loginTimeoutSeconds} s)`);
          nextWaitingLogElapsedMilliseconds =
            (Math.floor(elapsedMilliseconds / LOGIN_WAITING_LOG_INTERVAL_MILLISECONDS) + 1) *
            LOGIN_WAITING_LOG_INTERVAL_MILLISECONDS;
        }

        await clock.sleep(timings.cookiePollIntervalMilliseconds);
      }
    } finally {
      const closeOutcome = await raceWithClock(context.close(), timings.browserCloseTimeoutMilliseconds, clock);
      if (closeOutcome.kind === 'timed-out') {
        logger(`browser window did not close within ${toSeconds(timings.browserCloseTimeoutMilliseconds)} s`);
      }
    }
  };
}
