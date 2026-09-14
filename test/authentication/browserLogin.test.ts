import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import {
  BrowserLoginRequest,
  ChromiumLaunchOptions,
  LoadPlaywright,
  LoginBrowserContext,
  PlaywrightChromium,
  TokenValidationResult,
  buildChromiumInstallCommand,
  buildChromiumLaunchOptions,
  createBrowserLogin,
  createPlaywrightChromiumLauncher,
  deriveSiteUrl,
  translateBrowserLaunchError,
} from '../../src/authentication/browserLogin.js';
import { DEFAULT_AUTHENTICATION_TIMINGS, PRIVATE_DIRECTORY_MODE } from '../../src/authentication/constants.js';
import { MattermostAuthenticationError } from '../../src/authentication/runtime.js';
import { StatePaths, resolveStatePaths } from '../../src/authentication/stateFiles.js';
import { TrackedPromise, flushAsyncWork, trackPromise } from '../fixtures/asyncControl.js';
import { FakeClock } from '../fixtures/fakeClock.js';
import { FakeCookieStep, FakeLoginBrowserContext, FakeLoginBrowserLauncher } from '../fixtures/fakeLoginBrowser.js';
import { FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS, PERMISSION_BITS_MASK } from '../fixtures/fixtureConstants.js';
import { removeDirectories } from '../fixtures/runProcess.js';

const START_MILLISECONDS = 1_000_000_000_000;
const SITE_URL = 'https://chat.example.test';
const SITE_HOSTNAME = 'chat.example.test';
const PROFILE_DIRECTORY = '/fake/home/.config/mattermost-mcp/profile';
const REJECTED_TOKEN = 'rejected-token-value-1';
const FRESH_TOKEN = 'fresh-token-value-2';
const OTHER_TOKEN = 'other-token-value-3';
const CLOCK_STEP_MILLISECONDS = 1_000;
const MAXIMUM_CLOCK_STEPS = 2_000;

const allLoggedMessages: string[] = [];
const temporaryDirectories: string[] = [];
const originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;

after(async () => {
  if (originalBrowsersPath === undefined) {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  } else {
    process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath;
  }
  await removeDirectories(temporaryDirectories);
});

function sessionCookie(value: string, domain: string = SITE_HOSTNAME): FakeCookieStep {
  return [
    { name: 'OTHER', value: 'unrelated', domain },
    { name: 'MMAUTHTOKEN', value, domain },
  ];
}

async function advanceUntil(clock: FakeClock, condition: () => boolean): Promise<void> {
  for (let step = 0; step < MAXIMUM_CLOCK_STEPS; step += 1) {
    await flushAsyncWork();
    if (condition()) {
      return;
    }
    clock.advance(CLOCK_STEP_MILLISECONDS);
  }
  throw new Error('condition was not reached by advancing the fake clock');
}

type ValidationStep = TokenValidationResult | 'never-resolves';

interface LoginTestContext {
  clock: FakeClock;
  messages: string[];
  context: FakeLoginBrowserContext;
  launcher: FakeLoginBrowserLauncher;
  validatedTokens: string[];
  start(overrides?: Partial<BrowserLoginRequest>): TrackedPromise<string>;
}

