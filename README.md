# BhopBot

A Discord bot for a bhop community server. The current codebase is a Node.js Discord bot only: there is no Streamlit dashboard, web panel, frontend app, database-backed admin UI, or separate API service in this repository.

## Current Scope

This repository currently contains:

- a Discord bot built with `discord.js`
- global slash command registration, limited to guild contexts
- prefix command support with `.`
- SourceJump lookups
- SourceMod/RCON server commands
- an A2S poller that renames two Discord channels
- automatic `sm_settier` updates on map change, sourced from a local snapshot of [srcwr/zones-cstrike](https://github.com/srcwr/zones-cstrike)
- webhook-backed warning/error logging
- optional diagnostic interaction logging

This repository does **not** currently contain:

- a Streamlit dashboard
- a web dashboard or browser UI
- database reads/writes used by the running bot
- background workers outside the main bot process
- tests beyond linting

## Project Layout

```text
.
|-- commands/
|   |-- global.js
|   |-- isbanned.js
|   |-- sourcemod.js
|   `-- wr.js
|-- services/
|   |-- rcon.js
|   `-- tiers.js
|-- data/
|   `-- tiers.json   (generated, gitignored)
|-- index.js
|-- logger.js
|-- utils.js
|-- config.json.example
|-- package.json
`-- eslint.config.js
```

What each file does:

- `index.js`: bot bootstrap, command loading, registration, Discord handlers, diagnostics, A2S poller, tier auto-push
- `logger.js`: console patching, webhook forwarding, log flushing
- `utils.js`: SourceJump fetch helpers, Steam avatar lookup, embed helpers
- `services/rcon.js`: shared RCON connection lifecycle (`runRconCommand`)
- `services/tiers.js`: srcwr snapshot download, parse, cache, and tier lookup
- `commands/global.js`: global WR lookup
- `commands/wr.js`: server WR + global WR lookup
- `commands/isbanned.js`: SourceJump ban lookup by Steam ID/profile URL
- `commands/sourcemod.js`: RCON-backed server commands

## Requirements

- Node.js 18+ recommended
- a Discord application and bot token
- a Source engine server with:
  - RCON enabled for SourceMod commands
  - A2S query access for polling
- a SourceJump API key

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your local config:

```bash
copy config.json.example config.json
```

If you are not on Windows, copy the file manually or use your platform equivalent.

3. Fill in `config.json`.

4. Run the bot:

```bash
node .
```

## Configuration

The bot reads runtime configuration from `config.json`.

### Used by the current code

- `token`: Discord bot token
- `applicationId`: Discord application ID
- `rconIP`: RCON host
- `rconPass`: RCON password
- `rconPort`: RCON port, usually `27015`
- `serverIP`: A2S query endpoint in `host:port` format
- `adminRoles`: Discord role IDs allowed to use `/setmap`
- `adminUsers`: Discord user IDs allowed to use `/setmap`, independent of role membership. A member passes the admin check if they are in `adminUsers` OR hold a role listed in `adminRoles`.
- `SJ_API_KEY`: SourceJump API key
- `logWebhook`: optional Discord webhook for forwarded warnings/errors
- `clearGuildCommandsOnStartup`: defaults to `true`; clears stale guild-scoped commands from every guild the bot is in before re-registering the global command set
- `diagnosticCommandLogging`: defaults to `false`; enables verbose interaction lifecycle logging

Notes:

- If `serverIP` is invalid or missing, the A2S poller falls back to `rconIP:rconPort`.
- The bot does not currently read any database config fields.
- The bot does not currently use role comment metadata or any dashboard-related config.

## Commands

All slash commands are registered globally, but constrained to guild/server contexts with `setContexts(InteractionContextType.Guild)`.

### SourceJump

- `/global map:<map>`: show the global world record for a map
- `/wr map:<map>`: show the configured server WR plus the global WR
- `/isbanned user:<steamid-or-steamcommunity-url>`: check whether a player is banned on SourceJump

Implementation details:

- `/global` adds an ephemeral `Server WR` button for the same map
- `/wr` identifies server records by matching SourceJump run IPs against `serverIP` and `rconIP/rconPort`
- `/isbanned` accepts Steam IDs, `steamcommunity.com/profiles/...` URLs, and vanity `steamcommunity.com/id/...` URLs

### SourceMod / RCON

- `/online`: show current online players with ping
- `/map`: show the current map
- `/nextmap`: show the next map
- `/timeleft`: show the map timer
- `/thetime`: show current Australia/Sydney time
- `/setmap map:<map>`: change the current map, restricted to configured admin roles

Implementation details:

- `/map` adds ephemeral buttons for `Global record` and `Server WR`
- `/setmap` rejects map names unless they match `^[A-Za-z0-9_./-]+$`
- RCON failures are caught and returned as command replies instead of crashing the process

### Prefix Commands

The bot also supports prefix commands in guild text channels using `.`.

Examples:

```text
.map
.online
.wr bhop_mapname
.setmap bhop_example
```

Notes:

- Prefix commands only work in guilds
- Prefix parsing is positional and follows the slash option order
- Prefix replies are normal channel messages
- Button follow-ups are only available for real Discord interactions, not prefix commands

## Startup and Registration

On boot, the bot:

1. loads command modules from `commands/`
2. logs in to Discord
3. waits for the client to become ready
4. hashes the serialized command payload and compares it to the last-registered hash in `data/.command-hash`
5. if the hash differs, optionally clears stale guild-scoped slash commands and re-registers the current command set globally
6. refreshes the tier snapshot and starts the A2S poller

Important notes:

- Command registration is global, not guild-specific
- Slash command registration is skipped on restart when the payload hasn't changed, to avoid unnecessary API calls
- Guild cleanup exists only to remove old duplicates from previous guild-scoped versions
- Global slash command propagation can take longer than guild command propagation

## Poller

The bot polls the game server with A2S every 3 minutes and:

- renames a pub-count Discord channel
- renames a current-map Discord channel
- pushes the canonical map tier via `sm_settier <tier>` (single-argument form, which updates the currently loaded map's live in-memory tier) whenever the current map changes

Current limitations:

- the channel IDs are hardcoded in `index.js` as `PUB_CHANNEL_ID` and `MAP_CHANNEL_ID`
- they are not configurable through `config.json`

The bot needs permission to:

- view those channels
- manage those channels

## Map Tiers

Tier data is sourced from the public [srcwr/zones-cstrike](https://github.com/srcwr/zones-cstrike) repository (the `i/<map>.json` files). On startup the bot downloads the repository tarball, extracts every per-map tier file, and writes a flat `data/tiers.json` snapshot. The snapshot is refreshed only if it is missing or older than 7 days.

When the A2S poller detects that the current map has changed, the bot looks up that map in the snapshot and runs `sm_settier <tier>` exactly once via RCON. Important behaviors:

- **Single-arg form.** The bot sends `sm_settier <tier>`, which updates the live in-memory tier of the currently loaded map. The two-argument form (`sm_settier <map> <tier>`) only updates the stored record and does not affect the running map, so it is not used.
- **No maplist enumeration.** The bot never asks the server "what maps do you have?" — it only ever pushes the tier for the map that just loaded.
- **Defaults are skipped.** Maps whose canonical tier is `1` (the SourceMod default) or `0` are excluded from the snapshot at build time, so the bot never wastes an RCON call on them.
- **Maps not in srcwr are skipped silently.** If srcwr has no tier for the current map, the bot leaves the server's existing setting in place.
- **RCON failures are non-fatal and bounded.** If the push fails, the bot retries on subsequent poll cycles for that same map up to 3 times, then gives up until the next map change.
- **Snapshot fetch failures are non-fatal.** If the tarball download fails, the bot falls back to the existing cached snapshot. If no cache exists, the tier index stays empty and tier pushes are silently skipped.

The snapshot file is gitignored — it is regenerated on first boot.

## Logging and Diagnostics

`logger.js` currently:

- patches `console.log`, `console.warn`, and `console.error`
- prefixes console output with an ISO timestamp and PID
- forwards warnings and errors to `logWebhook` when configured
- rate-limits queued webhook delivery
- bounds the queue to avoid unbounded memory growth
- flushes pending logs on shutdown when possible

`index.js` also:

- handles common Discord interaction lifecycle errors such as expired or already-acknowledged interactions without cascading failures
- optionally logs detailed interaction diagnostics when `diagnosticCommandLogging` is enabled
- wraps interaction methods like `deferReply`, `reply`, `editReply`, and `followUp` for diagnostic tracing

Diagnostic logging is intentionally noisy and is meant for troubleshooting, not normal day-to-day production logs.

## Deployment Notes

- Run only one live bot instance per token
- Multiple live instances can cause interaction conflicts such as `Unknown interaction`
- If you are still cleaning up old guild-scoped commands, leave `clearGuildCommandsOnStartup` enabled
- Use `diagnosticCommandLogging` temporarily when chasing interaction timing/acknowledgement issues

## PM2

Install PM2 if needed:

```bash
npm install -g pm2
```

Start the bot:

```bash
pm2 start index.js --name bhopbot
```

Useful commands:

```bash
pm2 status
pm2 logs bhopbot
pm2 restart bhopbot
pm2 stop bhopbot
pm2 delete bhopbot
pm2 save
```

## Scripts

```bash
npm start   # run the bot
npm run lint # lint the codebase
```

## What Needs Cleanup Later

These are the main repo/documentation mismatches or rough edges still visible in the code:

- poller channel IDs are hardcoded in `index.js` (intentional — set-and-forget for a single deployment)
- there are no automated tests beyond linting
