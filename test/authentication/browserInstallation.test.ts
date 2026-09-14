import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { inspect } from 'node:util';
import {
  BrowserInstallationProgress,
  BrowserInstallerDependencies,
  buildInstallationEnvironment,
  createBrowserInstaller,
  extractInstallationFailureReason,
  parseInstallationProgressLine,
  redactProxyCredentials,
  redactUrlCredentials,
  resolvePlaywrightCliPath,
} from '../../src/authentication/browserInstallation.js';
import { buildChromiumInstallCommand } from '../../src/authentication/browserLogin.js';
import {
  AUTHENTICATION_ERROR_CODES,
  DEFAULT_AUTHENTICATION_TIMINGS,
  INSTALLATION_ABORT_REASONS,
  INSTALLATION_PENDING_OUTPUT_CHARACTER_LIMIT,
  PRIVATE_DIRECTORY_MODE,
} from '../../src/authentication/constants.js';
import { MattermostAuthenticationError } from '../../src/authentication/runtime.js';
import { FakeClock } from '../fixtures/fakeClock.js';
import {
  FakeInstallationLaunch,
  FakeInstallationProcessOptions,
  FakeInstallationSpawner,
  FakeProcessEvents,
} from '../fixtures/fakeInstallationProcess.js';
import { FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS, PERMISSION_BITS_MASK } from '../fixtures/fixtureConstants.js';

const START_MILLISECONDS = 1_000_000_000_000;
/* Установщик создаёт папку сборок сам, поэтому она лежит во временной папке теста */
const BROWSERS_ROOT_DIRECTORY = mkdtempSync(join(tmpdir(), 'mattermost-mcp-installer-browsers-'));
const BROWSERS_DIRECTORY = join(BROWSERS_ROOT_DIRECTORY, 'state', 'browsers');
const FAKE_CLI_PATH = '/fake/node_modules/playwright-core/cli.js';
const FAKE_NODE_EXECUTABLE_PATH = '/fake/bin/node';
const LOCKED_DIRECTORY_MODE = 0o500;
const PROGRESS_BAR_WIDTH = 80;
const MANUAL_COMMAND = buildChromiumInstallCommand(BROWSERS_DIRECTORY);

const temporaryDirectories: string[] = [BROWSERS_ROOT_DIRECTORY];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function buildProgressLine(percent: number, totalSizeDescription = '150.3 MiB'): string {
  const filledWidth = Math.floor((PROGRESS_BAR_WIDTH * percent) / 100);
  return `|${'■'.repeat(filledWidth)}${' '.repeat(PROGRESS_BAR_WIDTH - filledWidth)}| ${String(percent).padStart(3)}% of ${totalSizeDescription}`;
}

/** Та же рамка, что у wrapInASCIIBox в Playwright */
function wrapInAsciiBox(lines: string[]): string[] {
  const padding = 1;
  const maximumLength = Math.max(...lines.map((line) => line.length));
  return [
    `╔${'═'.repeat(maximumLength + padding * 2)}╗`,
    ...lines.map((line) => `║${' '.repeat(padding)}${line}${' '.repeat(maximumLength - line.length + padding)}║`),
    `╚${'═'.repeat(maximumLength + padding * 2)}╝`,
  ];
}

const NPX_WARNING_BOX = wrapInAsciiBox([
  "WARNING: It looks like you are running 'npx playwright install' without first",
  "installing your project's dependencies.",
]);