function createLoginTestContext(options: {
  cookieSteps?: FakeCookieStep[];
  gotoNeverResolves?: boolean;
  closeNeverResolves?: boolean;
  withoutInitialPage?: boolean;
  newPageNeverResolves?: boolean;
  newPageError?: Error;
  validate?: (token: string, callIndex: number) => ValidationStep;
}): LoginTestContext {
  const clock = new FakeClock(START_MILLISECONDS);
  const messages: string[] = [];
  const context = new FakeLoginBrowserContext({
    cookieSteps: options.cookieSteps,
    gotoNeverResolves: options.gotoNeverResolves,
    closeNeverResolves: options.closeNeverResolves,
    withoutInitialPage: options.withoutInitialPage,
    newPageNeverResolves: options.newPageNeverResolves,
    newPageError: options.newPageError,
    now: () => clock.now(),
  });
  const launcher = new FakeLoginBrowserLauncher(context);
  const validatedTokens: string[] = [];
  const validate = options.validate ?? ((token) => ({ kind: token === FRESH_TOKEN ? 'valid' : 'rejected', statusDescription: token === FRESH_TOKEN ? 'status 200' : 'status 401' }));
  const performBrowserLogin = createBrowserLogin({
    launcher,
    timings: DEFAULT_AUTHENTICATION_TIMINGS,
    logger: (message) => {
      messages.push(message);
      allLoggedMessages.push(message);
    },
    clock,
  });

  const start = (overrides: Partial<BrowserLoginRequest> = {}) =>
    trackPromise(
      performBrowserLogin({
        siteUrl: SITE_URL,
        profileDirectory: PROFILE_DIRECTORY,
        rejectedToken: REJECTED_TOKEN,
        deadlineMilliseconds: clock.now() + DEFAULT_AUTHENTICATION_TIMINGS.loginTimeoutMilliseconds,
        validateToken: (candidateToken) => {
          const callIndex = validatedTokens.length;
          validatedTokens.push(candidateToken);
          const result = validate(candidateToken, callIndex);
          return result === 'never-resolves' ? new Promise<TokenValidationResult>(() => undefined) : Promise.resolve(result);
        },
        ...overrides,
      }),
    );

  return { clock, messages, context, launcher, validatedTokens, start };
}

function isAuthenticationError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof MattermostAuthenticationError && error.code === code;
}

test('B1: site url is derived from the API url and used for the login page and cookie reads', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  assert.equal(deriveSiteUrl('https://Chat.Example.test/api/v4/'), 'https://chat.example.test');
  assert.equal(deriveSiteUrl('https://host.test:443/mm/api/v4'), 'https://host.test/mm');
  assert.equal(deriveSiteUrl('https://host.test'), 'https://host.test');
  assert.equal(deriveSiteUrl('https://host.test/api/v4?x=1'), 'https://host.test');
  assert.throws(() => deriveSiteUrl('not a url'), /Invalid MATTERMOST_URL/);

  const rootSite = createLoginTestContext({ cookieSteps: [sessionCookie(FRESH_TOKEN)] });
  const rootLogin = rootSite.start({ siteUrl: deriveSiteUrl('https://Chat.Example.test/api/v4/') });
  await advanceUntil(rootSite.clock, () => rootLogin.settled);
  assert.equal(await rootLogin.promise, FRESH_TOKEN);
  assert.deepEqual(rootSite.context.firstPage.gotoCalls, [
    { url: 'https://chat.example.test/login', options: { waitUntil: 'domcontentloaded', timeout: 30000 } },
  ]);
  assert.deepEqual(rootSite.context.cookieUrls, [['https://chat.example.test/']]);

  const nestedSite = createLoginTestContext({ cookieSteps: [sessionCookie(FRESH_TOKEN, 'host.test')] });
  const nestedLogin = nestedSite.start({ siteUrl: deriveSiteUrl('https://host.test/mm/api/v4') });
  await advanceUntil(nestedSite.clock, () => nestedLogin.settled);
  assert.equal(await nestedLogin.promise, FRESH_TOKEN);
  assert.deepEqual(nestedSite.context.cookieUrls, [['https://host.test/mm/']]);
});

test('B2: the rejected token cookie is skipped until a new valid cookie appears', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({
    cookieSteps: [sessionCookie(REJECTED_TOKEN), sessionCookie(REJECTED_TOKEN), sessionCookie(REJECTED_TOKEN), sessionCookie(FRESH_TOKEN)],
  });
  const result = login.start();
  await advanceUntil(login.clock, () => result.settled);

  assert.equal(await result.promise, FRESH_TOKEN);
  assert.equal(login.context.cookieReadCount, 4);
  assert.deepEqual(login.validatedTokens, [FRESH_TOKEN]);
});

test('B3: a cookie rejected by the server is validated once and logged once', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({
    cookieSteps: [
      sessionCookie(OTHER_TOKEN),
      sessionCookie(OTHER_TOKEN),
      sessionCookie(OTHER_TOKEN),
      sessionCookie(OTHER_TOKEN),
      sessionCookie(OTHER_TOKEN),
      sessionCookie(FRESH_TOKEN),
    ],
  });
  const result = login.start({ rejectedToken: undefined });
  await advanceUntil(login.clock, () => result.settled);

  assert.equal(await result.promise, FRESH_TOKEN);
  assert.deepEqual(login.validatedTokens, [OTHER_TOKEN, FRESH_TOKEN]);
  assert.equal(login.messages.filter((message) => message.includes('session cookie rejected')).length, 1);
  assert.ok(login.messages.includes('session cookie rejected by /users/me (status 401), waiting for sign-in'));
});

