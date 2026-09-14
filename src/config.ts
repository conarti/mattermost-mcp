import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  AUTHENTICATION_MODES,
  BROWSERS_DIRECTORY_NAME,
  CHROMIUM_INSTALL_ARGUMENTS,
  CONFIG_DIRECTORY_NAME,
  HTTP_PROTOCOL,
  LOOPBACK_HOSTNAMES,
  PLAYWRIGHT_BROWSERS_PATH_VARIABLE,
  PLAYWRIGHT_NPX_PACKAGE,
  PROFILE_DIRECTORY_NAME,
  STATE_DIRECTORY_NAME,
  TOKEN_FILE_NAME,
} from './authentication/constants.js';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface MonitoringConfig {
  enabled: boolean;
  schedule: string;  // Cron format
  channels: string[];  // Channel names to monitor
  topics: string[];  // Topics to look for
  messageLimit: number;  // Number of recent messages to analyze per check
  notificationChannelId?: string;  // Where to send notifications (optional, will use DM if not provided)
  userId?: string;  // User ID for mentions (optional, will be auto-detected if not provided)
}

export interface Config {
  mattermostUrl: string;
  token: string;
  teamId: string;
  monitoring?: MonitoringConfig;
}

/**
 * Parse CLI arguments into a key-value map
 * Supports: --key=value and --key value formats
 */
function parseCliArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      // Handle --key=value format
      if (arg.includes('=')) {
        const [key, value] = arg.slice(2).split('=');
        args[key] = value;
      }
      // Handle --key value format
      else {
        const key = arg.slice(2);
        const nextArg = argv[i + 1];
        if (nextArg && !nextArg.startsWith('--')) {
          args[key] = nextArg;
          i++; // Skip the value in next iteration
        } else {
          args[key] = 'true'; // Flag without value
        }
      }
    }
  }

  return args;
}

/**
 * Display help message and exit
 */
export function showHelp(): void {
  const stateDirectory = `~/${CONFIG_DIRECTORY_NAME}/${STATE_DIRECTORY_NAME}`;
  const help = `
Mattermost MCP Server

USAGE:
  mattermost-mcp [OPTIONS]
  npx @conarti/mattermost-mcp [OPTIONS]

OPTIONS:
  --url <url>          Mattermost API URL (e.g., https://mattermost.example.com/api/v4)
  --token <token>      Mattermost personal access token (optional, see BROWSER SIGN-IN)
  --team-id <id>       Mattermost team ID
  --run-monitoring     Run topic monitoring immediately on startup
  --exit-after-monitoring  Exit after running monitoring (use with --run-monitoring)
  --help               Show this help message

ENVIRONMENT VARIABLES:
  MATTERMOST_URL       Mattermost API URL
  MATTERMOST_TOKEN     Mattermost personal access token (optional, see BROWSER SIGN-IN)
  MATTERMOST_TEAM_ID   Mattermost team ID

BROWSER SIGN-IN (no token):
  Without a token the server signs in to Mattermost through a visible Chromium window.
  The window opens on the first tool call that needs sign-in and waits up to 5 minutes.
  The session token, browser profile and Chromium builds are kept in ${stateDirectory}.
  On the first sign-in Chromium (about 150 MiB) is downloaded automatically into
  ${stateDirectory}/${BROWSERS_DIRECTORY_NAME}. If the download fails, install it manually:
    ${PLAYWRIGHT_BROWSERS_PATH_VARIABLE}=${stateDirectory}/${BROWSERS_DIRECTORY_NAME} npx ${PLAYWRIGHT_NPX_PACKAGE} ${CHROMIUM_INSTALL_ARGUMENTS.join(' ')}
  Reset the session only:
    rm -rf ${stateDirectory}/${PROFILE_DIRECTORY_NAME} ${stateDirectory}/${TOKEN_FILE_NAME}
  Reset everything (Chromium is downloaded again on the next sign-in):
    rm -rf ${stateDirectory}

CONFIGURATION FILES (checked in order):
  1. config.local.json  (for local overrides, gitignored)
  2. config.json        (default configuration)

PRIORITY (highest to lowest):
  CLI arguments > Environment variables > config.local.json > config.json

EXAMPLES:
  # Using CLI arguments
  mattermost-mcp --url https://mm.example.com/api/v4 --token xoxp-xxx --team-id abc123

  # Using environment variables
  MATTERMOST_URL=https://mm.example.com/api/v4 MATTERMOST_TOKEN=xoxp-xxx MATTERMOST_TEAM_ID=abc123 mattermost-mcp

  # Using config file (create config.local.json or config.json)
  mattermost-mcp

CLAUDE CODE INTEGRATION:
  Add to your Claude Code MCP settings:

  {
    "mcpServers": {
      "mattermost": {
        "command": "npx",
        "args": ["-y", "@conarti/mattermost-mcp"],
        "env": {
          "MATTERMOST_URL": "https://your-mattermost.com/api/v4",
          "MATTERMOST_TOKEN": "your-token",
          "MATTERMOST_TEAM_ID": "your-team-id"
        }
      }
    }
  }

  Browser sign-in without a token:

  {
    "mcpServers": {
      "mattermost": {
        "command": "npx",
        "args": ["-y", "@conarti/mattermost-mcp"],
        "env": {
          "MATTERMOST_URL": "https://your-mattermost.com/api/v4",
          "MATTERMOST_TEAM_ID": "your-team-id"
        }
      }
    }
  }
`;

  console.log(help);
  process.exit(0);
}