function flushAsyncWork(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

interface TrackedPromise {
  readonly promise: Promise<void>;
  settled: boolean;
}

function trackPromise(promise: Promise<void>): TrackedPromise {
  const tracked: TrackedPromise = { promise, settled: false };
  promise.then(
    () => {
      tracked.settled = true;
    },
    () => {
      tracked.settled = true;
    },
  );
  return tracked;
}

interface InstallerTestContext {
  temporaryRootDirectory: string;
  clock: FakeClock;
  messages: string[];
  progressEvents: BrowserInstallationProgress[];
  spawner: FakeInstallationSpawner;
  processEvents: FakeProcessEvents;
  abortController: AbortController;
  start(): TrackedPromise;
}

async function createInstallerTestContext(
  options: {
    processOptions?: FakeInstallationProcessOptions;
    onLaunch?: (launch: FakeInstallationLaunch) => void;
    temporaryRootDirectory?: string;
    /** Вызывается после записи события прогресса и может бросить исключение */
    onProgress?: (progress: BrowserInstallationProgress) => void;
    /** Журнал записывает сообщение и бросает исключение, если условие выполнено */
    loggerThrowsFor?: (message: string) => boolean;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<InstallerTestContext> {
  const temporaryRootDirectory =
    options.temporaryRootDirectory ?? (await mkdtemp(join(tmpdir(), 'mattermost-mcp-installer-')));
  temporaryDirectories.push(temporaryRootDirectory);
  const clock = new FakeClock(START_MILLISECONDS);
  const messages: string[] = [];
  const progressEvents: BrowserInstallationProgress[] = [];
  const spawner = new FakeInstallationSpawner(options.processOptions, options.onLaunch);
  const processEvents = new FakeProcessEvents();
  const abortController = new AbortController();
  const dependencies: BrowserInstallerDependencies = {
    timings: DEFAULT_AUTHENTICATION_TIMINGS,
    logger: (message) => {
      messages.push(message);
      if (options.loggerThrowsFor?.(message)) {
        throw new Error('logger failed');
      }
    },
    clock,
    spawnProcess: spawner.spawn,
    resolveCliPath: () => FAKE_CLI_PATH,
    environment: options.environment ?? { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.test:3128' },
    nodeExecutablePath: FAKE_NODE_EXECUTABLE_PATH,
    processEvents,
  };
  const installBrowser = createBrowserInstaller(dependencies);
  const start = () =>
    trackPromise(
      installBrowser({
        browsersDirectory: BROWSERS_DIRECTORY,
        temporaryRootDirectory,
        cancellationSignal: abortController.signal,
        onProgress: (progress) => {
          progressEvents.push(progress);
          options.onProgress?.(progress);
        },
      }),
    );
  return { temporaryRootDirectory, clock, messages, progressEvents, spawner, processEvents, abortController, start };
}

async function installationDirectoriesIn(temporaryRootDirectory: string): Promise<string[]> {
  return (await readdir(temporaryRootDirectory)).filter((name) => name.startsWith('installation-'));
}

async function captureInstallationError(promise: Promise<void>): Promise<MattermostAuthenticationError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, 'BROWSER_INSTALLATION_FAILED');
    return error;
  }
  throw new Error('installation was expected to fail');
}

/** Системная ошибка Node с одной строкой стека и свойствами, как у ошибок сети */
function createSystemError(message: string, stackFrame: string, properties: Record<string, string | number>): Error {
  const error = Object.assign(new Error(message), properties);
  error.stack = `Error: ${message}\n    at ${stackFrame}`;
  return error;
}

/** Так ошибку печатает console.error во внуке установщика */
function inspectErrorAsConsole(error: Error): string {
  return `${inspect(error)}\n`;
}

function assertWithoutInspectedProperties(message: string): void {
  const description = message.slice(`[${AUTHENTICATION_ERROR_CODES.BROWSER_INSTALLATION_FAILED}]`.length);
  for (const fragment of ['{', '}', '[', ']', 'errno', 'syscall', 'hostname']) {
    assert.equal(description.includes(fragment), false, `${fragment} in ${message}`);
  }
}

async function runFailedInstallation(stderrText: string): Promise<MattermostAuthenticationError> {
  const context = await createInstallerTestContext();
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();
  child.writeStderr(stderrText);
  child.emitExit(1, null);
  return captureInstallationError(installation.promise);
}

test('R1: progress lines are parsed and other output is ignored', () => {
  const fortyPercentLine = `|${'■'.repeat(32)}${' '.repeat(48)}|  40% of 150.3 MiB`;
  assert.deepEqual(parseInstallationProgressLine(fortyPercentLine), { percent: 40, totalSizeDescription: '150.3 MiB' });
  assert.deepEqual(parseInstallationProgressLine(`|${'■'.repeat(80)}| 100% of 1 MiB`), {
    percent: 100,
    totalSizeDescription: '1 MiB',
  });
  assert.equal(
    parseInstallationProgressLine('Downloading Chromium 153.0.8010.12 from https://cdn.playwright.dev/builds/cft/chrome.zip'),
    undefined,
  );
  assert.equal(parseInstallationProgressLine('Failed to install browsers'), undefined);
  assert.equal(parseInstallationProgressLine(''), undefined);
});

test('R2: the CLI path is resolved from the playwright package to playwright-core', () => {
  const calls: Array<{ specifier: string; fromPath: string }> = [];
  const cliPath = resolvePlaywrightCliPath((specifier, fromPath) => {
    calls.push({ specifier, fromPath });
    return specifier === 'playwright/package.json'
      ? '/fake/node_modules/playwright/package.json'
      : '/fake/node_modules/playwright/node_modules/playwright-core/package.json';
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].specifier, 'playwright/package.json');
  assert.match(calls[0].fromPath, /browserInstallation\.js$/);
  assert.deepEqual(calls[1], {
    specifier: 'playwright-core/package.json',
    fromPath: '/fake/node_modules/playwright/package.json',
  });
  assert.equal(cliPath, '/fake/node_modules/playwright/node_modules/playwright-core/cli.js');
});

test('R3: the installer environment keeps proxy variables and overrides the browsers path and TMPDIR', () => {
  const environment: NodeJS.ProcessEnv = {
    HTTPS_PROXY: 'http://proxy.test:3128',
    HTTP_PROXY: 'http://proxy.test:3128',
    NO_PROXY: 'localhost',
    PLAYWRIGHT_DOWNLOAD_HOST: 'https://mirror.test',
    PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: '60000',
    PLAYWRIGHT_BROWSERS_PATH: '/other',
    TMPDIR: '/var/folders/system',
  };
  const originalEnvironment = { ...environment };
  const installationEnvironment = buildInstallationEnvironment('/x/browsers', '/x/tmp/installation-1', environment);

  assert.equal(installationEnvironment.HTTPS_PROXY, 'http://proxy.test:3128');
  assert.equal(installationEnvironment.HTTP_PROXY, 'http://proxy.test:3128');
  assert.equal(installationEnvironment.NO_PROXY, 'localhost');
  assert.equal(installationEnvironment.PLAYWRIGHT_DOWNLOAD_HOST, 'https://mirror.test');
  assert.equal(installationEnvironment.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT, '60000');
  assert.equal(installationEnvironment.PLAYWRIGHT_BROWSERS_PATH, '/x/browsers');
  assert.equal(installationEnvironment.TMPDIR, '/x/tmp/installation-1');
  assert.deepEqual(environment, originalEnvironment);
});

test('R4: the installer is started once with the pinned arguments, pipes and a fresh private TMPDIR', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const temporaryRootDirectory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-installer-'));
  const leftoverDirectory = join(temporaryRootDirectory, 'installation-old');
  await mkdir(leftoverDirectory);
  await writeFile(join(leftoverDirectory, 'partial.zip'), 'partial archive');

  let observedAtLaunch:
    | { temporaryDirectoryMode: number; browsersDirectoryMode: number; leftoverExists: boolean }
    | undefined;
  const context = await createInstallerTestContext({
    temporaryRootDirectory,
    onLaunch: (launch) => {
      const temporaryDirectory = launch.options.env.TMPDIR ?? '';
      observedAtLaunch = {
        temporaryDirectoryMode: statSync(temporaryDirectory).mode & PERMISSION_BITS_MASK,
        browsersDirectoryMode: statSync(BROWSERS_DIRECTORY).mode & PERMISSION_BITS_MASK,
        leftoverExists: existsSync(leftoverDirectory),
      };
    },
  });
  const installation = context.start();
  const launch = await context.spawner.waitForLaunch();
  launch.child.emitExit(0, null);
  await installation.promise;

  assert.equal(context.spawner.launches.length, 1);
  assert.equal(launch.command, FAKE_NODE_EXECUTABLE_PATH);
  assert.deepEqual(launch.commandArguments, [FAKE_CLI_PATH, 'install', 'chromium', '--no-shell']);
  assert.deepEqual(launch.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.ok(launch.options.env.TMPDIR?.startsWith(join(temporaryRootDirectory, 'installation-')));
  assert.equal(launch.options.env.PLAYWRIGHT_BROWSERS_PATH, BROWSERS_DIRECTORY);
  assert.equal(launch.options.env.HTTPS_PROXY, 'http://proxy.test:3128');
  assert.deepEqual(observedAtLaunch, {
    temporaryDirectoryMode: PRIVATE_DIRECTORY_MODE,
    browsersDirectoryMode: PRIVATE_DIRECTORY_MODE,
    leftoverExists: false,
  });
});

test('R5: progress is reported from chunked output and success waits for the close event', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const context = await createInstallerTestContext();
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();

  const fortyPercentLine = buildProgressLine(40);
  child.writeStdout(`Downloading Chromium 153.0.8010.12 from https://cdn.playwright.dev/builds/cft/chrome.zip\n${buildProgressLine(10)}\n${fortyPercentLine.slice(0, 30)}`);
  await flushAsyncWork();
  child.writeStdout(`${fortyPercentLine.slice(30)}\n${fortyPercentLine}\n`);
  await flushAsyncWork();
  child.writeStdout(buildProgressLine(100));
  child.emitExit(0, null, { withoutClose: true });
  await flushAsyncWork();
  await flushAsyncWork();
  assert.equal(installation.settled, false);
  assert.equal(context.processEvents.listenersOf('exit').length, 1);

  child.emitClose(0, null);
  await installation.promise;

  assert.deepEqual(
    context.progressEvents.map((progress) => progress.percent),
    [10, 40, 100],
  );
  assert.equal(context.messages.filter((message) => message === 'Chromium download 40% of 150.3 MiB').length, 1);
  assert.ok(context.messages.includes('Chromium installation finished in 0 s'));
  assert.equal(context.processEvents.listenersOf('exit').length, 0);
  assert.deepEqual(await installationDirectoriesIn(context.temporaryRootDirectory), []);

  const withoutClose = await createInstallerTestContext();
  const installationWithoutClose = withoutClose.start();
  const launchWithoutClose = await withoutClose.spawner.waitForLaunch();
  launchWithoutClose.child.emitExit(0, null, { withoutClose: true });
  await withoutClose.clock.waitForPendingSleeps(1);
  assert.equal(installationWithoutClose.settled, false);
  withoutClose.clock.advance(5_000);
  await installationWithoutClose.promise;
  assert.ok(withoutClose.messages.includes('Chromium installation finished in 5 s'));
});