test('B4: an unavailable validation is retried and then accepted', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({
    cookieSteps: [sessionCookie(FRESH_TOKEN)],
    validate: (_token, callIndex) =>
      callIndex === 0 ? { kind: 'unavailable', statusDescription: 'status 503' } : { kind: 'valid', statusDescription: 'status 200' },
  });
  const result = login.start();
  await advanceUntil(login.clock, () => result.settled);

  assert.equal(await result.promise, FRESH_TOKEN);
  assert.equal(login.validatedTokens.length, 2);
});

test('B5: without a rejected token a valid cookie is accepted after one read', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({ cookieSteps: [sessionCookie(FRESH_TOKEN)] });
  const result = login.start({ rejectedToken: undefined });
  await advanceUntil(login.clock, () => result.settled);

  assert.equal(await result.promise, FRESH_TOKEN);
  assert.equal(login.context.cookieReadCount, 1);
  assert.equal(login.validatedTokens.length, 1);
});

test('B6: a validator that does not answer counts as unavailable after 10 s and is retried', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({
    cookieSteps: [sessionCookie(FRESH_TOKEN)],
    validate: (_token, callIndex) => (callIndex === 0 ? 'never-resolves' : { kind: 'valid', statusDescription: 'status 200' }),
  });
  const result = login.start();
  await advanceUntil(login.clock, () => login.validatedTokens.length === 2);

  assert.equal(login.clock.now() - START_MILLISECONDS, 11_000);
  await advanceUntil(login.clock, () => result.settled);
  assert.equal(await result.promise, FRESH_TOKEN);
});

test('B7: closing the last window ends the login with LOGIN_WINDOW_CLOSED', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({ cookieSteps: [[]] });
  const result = login.start();
  await advanceUntil(login.clock, () => login.context.cookieReadCount === 2);
  login.context.closeLastWindow();
  await advanceUntil(login.clock, () => result.settled);

  await assert.rejects(result.promise, isAuthenticationError('LOGIN_WINDOW_CLOSED'));
  assert.equal(login.context.cookieReadCount, 3);
  assert.ok(login.messages.includes('browser window closed before sign-in'));
  assert.equal(login.context.closeCalls, 1);
});

test('B8: the context close event ends the login with LOGIN_WINDOW_CLOSED', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({ cookieSteps: [[]] });
  const result = login.start();
  await advanceUntil(login.clock, () => login.context.cookieReadCount === 1);
  login.context.emitClose();
  await advanceUntil(login.clock, () => result.settled);

  await assert.rejects(result.promise, isAuthenticationError('LOGIN_WINDOW_CLOSED'));
  assert.equal(login.context.closeCalls, 1);
});

test('B9: a valid cookie on the step when the window closes is returned by the final check', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({ cookieSteps: [[]] });
  const result = login.start();
  await advanceUntil(login.clock, () => login.context.cookieReadCount === 2);
  login.context.cookieSteps.push(sessionCookie(FRESH_TOKEN));
  login.context.closeLastWindow();
  await advanceUntil(login.clock, () => result.settled);

  assert.equal(await result.promise, FRESH_TOKEN);
  assert.equal(login.context.closeCalls, 1);
});

test('B10: the login times out after the deadline with the last check description', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({
    cookieSteps: [sessionCookie(FRESH_TOKEN)],
    validate: () => ({ kind: 'unavailable', statusDescription: 'status 503' }),
  });
  const result = login.start();
  await advanceUntil(login.clock, () => result.settled);

  await assert.rejects(result.promise, (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, 'LOGIN_TIMEOUT');
    assert.match(error.message, /status 503/);
    return true;
  });
  assert.ok(login.messages.includes('still waiting for sign-in (60 s of 300 s)'));
  assert.ok(login.messages.includes('sign-in timed out after 300 s (last check: status 503)'));
  assert.equal(login.context.closeCalls, 1);
});

