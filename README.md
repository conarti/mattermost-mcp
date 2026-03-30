# Mattermost MCP Server

MCP Server for the Mattermost API, enabling Claude and other MCP clients to interact with Mattermost workspaces.

## Hosted deployment

A hosted deployment is available on [Fronteir AI](https://fronteir.ai/mcp/conarti-mattermost-mcp).

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
| `MATTERMOST_TOKEN` | Mattermost personal access token |
| `MATTERMOST_TEAM_ID` | Mattermost team ID |

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
  - token (--token or MATTERMOST_TOKEN)
  - teamId (--team-id or MATTERMOST_TEAM_ID)
```

Make sure you've provided all required configuration via CLI arguments, environment variables, or config file.

### Permission Errors

Verify that:
1. Your personal access token has the necessary permissions
2. The token is correctly set
3. The Mattermost URL and team ID are correct

## License

MIT License