test('R6: a failed download reports the summary from stdout and the detail from stderr without stack lines', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const context = await createInstallerTestContext();
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();

  child.writeStderr(
    inspectErrorAsConsole(
      createSystemError('getaddrinfo ENOTFOUND cdn.playwright.dev', 'GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26)', {
        errno: -3008,
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname: 'cdn.playwright.dev',
      }),
    ),
  );
  child.writeStdout(
    [
      'Failed to install browsers',
      'Error: Failed to download Chrome for Testing 153.0.8010.12 (playwright chromium v1243), caused by',
      'Error: Download failure, code=1',
      '    at ChildProcess.<anonymous> (/fake/node_modules/playwright-core/lib/coreBundle.js:32427:18)',
      '',
    ].join('\n'),
  );
  child.writeStdout('    at ChildProcess.emit (node:events:518:28)\n');
  child.emitExit(1, null);
  const error = await captureInstallationError(installation.promise);

  assert.ok(error.message.includes('Failed to download Chrome for Testing'));
  assert.ok(
    error.message.includes(
      'Download failure, code=1; Error: getaddrinfo ENOTFOUND cdn.playwright.dev. Run manually:',
    ),
    error.message,
  );
  assert.ok(
    error.message.includes(`PLAYWRIGHT_BROWSERS_PATH='${BROWSERS_DIRECTORY}' npx playwright@1.63.0 install chromium --no-shell`),
  );
  assert.equal(error.message.includes(' at '), false);
  assert.equal(error.message.includes('coreBundle.js'), false);
  assert.equal(error.message.includes('node:dns'), false);
  assertWithoutInspectedProperties(error.message);

  const connectionReset = await runFailedInstallation(
    inspectErrorAsConsole(
      createSystemError(
        'Client network socket disconnected before secure TLS connection was established',
        'TLSSocket.onConnectEnd (node:_tls_wrap:1727:19)',
        { code: 'ECONNRESET', host: 'cdn.playwright.dev', port: 443 },
      ),
    ),
  );
  assert.ok(
    connectionReset.message.includes(
      'Chromium download failed: Error: Client network socket disconnected before secure TLS connection was established (ECONNRESET). Run manually:',
    ),
    connectionReset.message,
  );
  assertWithoutInspectedProperties(connectionReset.message);

  const refusedErrors = ['::1', '127.0.0.1'].map((address) =>
    createSystemError(`connect ECONNREFUSED ${address}:3128`, 'TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)', {
      errno: -61,
      code: 'ECONNREFUSED',
      syscall: 'connect',
      address,
      port: 3128,
    }),
  );
  const aggregateError = Object.assign(new AggregateError(refusedErrors), { code: 'ECONNREFUSED' });
  aggregateError.stack = 'AggregateError\n    at internalConnectMultiple (node:net:1139:18)';
  const connectionRefused = await runFailedInstallation(inspectErrorAsConsole(aggregateError));
  assert.ok(
    connectionRefused.message.includes('Chromium download failed: Error: connect ECONNREFUSED 127.0.0.1:3128. Run manually:'),
    connectionRefused.message,
  );
  assertWithoutInspectedProperties(connectionRefused.message);
});

