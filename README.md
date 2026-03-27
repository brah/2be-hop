# BhopBot

Discord bot for a bhop community server. It provides SourceMod/RCON utilities, SourceJump lookups, and a server-status poller that updates Discord channel names with the current pub count and map.

## Features

- Global slash commands, limited to guild/server use
- Prefix command support with `.command`
- SourceJump commands:
  - `/global`
  - `/wr`
  - `/isbanned`
- SourceMod/RCON commands:
  - `/online`
  - `/map`
  - `/nextmap`
  - `/timeleft`
  - `/thetime`
  - `/setmap`
- Button shortcuts between map/world-record lookups
- A2S server polling for pub player count and current map
- Webhook-backed warning/error logging
- Graceful handling for common Discord interaction lifecycle errors

## Requirements

- Node.js 18+ recommended
- A Discord bot application and token
- A Source engine server with:
  - A2S query access for polling
  - RCON access for SourceMod commands
- A SourceJump API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy `config.json.example` to `config.json`.

3. Fill in the config values.

## Config

`config.json` supports:

- `token`: Discord bot token
- `applicationId`: Discord application ID
- `rconIP`: game server RCON host
- `rconPass`: RCON password
- `rconPort`: RCON port, usually `27015`
- `serverIP`: game server query endpoint in `host:port` format
- `adminRoles`: Discord role IDs allowed to use `/setmap`
- `SJ_API_KEY`: SourceJump API key
- `logWebhook`: optional Discord webhook for warnings/errors
- `clearGuildCommandsOnStartup`: when `true`, removes old guild-scoped commands before registering the global command set

Notes:

- Commands are registered globally, but they are configured for guild contexts only.
- `clearGuildCommandsOnStartup` is useful while migrating from guild commands to global commands and preventing duplicate slash entries.

## Running Locally

Start the bot with:

```bash
node .
```

Expected startup flow:

- load commands
- log in to Discord
- clear old guild commands if enabled
- register global commands
- start the A2S poller

## PM2

Install PM2 globally if needed:

```bash
npm install -g pm2
```

Start the bot:

```bash
pm2 start index.js --name bhopbot
```

Useful PM2 commands:

```bash
pm2 status
pm2 logs bhopbot
pm2 restart bhopbot
pm2 stop bhopbot
pm2 delete bhopbot
pm2 save
```

To restart the bot after deploy:

```bash
pm2 restart bhopbot
```

## Commands

### SourceJump

- `/global map:<map>`: show the global world record for a map
- `/wr map:<map>`: show server WR and global WR for a map
- `/isbanned user:<steamid-or-profile-url>`: check whether a player is banned on SourceJump

### SourceMod / Server

- `/online`: list online players and their ping
- `/map`: show current map
- `/nextmap`: show next map
- `/timeleft`: show time remaining on current map
- `/thetime`: show current server time in Australia/Sydney
- `/setmap map:<map>`: change the map, restricted to configured admin roles

### Prefix Commands

Prefix commands use `.` and share the same handlers as slash commands where possible.

Examples:

```text
.map
.online
.wr bhop_mapname
```

## Logging

- `console.warn` and `console.error` are mirrored to `logWebhook` when configured
- log delivery is queued and rate-limited
- on normal shutdown, the bot attempts to flush pending log messages
- common Discord interaction expiry/already-acknowledged errors are handled quietly to avoid noisy cascades

## Deployment Notes

- Run only one instance of the bot per token
- If two instances are online at once, Discord interactions can fail with `Unknown interaction`
- Global command changes can take longer to propagate than guild command changes
- If you previously used guild commands, leave `clearGuildCommandsOnStartup` enabled until stale guild commands are gone

## Verification

Lint the project with:

```bash
npx eslint .
```
