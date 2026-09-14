# Mattermost MCP Server

MCP Server for the Mattermost API, enabling Claude and other MCP clients to interact with Mattermost workspaces.

## Quick Start

### Using npx (recommended)

```bash
npx @conarti/mattermost-mcp --help
```

### Using environment variables

```bash
MATTERMOST_URL=https://your-mattermost.com/api/v4 \
MATTERMOST_TOKEN=your-token \
MATTERMOST_TEAM_ID=your-team-id \
npx @conarti/mattermost-mcp
```

### Using CLI arguments

```bash
npx @conarti/mattermost-mcp \
  --url https://your-mattermost.com/api/v4 \
  --token your-token \
  --team-id your-team-id
```

## Installation

### Option 1: npx (no installation needed)

```bash
npx @conarti/mattermost-mcp
```

### Option 2: Global installation

```bash
npm install -g @conarti/mattermost-mcp
mattermost-mcp --help
```

### Option 3: Clone and build

```bash
git clone https://github.com/conarti/mattermost-mcp.git
cd mattermost-mcp
npm install
npm run build
npm start
```

## Browser sign-in (no token)

`MATTERMOST_TOKEN` is optional. Without a token the server signs in to Mattermost through a visible Chromium window and keeps the session token for you. With `MATTERMOST_TOKEN` set, the server works as before (static mode): no browser window, no Chromium download, and `~/.config/mattermost-mcp` is not created.

### First sign-in