test('R7: the lockfile box from the installer is kept as text without box characters', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const context = await createInstallerTestContext();
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();
  const lockfilePath = `${BROWSERS_DIRECTORY}/__dirlock`;

  child.writeStdout(
    [
      'Failed to install browsers',
      'Error: ',
      ...wrapInAsciiBox([
        'An active lockfile is found at:',
        '',
        `  ${lockfilePath}`,
        '',
        'Either:',
        '- wait a few minutes if other Playwright is installing browsers in parallel',
        '- remove lock manually with:',
        '',
        `    rm -rf ${lockfilePath}`,
        '',
        '<3 Playwright Team',
      ]),
      '',
    ].join('\n'),
  );
  child.emitExit(1, null);
  const error = await captureInstallationError(installation.promise);

  assert.ok(error.message.includes('An active lockfile is found at:'));
  assert.ok(error.message.includes(lockfilePath));
  assert.equal(/[║╔╗╚╝═]/.test(error.message), false);
});

test('R8: the npx warning box is ignored and the exit description is used without output', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const withWarning = await createInstallerTestContext();
  const warningInstallation = withWarning.start();
  const warningLaunch = await withWarning.spawner.waitForLaunch();
  warningLaunch.child.writeStderr(`${NPX_WARNING_BOX.join('\n')}\n`);
  warningLaunch.child.writeStdout('Failed to install browsers\nError: boom\n');
  warningLaunch.child.emitExit(1, null);
  const warningError = await captureInstallationError(warningInstallation.promise);
  assert.ok(warningError.message.includes('Chromium download failed: Error: boom. Run manually:'));
  assert.equal(warningError.message.includes('WARNING'), false);

  const withoutOutput = await createInstallerTestContext();
  const silentInstallation = withoutOutput.start();
  const silentLaunch = await withoutOutput.spawner.waitForLaunch();
  silentLaunch.child.emitExit(1, null);
  const silentError = await captureInstallationError(silentInstallation.promise);
  assert.ok(silentError.message.includes('Chromium download failed: exit code 1. Run manually:'));

  const killedExternally = await createInstallerTestContext();
  const killedInstallation = killedExternally.start();
  const killedLaunch = await killedExternally.spawner.waitForLaunch();
  killedLaunch.child.emitExit(null, 'SIGKILL');
  const killedError = await captureInstallationError(killedInstallation.promise);
  assert.ok(killedError.message.includes('Chromium download failed: signal SIGKILL. Run manually:'));
  assert.deepEqual(killedLaunch.child.killSignals, []);
});

