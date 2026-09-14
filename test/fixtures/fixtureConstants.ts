export const PERMISSION_BITS_MASK = 0o777;
export const OUTPUT_LINE_SEPARATOR = '\n';
export const FIXTURE_KILL_SIGNAL = 'SIGKILL';
export const FIXTURE_TERMINATION_SIGNAL = 'SIGTERM';
export const FIXTURE_HANGUP_SIGNAL = 'SIGHUP';
export const FIXTURE_INTERRUPT_SIGNAL = 'SIGINT';
export const FAKE_CLOCK_TEST_TIMEOUT_MILLISECONDS = 5_000;

export const FIXTURE_FILE_NAMES = {
  LOCK_HOLDER: 'lockHolderProcess.js',
  EXIT_HANDLER: 'exitHandlerProcess.js',
  FAKE_PLAYWRIGHT_CLI: 'fakePlaywrightCli.js',
  SIGNAL_DURING_LOGIN: 'signalDuringLoginProcess.js',
  SIGNAL_DURING_INSTALLATION: 'signalDuringInstallationProcess.js',
  LOGIN_WORKER: 'loginWorkerProcess.js',
} as const;

export const FIXTURE_OUTPUT_LINES = {
  READY: 'ready',
  ACQUIRED: 'acquired',
  WAITING: 'waiting',
  INSTALLING: 'installing',
} as const;

export const SIGNAL_DURING_LOGIN_FIXTURE_MODES = {
  NORMAL: 'normal',
  THROWING_SHUTDOWN: 'throwing-shutdown',
} as const;

export const FIXTURE_MATTERMOST_URL = 'http://127.0.0.1:9/api/v4';
export const FIXTURE_TEAM_ID = 'team-test';
export const FIXTURE_FILE_POLL_INTERVAL_MILLISECONDS = 20;

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

export const LOGIN_WORKER_SCENARIOS = {
  SUCCESS: 'success',
  CLOSE_WINDOW: 'close-window',
  INSTALL_THEN_SUCCESS: 'install-then-success',
} as const;

export const LOGIN_WORKER_FILE_NAMES = {
  WINDOW_LOG: 'windows.log',
  INSTALLATION_LOG: 'installations.log',
  BARRIER: 'barrier',
  BROWSERS_INSTALLED_MARKER: 'fake-browsers-installed',
} as const;

export const LOGIN_WORKER_LOG_ENTRY_KINDS = {
  WINDOW: 'window',
  INSTALL: 'install',
} as const;

export const LOGIN_WORKER_RESULTS = {
  OK: 'ok',
  ERROR: 'error',
} as const;

export const LOGIN_WORKER_TOKENS = {
  EXPIRED: 'expired-secret-token-0002',
  FRESH: 'fresh-secret-token-0003',
} as const;

export const LOG_ENTRY_FIELD_SEPARATOR = ' ';

export const PLAYWRIGHT_CLI_FIXTURE_VARIABLES = {
  MODE: 'FAKE_PLAYWRIGHT_CLI_MODE',
  RECORD_PATH: 'FAKE_PLAYWRIGHT_CLI_RECORD_PATH',
  PROCESS_ID_PATH: 'FAKE_PLAYWRIGHT_CLI_PID_PATH',
} as const;
