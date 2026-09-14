export const PERMISSION_BITS_MASK = 0o777;
export const OUTPUT_LINE_SEPARATOR = '\n';
export const FIXTURE_KILL_SIGNAL = 'SIGKILL';
export const FIXTURE_TERMINATION_SIGNAL = 'SIGTERM';
export const FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS = 5_000;

export const FIXTURE_FILE_NAMES = {
  LOCK_HOLDER: 'lockHolderProcess.js',
  EXIT_HANDLER: 'exitHandlerProcess.js',
  FAKE_PLAYWRIGHT_CLI: 'fakePlaywrightCli.js',
} as const;

export const FIXTURE_OUTPUT_LINES = {
  READY: 'ready',
  ACQUIRED: 'acquired',
} as const;

export const LOCK_HOLDER_FIXTURE_MODES = {
  EXIT: 'exit',
  HANG: 'hang',
} as const;

export const EXIT_HANDLER_FIXTURE_MODES = {
  REMOVE_STATE_DIRECTORY: 'remove-state-directory',
  REMOVE_LOCK_FILE: 'remove-lock-file',
  OWN_BREAK: 'own-break',
} as const;

export const PLAYWRIGHT_CLI_FIXTURE_MODES = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  HANG: 'hang',
} as const;

export const PLAYWRIGHT_CLI_FIXTURE_VARIABLES = {
  MODE: 'FAKE_PLAYWRIGHT_CLI_MODE',
  RECORD_PATH: 'FAKE_PLAYWRIGHT_CLI_RECORD_PATH',
  PROCESS_ID_PATH: 'FAKE_PLAYWRIGHT_CLI_PID_PATH',
} as const;