test('R9: proxy credentials are redacted in the error text and in the log', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const context = await createInstallerTestContext();
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();

  child.writeStderr('Error: tunneling socket could not be established via https://user:secret-password@proxy.test:3128\n');
  child.writeStdout('Failed to install browsers\nError: Download failure through https://user:secret-password@proxy.test:3128\n');
  child.emitExit(1, null);
  const error = await captureInstallationError(installation.promise);

  assert.ok(error.message.includes('https://***@proxy.test:3128'));
  assert.equal(error.message.includes('secret-password'), false);
  const failureLog = context.messages.find((message) => message.startsWith('Chromium installation failed:'));
  assert.ok(failureLog?.includes('https://***@proxy.test:3128'));
  assert.equal(context.messages.some((message) => message.includes('secret-password')), false);

  assert.equal(redactUrlCredentials('via http://user:p@ss@proxy.test:3128/path'), 'via http://***@proxy.test:3128/path');
  assert.equal(redactUrlCredentials('via http://:secret@proxy.test:3128'), 'via http://***@proxy.test:3128');
  assert.equal(redactUrlCredentials('via http://token@proxy.test'), 'via http://***@proxy.test');
  assert.equal(redactUrlCredentials('proxy http://user:pa/ss@proxy:3128 failed'), 'proxy http://***@proxy:3128 failed');
  assert.equal(redactUrlCredentials('proxy http://user:pa#ss@proxy:3128 failed'), 'proxy http://***@proxy:3128 failed');
  assert.equal(redactUrlCredentials("proxy: 'socks5://u:p@h:1080'"), "proxy: 'socks5://***@h:1080'");
  /* Жадная замена скрывает и часть адреса без userinfo, если в слове дальше есть @: лишнее скрытие безопаснее утечки */
  assert.equal(
    redactUrlCredentials('from https://cdn.playwright.dev/builds/@scope/chrome.zip?user=a@b'),
    'from https://***@b',
  );
});

test('R21: proxy credentials from the installer environment are redacted even without a scheme in the output', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const environment: NodeJS.ProcessEnv = {
    HTTPS_PROXY: 'http://user:pa/ss@proxy.test:3128',
    http_proxy: 'user:secret@proxy.test:3128',
    ALL_PROXY: 'socks5://proxy.test:1080',
    all_proxy: '@proxy.test:1080',
    NO_PROXY: 'user:no-proxy-value@',
  };
  assert.equal(
    redactProxyCredentials('tunneling via http://user:pa/ss@proxy.test:3128 and user:secret@proxy.test:3128', environment),
    'tunneling via http://***@proxy.test:3128 and ***@proxy.test:3128',
  );
  assert.equal(
    redactProxyCredentials('user:no-proxy-value@ stays, a user named user stays', environment),
    'user:no-proxy-value@ stays, a user named user stays',
  );
  assert.equal(redactProxyCredentials('nothing to hide', {}), 'nothing to hide');
  assert.equal(
    redactProxyCredentials('connect via user:secret@proxy:3128 failed', { HTTP_PROXY: 'user:secret@proxy:3128' }),
    'connect via ***@proxy:3128 failed',
  );
  assert.equal(
    redactProxyCredentials('connect via http://user:pa/ss@proxy:3128 failed', { https_proxy: 'http://user:pa/ss@proxy:3128' }),
    'connect via http://***@proxy:3128 failed',
  );

  const reason = extractInstallationFailureReason(
    {
      stdoutLines: ['Failed to install browsers', 'Error: Download failed via user:secret@proxy.test:3128'],
      stderrLines: ['Error: tunneling socket could not be established, proxy http://user:pa/ss@proxy.test:3128'],
      exitDescription: 'exit code 1',
    },
    environment,
  );
  assert.equal(reason.includes('secret'), false, reason);
  assert.equal(reason.includes('pa/ss'), false, reason);
  assert.ok(reason.includes('***@proxy.test:3128'), reason);

  const context = await createInstallerTestContext({
    environment: { PATH: '/usr/bin', https_proxy: 'user:secret-password@proxy.test:3128' },
  });
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();
  child.writeStderr('Error: proxy user:secret-password@proxy.test:3128 refused the connection\n');
  child.emitExit(1, null);
  const error = await captureInstallationError(installation.promise);
  assert.ok(error.message.includes('proxy ***@proxy.test:3128 refused the connection'), error.message);
  assert.equal(error.message.includes('secret-password'), false);
  assert.equal(context.messages.some((message) => message.includes('secret-password')), false);
});

test('R22: failures to prepare the installer directories end with the manual command or STATE_DIRECTORY_UNSAFE', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const blockingRoot = await mkdtemp(join(tmpdir(), 'mattermost-mcp-installer-blocked-'));
  temporaryDirectories.push(blockingRoot);
  const blockingFile = join(blockingRoot, 'regular-file');
  await writeFile(blockingFile, '');

  const temporaryRootUnderFile = join(blockingFile, 'tmp');
  const preparationFailure = await createInstallerTestContext({ temporaryRootDirectory: temporaryRootUnderFile });
  /* rm с force на пути внутри файла бросает ENOTDIR, а сам путь удалится вместе с blockingRoot */
  temporaryDirectories.splice(temporaryDirectories.indexOf(temporaryRootUnderFile), 1);
  const preparationError = await captureInstallationError(preparationFailure.start().promise);
  assert.equal(
    preparationError.message,
    `[BROWSER_INSTALLATION_FAILED] could not prepare installer temporary directory ${temporaryRootUnderFile} (ENOTDIR). Run manually: ${MANUAL_COMMAND}`,
  );
  assert.equal(preparationFailure.spawner.launches.length, 0);

  const linkTarget = join(blockingRoot, 'link-target');
  await mkdir(linkTarget, { mode: 0o755 });
  const linkedTemporaryRoot = join(blockingRoot, 'linked-tmp');
  await symlink(linkTarget, linkedTemporaryRoot);
  const linked = await createInstallerTestContext({ temporaryRootDirectory: linkedTemporaryRoot });
  await assert.rejects(linked.start().promise, (error: unknown) => {
    assert.ok(error instanceof MattermostAuthenticationError);
    assert.equal(error.code, AUTHENTICATION_ERROR_CODES.STATE_DIRECTORY_UNSAFE);
    assert.ok(error.message.includes(`${linkedTemporaryRoot} is a symbolic link`), error.message);
    return true;
  });
  assert.equal(linked.spawner.launches.length, 0);
  assert.equal((await lstat(linkTarget)).mode & PERMISSION_BITS_MASK, 0o755);
  assert.deepEqual(await readdir(linkTarget), []);
});