test('B11: an expired deadline fails before the browser is launched', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({ cookieSteps: [sessionCookie(FRESH_TOKEN)] });
  const result = login.start({ deadlineMilliseconds: START_MILLISECONDS });
  await flushAsyncWork();

  await assert.rejects(result.promise, isAuthenticationError('LOGIN_TIMEOUT'));
  assert.equal(login.launcher.launchCalls.length, 0);
});

test('B12: a window that does not close does not block the login longer than 5 s', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const login = createLoginTestContext({ cookieSteps: [sessionCookie(FRESH_TOKEN)], closeNeverResolves: true });
  const result = login.start();
  await advanceUntil(login.clock, () => result.settled);

  assert.equal(await result.promise, FRESH_TOKEN);
  assert.equal(login.clock.now() - START_MILLISECONDS, 5_000);
  assert.ok(login.messages.includes('browser window did not close within 5 s'));
});

test('B13: launch errors are translated into authentication error codes', () => {
  const paths = resolveStatePaths('/tmp/home');
  const expectCode = (message: string, code: string) => {
    const translated = translateBrowserLaunchError(new Error(message), paths);
    assert.ok(translated instanceof MattermostAuthenticationError, message);
    assert.equal(translated.code, code);
    return translated;
  };

  const notInstalled = expectCode("browserType.launchPersistentContext: Executable doesn't exist at /x", 'BROWSER_NOT_INSTALLED');
  assert.ok(notInstalled.message.includes(buildChromiumInstallCommand(paths.browsersDirectory)));
  expectCode(
    'Failed to create a ProcessSingleton for your profile directory. This usually means that the profile is already in use by another instance of Chromium.',
    'LOGIN_PROFILE_BUSY',
  );
  expectCode(
    'Opening in existing browser session. This usually means that the profile is already in use by another instance of Chromium.',
    'LOGIN_PROFILE_BUSY',
  );
  const dependencies = expectCode(
    'Host system is missing dependencies!\n\n  libnss3.so\n  libatk-1.0.so.0',
    'BROWSER_SYSTEM_DEPENDENCIES_MISSING',
  );
  assert.ok(dependencies.message.includes('sudo npx playwright@1.63.0 install-deps chromium'));
  for (const sandboxMessage of [
    'browserType.launchPersistentContext: Target page, context or browser has been closed\n[pid=1][err] No usable sandbox! Update your kernel',
    "browserType.launchPersistentContext: Chromium sandboxing failed!\n  - (alternative): Launch Chromium without sandbox using 'chromiumSandbox: false' option",
  ]) {
    const sandbox = expectCode(sandboxMessage, 'BROWSER_SANDBOX_UNAVAILABLE');
    assert.ok(sandbox.message.includes('MATTERMOST_MCP_DISABLE_CHROMIUM_SANDBOX=1'), sandbox.message);
    assert.equal(sandbox.message.includes('chromiumSandbox: false'), false);
  }

  const generic = translateBrowserLaunchError(new Error('Something else happened\nsecond line'), paths);
  assert.equal(generic instanceof MattermostAuthenticationError, false);
  assert.equal(generic.message, 'Failed to launch Chromium: Something else happened');
});

interface FakePlaywright {
  loadPlaywright: LoadPlaywright;
  browsersPathAtLoad: Array<string | undefined>;
  launches: Array<{ userDataDirectory: string; options: ChromiumLaunchOptions }>;
}

function createFakePlaywright(executablePath: () => string): FakePlaywright {
  const browsersPathAtLoad: Array<string | undefined> = [];
  const launches: Array<{ userDataDirectory: string; options: ChromiumLaunchOptions }> = [];
  const chromium: PlaywrightChromium = {
    executablePath,
    launchPersistentContext: async (userDataDirectory, options): Promise<LoginBrowserContext> => {
      launches.push({ userDataDirectory, options });
      return new FakeLoginBrowserContext();
    },
  };
  const loadPlaywright: LoadPlaywright = async () => {
    browsersPathAtLoad.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
    return { chromium };
  };
  return { loadPlaywright, browsersPathAtLoad, launches };
}

