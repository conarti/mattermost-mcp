export const STATE_DIRECTORY_NAME = 'mattermost-mcp';
export const CONFIG_DIRECTORY_NAME = '.config';
export const PROFILE_DIRECTORY_NAME = 'profile';
export const BROWSERS_DIRECTORY_NAME = 'browsers';
export const TOKEN_FILE_NAME = 'token';
export const LOGIN_LOCK_FILE_NAME = 'login.lock';
export const LOGIN_LOCK_BREAK_FILE_NAME = 'login.lock.break';
export const SESSION_COOKIE_NAME = 'MMAUTHTOKEN';
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const API_PATH_SUFFIX = '/api/v4';
export const LOGIN_PAGE_PATH = '/login';
export const CURRENT_USER_API_PATH = '/users/me';
export const PINNED_PLAYWRIGHT_VERSION = '1.63.0';
export const PLAYWRIGHT_BROWSERS_PATH_VARIABLE = 'PLAYWRIGHT_BROWSERS_PATH';
export const PLAYWRIGHT_PACKAGE_JSON_SPECIFIER = 'playwright/package.json';
export const PLAYWRIGHT_CORE_PACKAGE_JSON_SPECIFIER = 'playwright-core/package.json';
export const PLAYWRIGHT_CLI_FILE_NAME = 'cli.js';
export const CHROMIUM_INSTALL_ARGUMENTS = ['install', 'chromium', '--no-shell'] as const;
export const BROWSER_INSTALLATION_COMPLETE_MARKER_FILE_NAME = 'INSTALLATION_COMPLETE';
export const INSTALLATION_FAILURE_MARKER = 'Failed to install browsers';
export const INSTALLATION_PROGRESS_PATTERN = /(\d+)%\s+of\s+([\d.]+\s*\w+)/;
export const MISSING_BROWSER_EXECUTABLE_MARKER = "Executable doesn't exist";
export const MISSING_SYSTEM_DEPENDENCIES_MARKER = 'Host system is missing dependencies';
export const PROFILE_IN_USE_MARKERS = [
  'already in use by another instance of Chromium',
  'Failed to create a ProcessSingleton',
  'Opening in existing browser session',
] as const;
export const AUTHENTICATION_LOG_PREFIX = '[auth]';
export const LOGIN_PROGRESS_MESSAGE = 'Waiting for Mattermost sign-in in the browser window';
export const BROWSER_INSTALLATION_PROGRESS_MESSAGE = 'Downloading Chromium for Mattermost sign-in';
export const OTHER_PROCESS_PROGRESS_MESSAGE = 'Waiting for Mattermost sign-in in another process';
export const INSTALLATION_TEMPORARY_DIRECTORY_NAME = 'tmp';
export const INSTALLATION_TEMPORARY_DIRECTORY_PREFIX = 'installation-';
export const TEMPORARY_DIRECTORY_VARIABLE = 'TMPDIR';
export const INSTALLATION_ABORT_REASONS = {
  CANCELLED: 'cancelled',
  LOCK_LOST: 'stopped because login lock was lost',
} as const;
export const AUTHENTICATION_ERROR_CODES = {
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  LOGIN_WINDOW_CLOSED: 'LOGIN_WINDOW_CLOSED',
  LOGIN_TIMEOUT: 'LOGIN_TIMEOUT',
  LOGIN_NOT_COMPLETED: 'LOGIN_NOT_COMPLETED',
  LOGIN_PROFILE_BUSY: 'LOGIN_PROFILE_BUSY',
  BROWSER_NOT_INSTALLED: 'BROWSER_NOT_INSTALLED',
  BROWSER_INSTALLATION_FAILED: 'BROWSER_INSTALLATION_FAILED',
  BROWSER_SYSTEM_DEPENDENCIES_MISSING: 'BROWSER_SYSTEM_DEPENDENCIES_MISSING',
  STATE_DIRECTORY_UNSAFE: 'STATE_DIRECTORY_UNSAFE',
  UNAUTHORIZED_AFTER_RETRY: 'UNAUTHORIZED_AFTER_RETRY',
} as const;

