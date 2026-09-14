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
/* Playwright печатает Downloading ${title} from ${url} перед каждой попыткой скачать архив, часть from может идти после ANSI-кода */
export const INSTALLATION_DOWNLOAD_START_PATTERN = /^Downloading .+ from /;
/* Заголовок архива заканчивается на (playwright chromium v1243) или (playwright ffmpeg v1011) */
export const INSTALLATION_DOWNLOAD_BUILD_NAME_PATTERN = /\(playwright ([\w-]+) v\d+\)/;
export const CHROMIUM_DOWNLOAD_COMPONENT_NAME = 'Chromium';
export const UNKNOWN_DOWNLOAD_COMPONENT_NAME = 'Browser component';
export const DOWNLOAD_COMPONENT_NAMES_BY_BUILD_NAME: ReadonlyMap<string, string> = new Map([
  ['chromium', CHROMIUM_DOWNLOAD_COMPONENT_NAME],
  ['ffmpeg', 'FFmpeg'],
]);
export const MISSING_BROWSER_EXECUTABLE_MARKER = "Executable doesn't exist";
export const MISSING_SYSTEM_DEPENDENCIES_MARKER = 'Host system is missing dependencies';
export const PROFILE_IN_USE_MARKERS = [
  'already in use by another instance of Chromium',
  'Failed to create a ProcessSingleton',
  'Opening in existing browser session',
] as const;
/* Playwright заменяет журнал запуска с No usable sandbox своим текстом Chromium sandboxing failed */
export const MISSING_SANDBOX_MARKERS = ['No usable sandbox', 'Chromium sandboxing failed'] as const;
export const DISABLE_CHROMIUM_SANDBOX_VARIABLE = 'MATTERMOST_MCP_DISABLE_CHROMIUM_SANDBOX';
export const DISABLE_CHROMIUM_SANDBOX_VALUE = '1';
export const CHROMIUM_SANDBOX_DISABLED_MESSAGE = `Chromium sandbox is disabled by ${DISABLE_CHROMIUM_SANDBOX_VARIABLE}=${DISABLE_CHROMIUM_SANDBOX_VALUE}: the sign-in window renders Mattermost content without process isolation`;
export const PROXY_ENVIRONMENT_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const;
export const URL_SCHEME_PREFIX_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
export const USER_INFORMATION_SEPARATOR = '@';
export const REDACTED_USER_INFORMATION = '***';
export const HTTP_PROTOCOL = 'http:';
export const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'] as const;
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
  BROWSER_SANDBOX_UNAVAILABLE: 'BROWSER_SANDBOX_UNAVAILABLE',
  STATE_DIRECTORY_UNSAFE: 'STATE_DIRECTORY_UNSAFE',
  UNAUTHORIZED_AFTER_RETRY: 'UNAUTHORIZED_AFTER_RETRY',
  REQUEST_CANCELLED: 'REQUEST_CANCELLED',
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
export const PROGRESS_NOTIFICATION_METHOD = 'notifications/progress';
export const AUTHENTICATION_MODE_LOG_PREFIX = 'Auth mode:';
export const SERVER_SHUTDOWN_MESSAGE = 'Shutting down Mattermost MCP Server...';

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
/* Жадный захват до последнего @ в слове: пароль прокси может содержать /, ? и # без кодирования */
export const URL_CREDENTIALS_PATTERN = /\/\/\S*@/g;
export const REDACTED_URL_CREDENTIALS = '//***@';
export const TRAILING_SLASHES_PATTERN = /\/+$/;

export const AUTHENTICATION_MODES = {
  STATIC: 'static',
  BROWSER: 'browser',
} as const;
export const AUTHORIZATION_HEADER_NAME = 'Authorization';
export const BEARER_TOKEN_PREFIX = 'Bearer ';
export const CONTENT_TYPE_HEADER_NAME = 'Content-Type';
export const JSON_CONTENT_TYPE = 'application/json';
export const HTTP_GET_METHOD = 'GET';
export const HTTP_POST_METHOD = 'POST';
export const HTTP_REDIRECT_MANUAL = 'manual';
export const HTTP_STATUS_OK = 200;
export const HTTP_STATUS_UNAUTHORIZED = 401;
export const UNKNOWN_ERROR_NAME = 'UnknownError';
export const VACANT_STEPS_BEFORE_LOGIN_NOT_COMPLETED = 2;

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