async function createTemporaryStatePaths(): Promise<StatePaths> {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-browser-login-'));
  temporaryDirectories.push(homeDirectory);
  return resolveStatePaths(homeDirectory);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('B14: the Playwright launcher sets the browsers path, inspects the build files and launches Chromium', async () => {
  const paths = await createTemporaryStatePaths();
  const revisionDirectory = join(paths.browsersDirectory, 'chromium-1243');
  const executablePath = join(revisionDirectory, 'chrome-mac-arm64', 'chrome');
  const timings = DEFAULT_AUTHENTICATION_TIMINGS;

  const unsupported = createFakePlaywright(() => {
    throw new Error('Browser is not supported on current platform');
  });
  const launcherMessages: string[] = [];
  const launcherLogger = (message: string) => launcherMessages.push(message);
  const unsupportedLauncher = createPlaywrightChromiumLauncher({
    paths,
    timings,
    logger: launcherLogger,
    loadPlaywright: unsupported.loadPlaywright,
    environment: {},
  });
  await assert.rejects(unsupportedLauncher.inspectInstallation(), isAuthenticationError('BROWSER_NOT_INSTALLED'));
  await assert.rejects(unsupportedLauncher.launch(paths.profileDirectory), isAuthenticationError('BROWSER_NOT_INSTALLED'));
  assert.equal(unsupported.launches.length, 0);

  const fakePlaywright = createFakePlaywright(() => executablePath);
  const launcher = createPlaywrightChromiumLauncher({
    paths,
    timings,
    logger: launcherLogger,
    loadPlaywright: fakePlaywright.loadPlaywright,
    environment: {},
  });

  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  assert.deepEqual(await launcher.inspectInstallation(), { kind: 'missing', executablePath });
  assert.deepEqual(fakePlaywright.browsersPathAtLoad, [paths.browsersDirectory]);
  assert.equal(await pathExists(paths.stateDirectory), false);
  await assert.rejects(launcher.launch(paths.profileDirectory), (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, 'BROWSER_NOT_INSTALLED');
    assert.ok(
      error.message.includes(`PLAYWRIGHT_BROWSERS_PATH='${paths.browsersDirectory}' npx playwright@1.63.0 install chromium --no-shell`),
    );
    return true;
  });
  assert.equal(await pathExists(paths.stateDirectory), false);

  await mkdir(dirname(executablePath), { recursive: true });
  await writeFile(executablePath, 'fake chrome');
  assert.deepEqual(await launcher.inspectInstallation(), { kind: 'missing', executablePath });

  await writeFile(join(revisionDirectory, 'INSTALLATION_COMPLETE'), '');
  assert.deepEqual(await launcher.inspectInstallation(), { kind: 'installed', executablePath });
  await launcher.launch(paths.profileDirectory);
  assert.deepEqual(fakePlaywright.launches, [
    {
      userDataDirectory: paths.profileDirectory,
      options: {
        headless: false,
        timeout: 60000,
        chromiumSandbox: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      },
    },
  ]);
  assert.deepEqual(buildChromiumLaunchOptions(timings, {}, launcherLogger), fakePlaywright.launches[0].options);
  assert.equal((await stat(paths.profileDirectory)).mode & PERMISSION_BITS_MASK, PRIVATE_DIRECTORY_MODE);
  assert.deepEqual(launcherMessages, []);

  const optedOutLauncher = createPlaywrightChromiumLauncher({
    paths,
    timings,
    logger: launcherLogger,
    loadPlaywright: fakePlaywright.loadPlaywright,
    environment: { MATTERMOST_MCP_DISABLE_CHROMIUM_SANDBOX: '1' },
  });
  await optedOutLauncher.launch(paths.profileDirectory);
  assert.equal(fakePlaywright.launches[1].options.chromiumSandbox, false);
  assert.deepEqual(launcherMessages, [
    'Chromium sandbox is disabled by MATTERMOST_MCP_DISABLE_CHROMIUM_SANDBOX=1: the sign-in window renders Mattermost content without process isolation',
  ]);
});

test('B20: the Chromium sandbox is on unless the opt-out variable is exactly 1, and the opt-out is logged', () => {
  const timings = DEFAULT_AUTHENTICATION_TIMINGS;
  for (const environment of [{}, { MATTERMOST_MCP_DISABLE_CHROMIUM_SANDBOX: '0' }, { MATTERMOST_MCP_DISABLE_CHROMIUM_SANDBOX: 'true' }]) {
    const messages: string[] = [];
    const options = buildChromiumLaunchOptions(timings, environment, (message) => messages.push(message));
    assert.equal(options.chromiumSandbox, true, JSON.stringify(environment));
    assert.deepEqual(messages, []);
  }

  const messages: string[] = [];
  const optedOut = buildChromiumLaunchOptions(
    timings,
    { MATTERMOST_MCP_DISABLE_CHROMIUM_SANDBOX: '1' },
    (message) => messages.push(message),
  );
  assert.equal(optedOut.chromiumSandbox, false);
  assert.equal(optedOut.handleSIGTERM, false);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].startsWith('Chromium sandbox is disabled by MATTERMOST_MCP_DISABLE_CHROMIUM_SANDBOX=1'));
});