export const FILE_SYSTEM_ERROR_CODES = {
  ALREADY_EXISTS: 'EEXIST',
  NOT_FOUND: 'ENOENT',
  NO_SUCH_PROCESS: 'ESRCH',
} as const;
export const UNKNOWN_ERROR_CODE = 'UNKNOWN';
export const TEXT_FILE_ENCODING = 'utf8';
export const EXCLUSIVE_CREATE_FLAG = 'wx';
export const TEMPORARY_FILE_EXTENSION = '.tmp';
export const PROCESS_EXIT_EVENT = 'exit';
export const ABORT_EVENT = 'abort';
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export const SERVER_PACKAGE_NAME = '@conarti/mattermost-mcp';
export const PLAYWRIGHT_NPX_PACKAGE = `playwright@${PINNED_PLAYWRIGHT_VERSION}`;
export const SYSTEM_DEPENDENCIES_INSTALL_ARGUMENTS = ['install-deps', 'chromium'] as const;
export const SESSION_COOKIE_URL_PATH = '/';
export const LOGIN_PAGE_WAIT_CONDITION = 'domcontentloaded';
export const LOGIN_WAITING_LOG_INTERVAL_MILLISECONDS = 60_000;
export const MILLISECONDS_PER_SECOND = 1_000;
export const CLOSE_EVENT = 'close';
export const ERROR_EVENT = 'error';
export const DATA_EVENT = 'data';
export const END_EVENT = 'end';
export const INSTALLER_TERMINATION_SIGNAL = 'SIGTERM';
export const INSTALLER_KILL_SIGNAL = 'SIGKILL';
export const INSTALLATION_OUTPUT_LINE_LIMIT = 50;
/** Незавершённая строка вывода установщика: 64 КБ, лишнее отбрасывается с начала */
export const INSTALLATION_PENDING_OUTPUT_CHARACTER_LIMIT = 64 * 1024;
export const INSTALLATION_FAILURE_REASON_MAX_LENGTH = 500;
export const STACK_TRACE_LINE_PATTERN = /^\s+at /;
export const ASCII_BOX_LINE_PATTERN = /^\s*[╔║╚]/;
export const ASCII_BOX_CHARACTERS_PATTERN = /[╔╗╚╝║═]/g;
export const WHITESPACE_RUN_PATTERN = /\s+/g;
export const INSPECTED_OBJECT_BRACKET_LINE_PATTERN = /^\s*[{}\[\]],?\s*$/;
export const INSPECTED_PROPERTY_LINE_PATTERN = /^\s+[\w$]+: /;
export const ERROR_HEADER_LINE_PATTERN = /^\s*(?:[A-Z]\w*)?Error\b/;
export const INSPECTED_ERROR_CODE_LINE_PATTERN = /^\s+code: '([^'\s]+)',?\s*$/;
export const SPAWN_SYSTEM_CALL_PATTERN = /^spawn(?:\s|$)/;
export const URL_CREDENTIALS_PATTERN = /\/\/[^\s/?#]*@/g;
export const REDACTED_URL_CREDENTIALS = '//***@';

export interface AuthenticationTimings {
  loginTimeoutMilliseconds: number;
  progressIntervalMilliseconds: number;
  lockStaleAgeMilliseconds: number;
  lockBreakStaleAgeMilliseconds: number;
  lockPollIntervalMilliseconds: number;
  lockReleaseTimeoutMilliseconds: number;
  cookiePollIntervalMilliseconds: number;
  cookieReadTimeoutMilliseconds: number;
  tokenValidationTimeoutMilliseconds: number;
  loginPageNavigationTimeoutMilliseconds: number;
  browserLaunchTimeoutMilliseconds: number;
  browserCloseTimeoutMilliseconds: number;
  browserInstallationTimeoutMilliseconds: number;
  installationTerminationGraceMilliseconds: number;
  lockRenewIntervalMilliseconds: number;
}

export const DEFAULT_AUTHENTICATION_TIMINGS: AuthenticationTimings = {
  loginTimeoutMilliseconds: 300_000,
  progressIntervalMilliseconds: 10_000,
  lockStaleAgeMilliseconds: 360_000,
  lockBreakStaleAgeMilliseconds: 10_000,
  lockPollIntervalMilliseconds: 1_000,
  lockReleaseTimeoutMilliseconds: 12_000,
  cookiePollIntervalMilliseconds: 1_000,
  cookieReadTimeoutMilliseconds: 5_000,
  tokenValidationTimeoutMilliseconds: 10_000,
  loginPageNavigationTimeoutMilliseconds: 30_000,
  browserLaunchTimeoutMilliseconds: 60_000,
  browserCloseTimeoutMilliseconds: 5_000,
  browserInstallationTimeoutMilliseconds: 600_000,
  installationTerminationGraceMilliseconds: 5_000,
  lockRenewIntervalMilliseconds: 30_000,
};

export const SYMBOLIC_LINK_LOOP_ERROR_CODE = 'ELOOP';
export const NOT_DIRECTORY_ERROR_CODE = 'ENOTDIR';