test('R10: the installer is terminated after 600 s with SIGTERM and then SIGKILL', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const exitsOnSignal = await createInstallerTestContext();
  const exitsInstallation = exitsOnSignal.start();
  const exitsLaunch = await exitsOnSignal.spawner.waitForLaunch();
  exitsOnSignal.clock.advance(600_000);
  const exitsError = await captureInstallationError(exitsInstallation.promise);
  assert.ok(exitsError.message.includes('Chromium installation timed out after 600 s, installer terminated. Run manually:'));
  assert.deepEqual(exitsLaunch.child.killSignals, ['SIGTERM']);
  assert.equal(
    exitsOnSignal.messages.filter((message) => message === 'Chromium installation timed out after 600 s, installer terminated').length,
    1,
  );
  exitsOnSignal.clock.advance(600_000);
  assert.deepEqual(exitsLaunch.child.killSignals, ['SIGTERM']);

  const ignoresSignals = await createInstallerTestContext({ processOptions: { ignoreSignals: true } });
  const ignoringInstallation = ignoresSignals.start();
  const ignoringLaunch = await ignoresSignals.spawner.waitForLaunch();
  ignoresSignals.clock.advance(600_000);
  assert.deepEqual(ignoringLaunch.child.killSignals, ['SIGTERM']);
  await ignoresSignals.clock.waitForPendingSleeps(1);
  ignoresSignals.clock.advance(5_000);
  await flushAsyncWork();
  assert.deepEqual(ignoringLaunch.child.killSignals, ['SIGTERM', 'SIGKILL']);
  await ignoresSignals.clock.waitForPendingSleeps(1);
  assert.equal(ignoringInstallation.settled, false);
  ignoresSignals.clock.advance(5_000);
  const ignoringError = await captureInstallationError(ignoringInstallation.promise);
  assert.ok(ignoringError.message.includes('timed out after 600 s'));
  assert.equal(
    ignoresSignals.messages.filter((message) => message === 'Chromium installation timed out after 600 s, installer terminated').length,
    1,
  );

  const exitsAfterTermination = await createInstallerTestContext({ processOptions: { ignoreSignals: true } });
  const terminatedInstallation = exitsAfterTermination.start();
  const terminatedLaunch = await exitsAfterTermination.spawner.waitForLaunch();
  exitsAfterTermination.clock.advance(600_000);
  terminatedLaunch.child.emitExit(null, 'SIGTERM');
  const terminatedError = await captureInstallationError(terminatedInstallation.promise);
  assert.ok(terminatedError.message.includes('timed out after 600 s'));
  assert.deepEqual(terminatedLaunch.child.killSignals, ['SIGTERM']);
});

test('R11: cancellation terminates the installer with the abort reason', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const cancelled = await createInstallerTestContext({ processOptions: { ignoreSignals: true } });
  const cancelledInstallation = cancelled.start();
  const cancelledLaunch = await cancelled.spawner.waitForLaunch();
  cancelledLaunch.child.writeStdout(`${buildProgressLine(10)}\n`);
  await flushAsyncWork();
  assert.equal(cancelled.progressEvents.length, 1);
  cancelled.abortController.abort(INSTALLATION_ABORT_REASONS.CANCELLED);
  assert.deepEqual(cancelledLaunch.child.killSignals, ['SIGTERM']);
  cancelledLaunch.child.emitExit(null, 'SIGTERM');
  const cancelledError = await captureInstallationError(cancelledInstallation.promise);
  assert.ok(cancelledError.message.includes('Chromium installation cancelled, installer terminated'));
  assert.deepEqual(await installationDirectoriesIn(cancelled.temporaryRootDirectory), []);

  const lockLost = await createInstallerTestContext({ processOptions: { ignoreSignals: true } });
  const lockLostInstallation = lockLost.start();
  const lockLostLaunch = await lockLost.spawner.waitForLaunch();
  lockLost.abortController.abort(INSTALLATION_ABORT_REASONS.LOCK_LOST);
  lockLostLaunch.child.emitExit(null, 'SIGTERM');
  const lockLostError = await captureInstallationError(lockLostInstallation.promise);
  assert.ok(lockLostError.message.includes('stopped because login lock was lost'));
  assert.equal(lockLostError.message.includes('cancelled'), false);
  assert.ok(lockLost.messages.includes('Chromium installation stopped because login lock was lost, installer terminated'));
  assert.equal(lockLost.messages.some((message) => message.includes('cancelled')), false);

  const cancelledBeforeStart = await createInstallerTestContext();
  cancelledBeforeStart.abortController.abort(INSTALLATION_ABORT_REASONS.CANCELLED);
  const beforeStartError = await captureInstallationError(cancelledBeforeStart.start().promise);
  assert.ok(beforeStartError.message.includes('Chromium installation cancelled before start'));
  assert.equal(cancelledBeforeStart.spawner.launches.length, 0);
});

