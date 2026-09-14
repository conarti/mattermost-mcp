import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { DEFAULT_AUTHENTICATION_TIMINGS } from '../../src/authentication/constants.js';
import { LoginLock } from '../../src/authentication/loginLock.js';
import {
  createStderrAuthenticationLogger,
  installProcessShutdownHandlers,
  systemClock,
} from '../../src/authentication/runtime.js';
import { resolveStatePaths } from '../../src/authentication/stateFiles.js';

const [homeDirectory, markerPath, mode] = process.argv.slice(2);
const paths = resolveStatePaths(homeDirectory);

const loginLock = new LoginLock({
  paths,
  timings: DEFAULT_AUTHENTICATION_TIMINGS,
  logger: createStderrAuthenticationLogger(),
  clock: systemClock,
});

const heldLock = await loginLock.tryAcquire();
if (heldLock === undefined) {
  process.stderr.write('exit handler fixture could not acquire the lock\n');
  process.exit(1);
}

installProcessShutdownHandlers(() => {});

/* Обработчик регистрируется позже обработчика блокировки, как обработчик Playwright при запуске браузера */
process.on('exit', () => {
  writeFileSync(markerPath, 'later exit handler ran');
});

process.stdout.write('ready\n', () => {
  if (mode === 'remove-state-directory') {
    setInterval(() => undefined, 1_000_000);
  } else if (mode === 'remove-lock-file') {
    unlinkSync(paths.loginLockPath);
    process.exit(0);
  } else if (mode === 'own-break') {
    writeFileSync(
      paths.loginLockBreakPath,
      JSON.stringify({ processId: process.pid, createdAtMilliseconds: Date.now(), nonce: randomUUID() }),
    );
    process.exit(0);
  } else {
    process.stderr.write(`unknown exit handler fixture mode ${mode}\n`);
    process.exit(1);
  }
});