test('B21: a session cookie of a parent domain is not taken for the Mattermost host', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const teamSiteUrl = 'https://team.example.test';
  const parentDomainCookies: FakeCookieStep = [
    { name: 'MMAUTHTOKEN', value: OTHER_TOKEN, domain: 'example.test' },
    { name: 'MMAUTHTOKEN', value: OTHER_TOKEN, domain: '.example.test' },
  ];

  const onlyParent = createLoginTestContext({ cookieSteps: [parentDomainCookies] });
  const onlyParentResult = onlyParent.start({ siteUrl: teamSiteUrl, rejectedToken: undefined });
  await advanceUntil(onlyParent.clock, () => onlyParentResult.settled);
  await assert.rejects(onlyParentResult.promise, (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, 'LOGIN_TIMEOUT');
    assert.ok(error.message.includes('session cookie not found'), error.message);
    return true;
  });
  assert.deepEqual(onlyParent.validatedTokens, []);

  for (const hostCookieDomain of ['team.example.test', '.team.example.test']) {
    const withHostCookie = createLoginTestContext({
      cookieSteps: [
        parentDomainCookies,
        [...parentDomainCookies, { name: 'MMAUTHTOKEN', value: FRESH_TOKEN, domain: hostCookieDomain }],
      ],
      validate: () => ({ kind: 'valid', statusDescription: 'status 200' }),
    });
    const withHostCookieResult = withHostCookie.start({ siteUrl: teamSiteUrl, rejectedToken: undefined });
    await advanceUntil(withHostCookie.clock, () => withHostCookieResult.settled);
    assert.equal(await withHostCookieResult.promise, FRESH_TOKEN);
    assert.equal(withHostCookie.context.cookieReadCount, 2);
    assert.deepEqual(withHostCookie.validatedTokens, [FRESH_TOKEN]);
  }
});

test('B15: the manual install command quotes the browsers directory for the shell', () => {
  assert.equal(
    buildChromiumInstallCommand("/tmp/it's here/browsers"),
    "PLAYWRIGHT_BROWSERS_PATH='/tmp/it'\\''s here/browsers' npx playwright@1.63.0 install chromium --no-shell",
  );
});

test('B17: hanging navigation and hanging cookie reads are bounded by their timeouts', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const navigation = createLoginTestContext({ cookieSteps: [sessionCookie(FRESH_TOKEN)], gotoNeverResolves: true });
  const navigationResult = navigation.start();
  await advanceUntil(navigation.clock, () => navigationResult.settled);
  assert.equal(await navigationResult.promise, FRESH_TOKEN);
  assert.equal(navigation.context.cookieReadTimes[0] - START_MILLISECONDS, 30_000);

  const cookieRead = createLoginTestContext({ cookieSteps: ['never-resolves'] });
  const cookieReadResult = cookieRead.start();
  await advanceUntil(cookieRead.clock, () => cookieRead.context.cookieReadCount === 2);
  assert.equal(cookieRead.context.cookieReadTimes[1] - START_MILLISECONDS, 6_000);
  await advanceUntil(cookieRead.clock, () => cookieReadResult.settled);
  await assert.rejects(cookieReadResult.promise, (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, 'LOGIN_TIMEOUT');
    assert.ok(error.message.includes('cookie read timed out after 5 s'));
    return true;
  });
});