test('R12: a spawn error fails the installation and later errors are only logged', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const context = await createInstallerTestContext();
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();
  const spawnError = Object.assign(new Error(`spawn ${FAKE_NODE_EXECUTABLE_PATH} ENOENT`), {
    code: 'ENOENT',
    syscall: `spawn ${FAKE_NODE_EXECUTABLE_PATH}`,
  });

  child.emitError(spawnError);
  assert.doesNotThrow(() => child.emitError(spawnError));
  const error = await captureInstallationError(installation.promise);

  assert.equal(
    error.message,
    `[BROWSER_INSTALLATION_FAILED] could not start installer: ENOENT. Run manually: ${MANUAL_COMMAND}`,
  );
  assert.ok(context.messages.includes('installer process error (ENOENT)'));
  assert.equal(context.processEvents.listenersOf('exit').length, 0);
  assert.equal(child.listenerCount('error'), 0);
  context.clock.advance(600_000);
  assert.deepEqual(child.killSignals, []);
});

test('R13: the process exit handler kills the running installer and never throws', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const context = await createInstallerTestContext({ processOptions: { ignoreSignals: true } });
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();

  const exitListeners = context.processEvents.listenersOf('exit');
  assert.equal(exitListeners.length, 1);
  child.throwOnKill = true;
  assert.doesNotThrow(() => exitListeners[0]());
  assert.deepEqual(child.killSignals, ['SIGKILL']);

  child.throwOnKill = false;
  child.emitExit(null, 'SIGKILL');
  await captureInstallationError(installation.promise);
  assert.equal(context.processEvents.listenersOf('exit').length, 0);
});

test('R14: large output keeps only recent lines and the reason is limited to 500 characters', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const context = await createInstallerTestContext();
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();

  for (let chunkIndex = 0; chunkIndex < 100; chunkIndex += 1) {
    const lines = Array.from({ length: 100 }, (_, lineIndex) => `unrelated output line ${chunkIndex * 100 + lineIndex}`);
    child.writeStdout(`${lines.join('\n')}\n`);
  }
  child.writeStderr('Error: last\n');
  child.emitExit(1, null);
  const error = await captureInstallationError(installation.promise);
  assert.equal(
    error.message,
    `[BROWSER_INSTALLATION_FAILED] Chromium download failed: Error: last. Run manually: ${MANUAL_COMMAND}`,
  );

  const longReason = await createInstallerTestContext();
  const longInstallation = longReason.start();
  const longLaunch = await longReason.spawner.waitForLaunch();
  longLaunch.child.writeStderr(`Error: ${'x'.repeat(2_000)}\n`);
  longLaunch.child.emitExit(1, null);
  const longError = await captureInstallationError(longInstallation.promise);
  const serviceTextLength = '[BROWSER_INSTALLATION_FAILED] Chromium download failed: . Run manually: '.length + MANUAL_COMMAND.length;
  assert.equal(longError.message.length, serviceTextLength + 500);
});

test('R15: an error event of a running installer is only logged unless it comes from spawn', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const context = await createInstallerTestContext();
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();

  child.emitError(Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' }));
  child.emitError(new Error('unexpected installer error'));
  await flushAsyncWork();
  assert.equal(installation.settled, false);
  assert.ok(context.messages.includes('installer process error (EPERM)'));
  assert.ok(context.messages.includes('installer process error (UNKNOWN)'));

  child.emitExit(0, null);
  await installation.promise;
  assert.ok(context.messages.includes('Chromium installation finished in 0 s'));
  assert.equal(child.listenerCount('error'), 0);
});

test('R16: after termination expires the exit handler stays until the installer process exits', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const context = await createInstallerTestContext({ processOptions: { ignoreSignals: true } });
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();

  context.clock.advance(600_000);
  await context.clock.waitForPendingSleeps(1);
  context.clock.advance(5_000);
  await flushAsyncWork();
  await context.clock.waitForPendingSleeps(1);
  context.clock.advance(5_000);
  const error = await captureInstallationError(installation.promise);
  assert.ok(error.message.includes('timed out after 600 s, installer terminated'));
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);

  const exitListeners = context.processEvents.listenersOf('exit');
  assert.equal(exitListeners.length, 1);
  assert.equal(child.listenerCount('error'), 1);
  exitListeners[0]();
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL', 'SIGKILL']);

  child.emitExit(null, 'SIGKILL');
  await flushAsyncWork();
  await flushAsyncWork();
  assert.equal(context.processEvents.listenersOf('exit').length, 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.deepEqual(await installationDirectoriesIn(context.temporaryRootDirectory), []);
});