/**
 * Load configuration from file
 */
function loadConfigFromFile(): Partial<Config> | null {
  // First try to load from config.local.json
  const localConfigPath = path.resolve(__dirname, '../config.local.json');

  if (fs.existsSync(localConfigPath)) {
    try {
      const configData = fs.readFileSync(localConfigPath, 'utf8');
      return JSON.parse(configData) as Config;
    } catch (error) {
      console.error('Error reading config.local.json:', error);
    }
  }

  // Fall back to config.json
  const configPath = path.resolve(__dirname, '../config.json');

  if (fs.existsSync(configPath)) {
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configData) as Config;
    } catch (error) {
      console.error('Error reading config.json:', error);
    }
  }

  return null;
}

/**
 * Load configuration with priority: CLI args > ENV vars > config files
 */
export function loadConfig(): Config {
  const cliArgs = parseCliArgs();

  // Show help if requested
  if (cliArgs['help'] === 'true') {
    showHelp();
  }

  // Load base config from file (if exists)
  const fileConfig = loadConfigFromFile() || {};

  // Build config with priority: CLI > ENV > file
  const config: Config = {
    mattermostUrl:
      cliArgs['url'] ||
      process.env.MATTERMOST_URL ||
      fileConfig.mattermostUrl ||
      '',
    token:
      cliArgs['token'] ||
      process.env.MATTERMOST_TOKEN ||
      fileConfig.token ||
      '',
    teamId:
      cliArgs['team-id'] ||
      process.env.MATTERMOST_TEAM_ID ||
      fileConfig.teamId ||
      '',
    monitoring: fileConfig.monitoring,
  };

  // Validate required fields
  validateConfig(config);

  // Log config source (for debugging)
  const sources: string[] = [];
  if (cliArgs['url'] || cliArgs['token'] || cliArgs['team-id']) {
    sources.push('CLI arguments');
  }
  if (process.env.MATTERMOST_URL || process.env.MATTERMOST_TOKEN || process.env.MATTERMOST_TEAM_ID) {
    sources.push('environment variables');
  }
  if (fileConfig.mattermostUrl || fileConfig.token || fileConfig.teamId) {
    sources.push('config file');
  }

  if (sources.length > 0) {
    console.error(`Configuration loaded from: ${sources.join(', ')}`);
  }

  return config;
}

export type AuthenticationMode = typeof AUTHENTICATION_MODES[keyof typeof AUTHENTICATION_MODES];

/**
 * Предупреждение для браузерного входа по http на хост вне loopback: пароль в окне и токен идут без шифрования.
 * @returns текст предупреждения или undefined, если адрес безопасен или не разбирается
 */
export function describeUnencryptedMattermostUrl(mattermostUrl: string): string | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(mattermostUrl);
  } catch {
    return undefined;
  }
  const loopbackHostnames: readonly string[] = LOOPBACK_HOSTNAMES;
  if (parsedUrl.protocol !== HTTP_PROTOCOL || loopbackHostnames.includes(parsedUrl.hostname)) {
    return undefined;
  }
  return `MATTERMOST_URL uses http:// for ${parsedUrl.hostname}: the password entered in the sign-in window and the session token are sent without encryption. Use https://.`;
}

/** Та же проверка истинности токена, что была в validateConfig: любой непустой токен включает статический режим */
export function resolveAuthenticationMode(config: Config): AuthenticationMode {
  return config.token ? AUTHENTICATION_MODES.STATIC : AUTHENTICATION_MODES.BROWSER;
}

/**
 * Helper function to validate config
 */
export function validateConfig(config: Config): void {
  const missing: string[] = [];

  if (!config.mattermostUrl) {
    missing.push('mattermostUrl (--url or MATTERMOST_URL)');
  }
  if (!config.teamId) {
    missing.push('teamId (--team-id or MATTERMOST_TEAM_ID)');
  }

  if (missing.length > 0) {
    console.error('\nMissing required configuration:');
    missing.forEach(m => console.error(`  - ${m}`));
    console.error('\nRun with --help for usage information.\n');
    process.exit(1);
  }

  // Validate monitoring config if enabled
  if (config.monitoring?.enabled) {
    if (!config.monitoring.schedule) {
      throw new Error('Missing schedule in monitoring configuration');
    }
    if (!config.monitoring.channels || config.monitoring.channels.length === 0) {
      throw new Error('No channels specified in monitoring configuration');
    }
    if (!config.monitoring.topics || config.monitoring.topics.length === 0) {
      throw new Error('No topics specified in monitoring configuration');
    }
  }
}