test('B18: the first session cookie that was not rejected is used when several cookies share the name', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const withRejectedFirst = createLoginTestContext({
    cookieSteps: [
      [
        { name: 'MMAUTHTOKEN', value: REJECTED_TOKEN, domain: SITE_HOSTNAME },
        { name: 'MMAUTHTOKEN', value: '', domain: SITE_HOSTNAME },
        { name: 'MMAUTHTOKEN', value: FRESH_TOKEN, domain: SITE_HOSTNAME },
      ],
    ],
  });
  const withRejectedFirstResult = withRejectedFirst.start();
  await advanceUntil(withRejectedFirst.clock, () => withRejectedFirstResult.settled);
  assert.equal(await withRejectedFirstResult.promise, FRESH_TOKEN);
  assert.equal(withRejectedFirst.context.cookieReadCount, 1);
  assert.deepEqual(withRejectedFirst.validatedTokens, [FRESH_TOKEN]);

  const rejectedByServer = createLoginTestContext({
    cookieSteps: [
      [
        { name: 'MMAUTHTOKEN', value: OTHER_TOKEN, domain: SITE_HOSTNAME },
        { name: 'MMAUTHTOKEN', value: FRESH_TOKEN, domain: SITE_HOSTNAME },
      ],
    ],
  });
  const rejectedByServerResult = rejectedByServer.start({ rejectedToken: undefined });
  await advanceUntil(rejectedByServer.clock, () => rejectedByServerResult.settled);
  assert.equal(await rejectedByServerResult.promise, FRESH_TOKEN);
  assert.deepEqual(rejectedByServer.validatedTokens, [OTHER_TOKEN, FRESH_TOKEN]);

  const onlyRejected = createLoginTestContext({
    cookieSteps: [[{ name: 'MMAUTHTOKEN', value: REJECTED_TOKEN, domain: SITE_HOSTNAME }]],
  });
  const onlyRejectedResult = onlyRejected.start();
  await advanceUntil(onlyRejected.clock, () => onlyRejectedResult.settled);
  await assert.rejects(onlyRejectedResult.promise, (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, 'LOGIN_TIMEOUT');
    assert.ok(error.message.includes('session cookie was already rejected'));
    return true;
  });
  assert.deepEqual(onlyRejected.validatedTokens, []);
});

test('B19: a missing page is opened with a time limit and a hanging or failing newPage ends with LOGIN_WINDOW_CLOSED', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const opened = createLoginTestContext({ cookieSteps: [sessionCookie(FRESH_TOKEN)], withoutInitialPage: true });
  const openedResult = opened.start();
  await advanceUntil(opened.clock, () => openedResult.settled);
  assert.equal(await openedResult.promise, FRESH_TOKEN);
  assert.equal(opened.context.newPageCalls, 1);
  assert.equal(opened.context.firstPage.gotoCalls.length, 1);

  const hanging = createLoginTestContext({
    cookieSteps: [sessionCookie(FRESH_TOKEN)],
    withoutInitialPage: true,
    newPageNeverResolves: true,
  });
  const hangingResult = hanging.start();
  await advanceUntil(hanging.clock, () => hangingResult.settled);
  await assert.rejects(hangingResult.promise, (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, 'LOGIN_WINDOW_CLOSED');
    assert.ok(error.message.includes('sign-in page did not open within 30 s'), error.message);
    return true;
  });
  assert.equal(hanging.clock.now() - START_MILLISECONDS, 30_000);
  assert.equal(hanging.context.cookieReadCount, 0);
  assert.equal(hanging.context.closeCalls, 1);
  assert.ok(hanging.messages.includes('sign-in page did not open within 30 s'));

  const failing = createLoginTestContext({
    cookieSteps: [sessionCookie(FRESH_TOKEN)],
    withoutInitialPage: true,
    newPageError: new Error('browserContext.newPage: Target page, context or browser has been closed\nCall log:\n  - details'),
  });
  const failingResult = failing.start();
  await advanceUntil(failing.clock, () => failingResult.settled);
  await assert.rejects(failingResult.promise, (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, 'LOGIN_WINDOW_CLOSED');
    assert.ok(error.message.includes('Target page, context or browser has been closed'), error.message);
    assert.equal(error.message.includes('Call log'), false);
    return true;
  });
  assert.equal(failing.context.closeCalls, 1);
});

test('B16: logged messages never contain cookie or token values', () => {
  assert.ok(allLoggedMessages.length > 0);
  for (const message of allLoggedMessages) {
    for (const secret of [REJECTED_TOKEN, FRESH_TOKEN, OTHER_TOKEN, 'unrelated']) {
      assert.equal(message.includes(secret), false, message);
    }
  }
});