test('R17: exceptions from the progress callback and the logger in output handlers do not break the installation', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const throwingMessagePrefixes = ['Chromium download', 'installation progress handler failed', 'installer process error'];
  const context = await createInstallerTestContext({
    onProgress: () => {
      throw new Error('progress consumer failed');
    },
    loggerThrowsFor: (message) => throwingMessagePrefixes.some((prefix) => message.startsWith(prefix)),
  });
  const installation = context.start();
  const { child } = await context.spawner.waitForLaunch();

  child.writeStdout(`${buildProgressLine(10)}\n${buildProgressLine(40)}\n`);
  await flushAsyncWork();
  assert.doesNotThrow(() => child.emitError(new Error('unexpected installer error')));
  child.writeStdout(buildProgressLine(100));
  child.emitExit(0, null);
  await installation.promise;

  assert.deepEqual(
    context.progressEvents.map((progress) => progress.percent),
    [10, 40, 100],
  );
  assert.equal(
    context.messages.filter((message) => message === 'installation progress handler failed (progress consumer failed)').length,
    3,
  );
  assert.ok(context.messages.includes('Chromium download 100% of 150.3 MiB'));
  assert.ok(context.messages.includes('installer process error (UNKNOWN)'));
  assert.ok(context.messages.includes('Chromium installation finished in 0 s'));
});

test('R18: a leftover installation directory that cannot be removed is logged and does not block the installation', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const temporaryRootDirectory = await mkdtemp(join(tmpdir(), 'mattermost-mcp-installer-'));
  const leftoverName = 'installation-stuck';
  const lockedDirectory = join(temporaryRootDirectory, leftoverName, 'locked');
  await mkdir(lockedDirectory, { recursive: true });
  await writeFile(join(lockedDirectory, 'partial.zip'), 'partial archive');
  await chmod(lockedDirectory, LOCKED_DIRECTORY_MODE);

  try {
    const context = await createInstallerTestContext({ temporaryRootDirectory });
    const installation = context.start();
    const launch = await context.spawner.waitForLaunch();
    launch.child.emitExit(0, null);
    await installation.promise;

    const installerTemporaryDirectory = launch.options.env.TMPDIR ?? '';
    assert.ok(installerTemporaryDirectory.startsWith(join(temporaryRootDirectory, 'installation-')));
    assert.notEqual(installerTemporaryDirectory, join(temporaryRootDirectory, leftoverName));
    assert.ok(context.messages.includes('Chromium installation finished in 0 s'));
    /* Под root права папки не мешают удалению, тогда остатка и записи в журнале нет */
    const removalDenied = process.getuid?.() !== 0;
    assert.equal(existsSync(lockedDirectory), removalDenied);
    assert.equal(
      context.messages.some((message) => message.startsWith(`installer leftover directory ${leftoverName} cleanup failed (`)),
      removalDenied,
    );
    assert.equal(existsSync(installerTemporaryDirectory), false);
  } finally {
    await chmod(lockedDirectory, PRIVATE_DIRECTORY_MODE);
  }
});

test('R19: an output line without a line break keeps only its last characters within the limit', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const headMarker = 'HEAD';
  const runWithUnterminatedStderr = async (tailLength: number): Promise<MattermostAuthenticationError> => {
    const context = await createInstallerTestContext();
    const installation = context.start();
    const { child } = await context.spawner.waitForLaunch();
    child.writeStderr(headMarker);
    await flushAsyncWork();
    child.writeStderr('x'.repeat(tailLength));
    await flushAsyncWork();
    child.emitExit(1, null);
    return captureInstallationError(installation.promise);
  };

  const withinLimit = await runWithUnterminatedStderr(INSTALLATION_PENDING_OUTPUT_CHARACTER_LIMIT - headMarker.length);
  assert.ok(withinLimit.message.includes(`Chromium download failed: ${headMarker}xxx`), withinLimit.message.slice(0, 100));

  const overLimit = await runWithUnterminatedStderr(INSTALLATION_PENDING_OUTPUT_CHARACTER_LIMIT - headMarker.length + 1);
  assert.ok(overLimit.message.includes(`Chromium download failed: ${headMarker.slice(1)}xxx`), overLimit.message.slice(0, 100));
  assert.equal(overLimit.message.includes(headMarker), false);
});

test('R20: cancellation while the temporary directory is prepared stops before start and the abort listener is removed', { timeout: FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS }, async () => {
  const cancelledDuringPreparation = await createInstallerTestContext();
  const cancelledInstallation = cancelledDuringPreparation.start();
  cancelledDuringPreparation.abortController.abort(INSTALLATION_ABORT_REASONS.CANCELLED);
  const cancelledError = await captureInstallationError(cancelledInstallation.promise);
  assert.ok(cancelledError.message.includes('Chromium installation cancelled before start'));
  assert.equal(cancelledDuringPreparation.spawner.launches.length, 0);
  assert.deepEqual(await installationDirectoriesIn(cancelledDuringPreparation.temporaryRootDirectory), []);

  const completed = await createInstallerTestContext();
  const completedInstallation = completed.start();
  const { child } = await completed.spawner.waitForLaunch();
  assert.equal(getEventListeners(completed.abortController.signal, 'abort').length, 1);
  child.emitExit(0, null);
  await completedInstallation.promise;
  assert.equal(getEventListeners(completed.abortController.signal, 'abort').length, 0);
});
