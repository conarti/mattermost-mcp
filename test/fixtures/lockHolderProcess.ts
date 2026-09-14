import { DEFAULT_AUTHENTICATION_TIMINGS } from '../../src/authentication/constants.js';
import { LoginLock } from '../../src/authentication/loginLock.js';
import { createStderrAuthenticationLogger, systemClock } from '../../src/authentication/runtime.js';
import { resolveStatePaths } from '../../src/authentication/stateFiles.js';

const [homeDirectory, mode] = process.argv.slice(2);

const loginLock = new LoginLock({
  paths: resolveStatePaths(homeDirectory),
  timings: DEFAULT_AUTHENTICATION_TIMINGS,
  logger: createStderrAuthenticationLogger(),
  clock: systemClock,
});

const heldLock = await loginLock.tryAcquire();
if (heldLock === undefined) {
  process.stderr.write('lock holder fixture could not acquire the lock\n');
  process.exit(1);
}

if (mode === 'exit') {
  process.stdout.write('acquired\n', () => process.exit(0));
} else if (mode === 'hang') {
  process.stdout.write('acquired\n');
  setInterval(() => undefined, 1_000_000);
} else {
  process.stderr.write(`unknown lock holder fixture mode ${mode}\n`);
  process.exit(1);
}