1. Configure the server with `MATTERMOST_URL` and `MATTERMOST_TEAM_ID` only, without a token (see [Claude Code Integration](#claude-code-integration) and [opencode](#opencode) below).
2. Call any Mattermost tool. The server opens a Chromium window with the Mattermost login page.
3. Sign in the way you usually do (password, SSO, MFA). You have up to 5 minutes.
4. The window closes by itself as soon as the session is valid, and the tool call returns its result.

While the call waits, the server sends progress notifications every 10 seconds, so clients that show MCP progress display the current step. The window opens only from a tool call: never at server startup and never from background monitoring.

### Chromium is downloaded automatically

No manual installation is needed.

- On the first sign-in the server downloads Chromium and ffmpeg for Playwright 1.63.0 (about 150 MiB on macOS arm64) into `~/.config/mattermost-mcp/browsers`. The client shows the progress as `Downloading Chromium for Mattermost sign-in`.
- The first call takes longer: the download is limited to 10 minutes, and the 5 minutes for sign-in start after the download has finished.
- After an update of this package to a version with another Playwright version, the matching Chromium build is downloaded the same way.
- Behind a proxy or with a download mirror, set `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `PLAYWRIGHT_DOWNLOAD_HOST` or `PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT` in the `env` of the MCP server entry.
- The shared Playwright cache (`~/Library/Caches/ms-playwright` on macOS) is not used: Playwright installations in other projects remove builds that no project references.
- If the download fails, the error contains the reason and a manual command as a fallback, see [Browser sign-in problems](#browser-sign-in-problems).
- On Linux without the system libraries for Chromium, a one-time `install-deps` command is needed, see [Browser sign-in problems](#browser-sign-in-problems).

### What is stored where

Everything lives in `~/.config/mattermost-mcp/` (permissions 0700):

- `browsers/`: Chromium builds for the sign-in window.
- `profile/`: the Chromium profile with the Mattermost session. It is as sensitive as the token because cookies in it are not encrypted. Exclude it from dotfiles sync and backups.
- `token`: the session token (permissions 0600), bound to the server address.
- `login.lock` and `login.lock.break`: short-lived lock files that let several server processes share one sign-in window.
- `tmp/`: temporary files of the Chromium download, removed after the installation.

### Resetting the session

Remove only the session (the next tool call opens the sign-in window again):

```bash
rm -rf ~/.config/mattermost-mcp/profile ~/.config/mattermost-mcp/token
```

Remove everything, including Chromium (it is downloaded again on the next sign-in):

```bash
rm -rf ~/.config/mattermost-mcp
```

Both commands are safe while the sign-in window is open.

### Several clients

Claude Code, opencode and other clients on the same machine share one token file and one sign-in window. If several clients need sign-in at the same time, only one window opens, and all waiting calls continue after you sign in. Background topic monitoring never opens the window: it skips the run until a tool call has signed in.

### opencode

Example of an opencode entry without a token:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mattermost": {
      "type": "local",
      "command": ["npx", "-y", "@conarti/mattermost-mcp@latest"],
      "environment": {
        "MATTERMOST_URL": "https://your-mattermost.com/api/v4",
        "MATTERMOST_TEAM_ID": "your-team-id"
      },
      "timeout": 360000
    }
  },
  "experimental": {
    "mcp_timeout": 360000
  }
}
```

### Client timeouts

The first tool call can take several minutes: the Chromium download and then up to 5 minutes of sign-in. Progress notifications every 10 seconds keep the call alive in clients that pass a `progressToken` and reset their timeout on progress.

- opencode: set `mcp.mattermost.timeout` and `experimental.mcp_timeout` to `360000` (6 minutes) as in the example above. Some opencode versions apply a hard request timeout that progress notifications do not extend.
- A client that does not pass a `progressToken` can cancel the first call during the Chromium download. The download then stops and starts from the beginning on the next call. Raise the client timeout, or run the manual installation command from [Browser sign-in problems](#browser-sign-in-problems) once.

### Limitations

- One Mattermost server per operating system user. A token file of another server is ignored. The addresses are normalized before the comparison, so `/api/v4`, a trailing slash and the letter case of the host do not matter.
- If clients with different `MATTERMOST_URL` values sign in at the same time, the waiting call gets `LOGIN_NOT_COMPLETED`, and the window for the second server opens only when you call the tool again. Its token replaces the token of the first server, and the first server opens the window again on its next call.
- Do not enable `DEBUG=pw:*` for the server: Playwright debug output prints cookies.
- Windows is not supported.

## Configuration

The server supports multiple configuration methods with the following priority (highest to lowest):

1. **CLI arguments** (`--url`, `--token`, `--team-id`)
2. **Environment variables** (`MATTERMOST_URL`, `MATTERMOST_TOKEN`, `MATTERMOST_TEAM_ID`)
3. **config.local.json** (for local overrides, gitignored)
4. **config.json** (default configuration)

### CLI Arguments

| Argument | Description |
|----------|-------------|
| `--url <url>` | Mattermost API URL (e.g., https://mattermost.example.com/api/v4) |
| `--token <token>` | Mattermost personal access token |
| `--team-id <id>` | Mattermost team ID |
| `--run-monitoring` | Run topic monitoring immediately on startup |
| `--exit-after-monitoring` | Exit after running monitoring (use with --run-monitoring) |
| `--help` | Show help message |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MATTERMOST_URL` | Mattermost API URL |
| `MATTERMOST_TOKEN` | Mattermost personal access token (optional: without it the server uses [browser sign-in](#browser-sign-in-no-token)) |
| `MATTERMOST_TEAM_ID` | Mattermost team ID |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Proxy for the automatic Chromium download in browser sign-in |
| `PLAYWRIGHT_DOWNLOAD_HOST`, `PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT` | Mirror and connection timeout for the automatic Chromium download |

### Configuration File

Create `config.local.json` (gitignored) or use `config.json`:

```json
{
  "mattermostUrl": "https://your-mattermost-instance.com/api/v4",
  "token": "your-personal-access-token",
  "teamId": "your-team-id",
  "monitoring": {
    "enabled": false,
    "schedule": "*/15 * * * *",
    "channels": ["town-square", "off-topic"],
    "topics": ["tv series", "champions league"],
    "messageLimit": 50
  }
}
```

## Claude Code Integration

Add to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "npx",
      "args": ["-y", "@conarti/mattermost-mcp@latest"],
      "env": {
        "MATTERMOST_URL": "https://your-mattermost.com/api/v4",
        "MATTERMOST_TOKEN": "your-token",
        "MATTERMOST_TEAM_ID": "your-team-id"
      }
    }
  }
}
```

Or using a config file:

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "node",
      "args": ["/path/to/mattermost-mcp/build/index.js"]
    }
  }
}
```

Or without a token, with [browser sign-in](#browser-sign-in-no-token):

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "npx",
      "args": ["-y", "@conarti/mattermost-mcp@latest"],
      "env": {
        "MATTERMOST_URL": "https://your-mattermost.com/api/v4",
        "MATTERMOST_TEAM_ID": "your-team-id"
      }
    }
  }
}
```

The first tool call opens the sign-in window and, on the first sign-in, downloads Chromium.

## Features

### Channel Tools

| Tool | Description |
|------|-------------|
| `mattermost_list_channels` | List channels in the workspace (public, private, and DMs) |
| `mattermost_get_channel_history` | Get messages from a channel with filtering options |

#### `mattermost_list_channels` Options

- `limit` (default: 100): Maximum number of channels to return
- `page` (default: 0): Page number for pagination
- `include_private` (default: false): If true, returns all channels including private channels and direct messages (DMs)

#### `mattermost_get_channel_history` Options

- `channel_id` (required): The ID of the channel
- `limit`: Number of messages to retrieve. **If not specified or 0, returns ALL messages**
- `page` (default: 0): Page number for pagination (only used when limit > 0)
- `since_date`: ISO 8601 date to get messages after (e.g., "2025-01-15")
- `before_date`: ISO 8601 date to get messages before. Use with `since_date` for date ranges
- `before_post_id`: Get messages before this post ID (cursor pagination)
- `after_post_id`: Get messages after this post ID (cursor pagination)

**Examples:**

```javascript
// Get ALL messages from a channel
{ "channel_id": "abc123" }

// Get last 50 messages
{ "channel_id": "abc123", "limit": 50 }

// Get all messages from December 18, 2025
{ "channel_id": "abc123", "since_date": "2025-12-18", "before_date": "2025-12-19" }

// Get messages from a specific date onwards
{ "channel_id": "abc123", "since_date": "2025-12-15" }
```

### Message Tools

| Tool | Description |
|------|-------------|
| `mattermost_post_message` | Post a new message to a channel |
| `mattermost_reply_to_thread` | Reply to a specific message thread |
| `mattermost_add_reaction` | Add an emoji reaction to a message |
| `mattermost_get_thread_replies` | Get all replies in a thread |

### User Tools

| Tool | Description |
|------|-------------|
| `mattermost_get_users` | Get a list of users in the workspace |
| `mattermost_get_user_profile` | Get detailed profile information for a user |

### Monitoring Tools

| Tool | Description |
|------|-------------|
| `mattermost_run_monitoring` | Trigger topic monitoring immediately |

## Topic Monitoring

The server includes a topic monitoring system that can:
- Monitor specified channels for messages containing topics of interest
- Run on a configurable schedule (using cron syntax)
- Send notifications when relevant topics are discussed

### Configuration

```json
{
  "monitoring": {
    "enabled": true,
    "schedule": "*/15 * * * *",
    "channels": ["general", "random"],
    "topics": ["important", "urgent"],
    "messageLimit": 50,
    "notificationChannelId": "optional-channel-id",
    "userId": "optional-user-id"
  }
}
```

### Running Monitoring Manually

```bash
# Run monitoring and continue server
mattermost-mcp --run-monitoring

# Run monitoring and exit (useful for cron jobs)
mattermost-mcp --run-monitoring --exit-after-monitoring
```

## Getting Your Credentials

### Mattermost URL
Your Mattermost API URL is typically: `https://your-mattermost-domain.com/api/v4`

### Personal Access Token
1. Go to **Account Settings** > **Security** > **Personal Access Tokens**
2. Click **Create Token**
3. Give it a description and create
4. Copy the token (it won't be shown again)

### Team ID
1. Go to your team in Mattermost
2. Open browser developer tools (F12)
3. Go to **Network** tab
4. Refresh the page
5. Look for API calls containing `teams/` — the ID is in the URL

Or use the Mattermost API:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-mattermost.com/api/v4/teams
```

## Troubleshooting

### Missing Configuration Error

```
Missing required configuration:
  - mattermostUrl (--url or MATTERMOST_URL)
  - teamId (--team-id or MATTERMOST_TEAM_ID)
```

Make sure you've provided the Mattermost URL and team ID via CLI arguments, environment variables, or config file. The token is not required: without it the server uses [browser sign-in](#browser-sign-in-no-token).

### Permission Errors

Verify that:
1. The Mattermost user has the necessary permissions: the owner of the personal access token, or the user you signed in as in the browser window
2. With a token, the token is correctly set
3. The Mattermost URL and team ID are correct

To sign in as another user in browser sign-in, [reset the session](#resetting-the-session) and call a tool again.

### Browser sign-in problems

Error messages start with a code in brackets.

`[BROWSER_INSTALLATION_FAILED]`: the automatic Chromium download failed. The error contains the reason, for example a proxy or network error. Fix the reason and call the tool again. As a fallback, install Chromium manually once:

```bash
PLAYWRIGHT_BROWSERS_PATH=~/.config/mattermost-mcp/browsers npx playwright@1.63.0 install chromium --no-shell
```

When you run this command manually, a framed `WARNING: It looks like you are running 'npx playwright install' without first installing your project's dependencies` is expected and can be ignored.

If the error mentions an active `__dirlock`, another Chromium installation is still running, for example started by another client: wait for it and call the tool again. If no installation is running, the file stayed after a crash, and you can remove it with the command from the error text.

`[BROWSER_SYSTEM_DEPENDENCIES_MISSING]` (Linux): Chromium was downloaded but cannot start without system libraries. Install them once:

```bash
sudo npx playwright@1.63.0 install-deps chromium
```

`[LOGIN_WINDOW_CLOSED]`, `[LOGIN_TIMEOUT]`, `[LOGIN_NOT_COMPLETED]`: the window was closed, sign-in took longer than 5 minutes, or sign-in in another client ended without a session. Call the tool again to open the window.

`[LOGIN_PROFILE_BUSY]`: another Chromium window uses the sign-in profile. Close the other Mattermost sign-in window and call the tool again.

`[AUTHENTICATION_REQUIRED]` in monitoring logs: background monitoring does not open the sign-in window. Call any Mattermost tool to sign in.

`[STATE_DIRECTORY_UNSAFE]`: `~/.config/mattermost-mcp` is a symbolic link, is not a directory or belongs to another user. Remove or fix it and call the tool again.

`[REQUEST_CANCELLED]`: the client cancelled the call, for example by its timeout, while the sign-in window was open. The request was not sent, so nothing was posted twice. Sign-in continues in the window, call the tool again after signing in.

## License

MIT License
