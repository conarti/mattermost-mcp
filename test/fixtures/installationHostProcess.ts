import { createBrowserInstaller } from '../../src/authentication/browserInstallation.js';
import { DEFAULT_AUTHENTICATION_TIMINGS } from '../../src/authentication/constants.js';
import { createStderrAuthenticationLogger } from '../../src/authentication/runtime.js';
import { PLAYWRIGHT_CLI_FIXTURE_VARIABLES } from './fixtureConstants.js';

const [browsersDirectory, temporaryRootDirectory, fakeCliPath, mode] = process.argv.slice(2);

const installBrowser = createBrowserInstaller({
  timings: DEFAULT_AUTHENTICATION_TIMINGS,
  logger: createStderrAuthenticationLogger(),
  resolveCliPath: () => fakeCliPath,
  environment: { ...process.env, [PLAYWRIGHT_CLI_FIXTURE_VARIABLES.MODE]: mode },
});

try {
  await installBrowser({
    browsersDirectory,
    temporaryRootDirectory,
    cancellationSignal: new AbortController().signal,
    onProgress: () => undefined,
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 3;
}
