const logger = require('./logger');
logger.init();

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');
const { Client, GatewayIntentBits, Collection, PermissionsBitField, MessageFlags } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const config = require('./config.json');
const { isNonEmptyString, isValidMapName, normalizeEndpoint } = require('./utils');
const { runRconCommand } = require('./services/rcon');
const { refreshSnapshot, getTier } = require('./services/tiers');

const PREFIX = '.';
const PUB_CHANNEL_ID = '864832817749819452';
const MAP_CHANNEL_ID = '864834961508007946';
const POLL_INTERVAL_MS = 3 * 60 * 1000;
const A2S_TIMEOUT_MS = 4000;
const PUB_CHANNEL_PREFIX = '\u{1F37A} Pub: ';
const MAP_CHANNEL_PREFIX = '\u{1F5FA}\uFE0F ';
const A2S_INFO_REQUEST = Buffer.concat([
	Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
	Buffer.from('Source Engine Query\0', 'utf8'),
]);
const S2A_INFO_RESPONSE = 0x49;
const S2C_CHALLENGE_RESPONSE = 0x41;
const MAX_TIER_RETRIES = 3;
const COMMAND_HASH_PATH = path.join(__dirname, 'data', '.command-hash');
const DISCORD_API_ERROR_CODES = {
	UnknownInteraction: 10062,
	InteractionAlreadyAcknowledged: 40060,
};

const applicationId = config.applicationId;
const commandsDirectory = path.join(__dirname, 'commands');
const clearGuildCommandsOnStartup = config.clearGuildCommandsOnStartup !== false;
const diagnosticCommandLogging = config.diagnosticCommandLogging === true;
const requiredChannelPermissions = [
	{ flag: PermissionsBitField.Flags.ViewChannel, label: 'ViewChannel' },
	{ flag: PermissionsBitField.Flags.ManageChannels, label: 'ManageChannels' },
];

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

client.commands = new Collection();
const commands = loadCommands();
const rest = isNonEmptyString(config.token)
	? new REST({ version: '10' }).setToken(config.token)
	: null;
const pollEndpoint = resolvePollEndpoint();

const pollerState = { lastPubCount: null, lastMapName: null, lastTierMap: null };
const tierRetry = { map: null, count: 0 };
let shutdownInProgress = false;
let pollInterval = null;

client.on('error', err => console.error('[discord] Client error:', err));
client.on('warn', warning => console.warn('[discord] Client warning:', warning));
client.on('shardError', err => console.error('[discord] Shard error:', err));
client.on('invalidated', () => console.error('[discord] Client session invalidated.'));

client.on('interactionCreate', interaction => {
	if (interaction.isChatInputCommand()) {
		void dispatchInteraction(interaction, `/${interaction.commandName}`, interaction.commandName, null);
	}
	else if (interaction.isButton()) {
		const colonIndex = interaction.customId.indexOf(':');
		if (colonIndex === -1) {
			console.warn(`[index] Ignoring malformed button customId: ${interaction.customId}`);
			return;
		}
		const action = interaction.customId.slice(0, colonIndex);
		const mapName = interaction.customId.slice(colonIndex + 1).trim();
		void dispatchInteraction(interaction, `button ${interaction.customId}`, action, mapName);
	}
});

client.on('messageCreate', async message => {
	if (message.author.bot || !message.content.startsWith(PREFIX) || !message.inGuild()) return;

	const commandName = message.content.slice(PREFIX.length).trim().split(/\s+/)[0]?.toLowerCase();
	if (!commandName) return;

	const command = client.commands.get(commandName);
	if (!command) return;

	const adapter = createMessageAdapter(message, command);
	try {
		await command.execute(adapter);
	}
	catch (err) {
		console.error(`[index] Error in .${commandName}:`, err);
		try {
			await adapter.editReply('There was an error executing this command.');
		}
		catch (replyError) {
			console.error('[index] Failed to send prefix command error reply:', replyError);
		}
	}
});

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

void bootstrap();

async function bootstrap() {
	if (!isNonEmptyString(config.token)) {
		console.error('[startup] Discord bot token is missing from config.json.');
		process.exitCode = 1;
		return;
	}

	try {
		await client.login(config.token);
		await waitForClientReady();
	}
	catch (err) {
		console.error('[startup] Failed to log in to Discord:', err);
		process.exitCode = 1;
		return;
	}

	// Slash command registration can transiently fail (Discord REST hiccup,
	// rate limit, etc.). Don't let that block the poller or tier refresh —
	// the existing registered commands on Discord's side remain usable.
	try {
		await registerSlashCommands();
	}
	catch (err) {
		console.error('[startup] Slash command registration failed; continuing without re-register:', err);
	}

	await onClientReady();
}

async function onClientReady() {
	console.log('Bot ready.');

	await refreshSnapshot().catch(err => console.warn('[tiers] Snapshot refresh raised:', err.message));

	if (!pollEndpoint) {
		console.warn('[poller] No status endpoint configured. Set serverIP or rconIP/rconPort.');
		return;
	}

	console.log(`[poller] Using A2S endpoint ${pollEndpoint.host}:${pollEndpoint.port}`);
	pollChannels().catch(err => console.error('[poller] Unexpected error:', err));
	pollInterval = setInterval(() => {
		pollChannels().catch(err => console.error('[poller] Unexpected error:', err));
	}, POLL_INTERVAL_MS);
	pollInterval.unref();
}

async function dispatchInteraction(interaction, context, commandName, mapName) {
	const startedAt = Date.now();

	if (diagnosticCommandLogging) {
		instrumentInteractionLifecycle(interaction, context, startedAt);
		console.log(`[diag] Received ${context} (${formatInteractionDiagnostics(interaction, startedAt)}; ${formatInteractionContext(interaction)})`);
	}

	if (!interaction.inGuild()) {
		await replyToInteraction(interaction, {
			content: mapName === null ? 'This command can only be used in a server.' : 'This button can only be used in a server.',
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (mapName !== null && !mapName) {
		await replyToInteraction(interaction, {
			content: 'That button is missing its map name.',
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const command = client.commands.get(commandName);
	if (!command) {
		console.warn(`[index] No command found for ${context}`);
		await replyToInteraction(interaction, {
			content: mapName === null ? 'That command is not available right now.' : 'That button action is no longer available.',
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const target = mapName !== null ? createButtonAdapter(interaction, mapName) : interaction;
	try {
		await command.execute(target);
		if (diagnosticCommandLogging) {
			console.log(`[diag] Completed ${context} (${formatInteractionDiagnostics(interaction, startedAt, target)}; ${formatInteractionContext(interaction)})`);
		}
	}
	catch (err) {
		await handleInteractionCommandError(context, interaction, err, target.deferred || target.replied, startedAt, target);
	}
}

function loadCommands() {
	const definitions = [];
	const commandEntries = getCommandEntries();
	for (const entry of commandEntries) {
		appendCommandsFromEntry(entry, definitions);
	}

	console.log(`[startup] Loaded ${definitions.length} command definition(s).`);
	return definitions;
}

function getCommandEntries() {
	if (!fs.existsSync(commandsDirectory)) {
		console.error(`[startup] Commands directory not found: ${commandsDirectory}`);
		return [];
	}

	return fs.readdirSync(commandsDirectory, { withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.endsWith('.js'));
}

function appendCommandsFromEntry(entry, definitions) {
	const filePath = path.join(commandsDirectory, entry.name);
	let loaded;
	try {
		loaded = require(filePath);
	}
	catch (err) {
		console.error(`[startup] Failed to load command module ${entry.name}:`, err);
		return;
	}
	if (!loaded) return;

	for (const command of (Array.isArray(loaded) ? loaded : [loaded])) {
		const definition = getCommandDefinition(command, entry.name);
		if (!definition) continue;
		if (!registerCommandDefinition(command, definition, entry.name)) continue;
		definitions.push(definition);
	}
}

function getCommandDefinition(command, entryName) {
	if (!command?.data || typeof command.execute !== 'function' || typeof command.data.toJSON !== 'function') {
		console.warn(`[startup] Skipping invalid command export in ${entryName}`);
		return null;
	}

	try {
		const definition = command.data.toJSON();
		if (!isNonEmptyString(definition?.name)) {
			console.warn(`[startup] Command in ${entryName} is missing a valid name.`);
			return null;
		}
		return definition;
	}
	catch (err) {
		console.error(`[startup] Failed to serialize command from ${entryName}:`, err);
		return null;
	}
}

function registerCommandDefinition(command, definition, entryName) {
	if (client.commands.has(definition.name)) {
		console.warn(`[startup] Duplicate command name "${definition.name}" in ${entryName}; keeping the first definition.`);
		return false;
	}

	client.commands.set(definition.name, command);
	return true;
}

// Registers slash commands only when the payload has changed since last startup.
// The hash covers the full serialized command set plus the guild-cleanup flag
// so flipping that toggle also forces a re-register. Discord caches globally
// so unnecessary PUTs just slow cold-boot and burn rate limit.
async function registerSlashCommands() {
	if (!rest) {
		console.warn('[startup] Slash command registration skipped because the bot token is missing.');
		return;
	}
	if (!isNonEmptyString(applicationId)) {
		console.warn('[startup] Slash command registration skipped because applicationId is missing.');
		return;
	}
	if (commands.length === 0) {
		console.warn('[startup] Slash command registration skipped because no commands were loaded.');
		return;
	}

	const payloadHash = hashCommandPayload(commands, clearGuildCommandsOnStartup, applicationId);
	const storedHash = readStoredCommandHash();
	if (storedHash === payloadHash) {
		console.log('[startup] Slash command payload unchanged; skipping re-registration. Delete data/.command-hash to force a re-register (e.g. after manually editing commands in Discord).');
		return;
	}

	if (clearGuildCommandsOnStartup) {
		await clearGuildCommands();
	}

	console.log('[startup] Refreshing global slash commands.');
	await rest.put(Routes.applicationCommands(applicationId), { body: commands });
	writeStoredCommandHash(payloadHash);
	console.log('[startup] Global slash commands registered.');
}

function hashCommandPayload(payload, includeGuildCleanup, appId) {
	const hash = crypto.createHash('sha256');
	hash.update(appId || '');
	hash.update(':');
	hash.update(JSON.stringify(payload));
	hash.update(includeGuildCleanup ? ':clear' : ':keep');
	return hash.digest('hex');
}

function readStoredCommandHash() {
	try {
		return fs.readFileSync(COMMAND_HASH_PATH, 'utf8').trim() || null;
	}
	catch {
		return null;
	}
}

function writeStoredCommandHash(hash) {
	try {
		fs.mkdirSync(path.dirname(COMMAND_HASH_PATH), { recursive: true });
		fs.writeFileSync(COMMAND_HASH_PATH, hash, 'utf8');
	}
	catch (err) {
		console.warn(`[startup] Failed to persist command hash: ${err.message}`);
	}
}

async function clearGuildCommands() {
	if (!client.isReady()) {
		console.warn('[startup] Guild command cleanup skipped because the client is not ready.');
		return;
	}

	const guilds = await client.guilds.fetch();
	for (const guild of guilds.values()) {
		console.log(`[startup] Clearing guild slash commands for ${guild.id}.`);
		await rest.put(Routes.applicationGuildCommands(applicationId, guild.id), { body: [] });
	}
	console.log('[startup] Guild slash commands cleared.');
}

async function waitForClientReady() {
	if (client.isReady()) return;
	await new Promise(resolve => client.once('clientReady', () => resolve()));
}

function createButtonAdapter(interaction, mapName) {
	return {
		deferred: false,
		replied: false,
		member: interaction.member,
		supportsFollowUp: false,
		async deferReply() {
			this.deferred = true;
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		},
		async editReply(content) {
			return interaction.editReply(normalizeReplyPayload(content));
		},
		options: {
			getString(name) {
				return name === 'map' ? mapName : null;
			},
			getInteger() {
				return null;
			},
		},
	};
}

function createMessageAdapter(message, command) {
	let sentMessage = null;
	const args = message.content.trim().split(/\s+/).slice(1);
	const optionDefinitions = Array.isArray(command.data?.options) ? command.data.options : [];

	return {
		deferred: false,
		replied: false,
		member: message.member,
		supportsFollowUp: false,
		async deferReply() {
			this.deferred = true;
			await message.channel.sendTyping();
		},
		async editReply(content) {
			const payload = normalizeReplyPayload(content);
			if (sentMessage) {
				sentMessage = await sentMessage.edit(payload);
			}
			else {
				sentMessage = await message.channel.send(payload);
				this.replied = true;
			}
		},
		options: {
			getString(name) {
				const index = optionDefinitions.findIndex(option => option.name === name);
				if (index === -1) return null;
				const isLastOption = index === optionDefinitions.length - 1;
				const value = isLastOption ? args.slice(index).join(' ') : args[index];
				return value ? value.trim() : null;
			},
			getInteger(name) {
				const index = optionDefinitions.findIndex(option => option.name === name);
				if (index === -1 || args[index] === undefined) return null;
				const parsed = Number.parseInt(args[index], 10);
				return Number.isNaN(parsed) ? null : parsed;
			},
		},
	};
}

function normalizeReplyPayload(content) {
	return typeof content === 'string' ? { content } : content;
}

async function replyToInteraction(interaction, payload) {
	try {
		const normalizedPayload = normalizeReplyPayload(payload);
		if (interaction.deferred || interaction.replied) {
			const editPayload = { ...normalizedPayload };
			delete editPayload.flags;
			await interaction.editReply(editPayload);
		}
		else {
			await interaction.reply(normalizedPayload);
		}
	}
	catch (err) {
		if (isHandledInteractionLifecycleError(err)) {
			console.warn(`[index] Skipping reply because the interaction is no longer replyable: ${describeDiscordApiError(err)}`);
			return;
		}
		console.error('[index] Failed to send interaction reply:', err);
	}
}

async function handleInteractionCommandError(context, interaction, err, alreadyDeferred, startedAt, adapter) {
	if (isHandledInteractionLifecycleError(err)) {
		console.warn(`[index] Ignoring ${context} failure caused by an expired or already-handled interaction: ${describeDiscordApiError(err)} (${formatInteractionDiagnostics(interaction, startedAt, adapter)}).`);
		return;
	}

	console.error(`[index] Error in ${context} (${formatInteractionDiagnostics(interaction, startedAt, adapter)}):`, err);
	const errorPayload = { content: 'There was an error executing this command.', flags: MessageFlags.Ephemeral };
	if (alreadyDeferred) {
		await replyToInteraction(interaction, { content: errorPayload.content });
	}
	else {
		await replyToInteraction(interaction, errorPayload);
	}
}

function getDiscordApiErrorCode(err) {
	return typeof err?.code === 'number' ? err.code : null;
}

function isHandledInteractionLifecycleError(err) {
	const code = getDiscordApiErrorCode(err);
	return code === DISCORD_API_ERROR_CODES.UnknownInteraction
		|| code === DISCORD_API_ERROR_CODES.InteractionAlreadyAcknowledged;
}

function describeDiscordApiError(err) {
	const code = getDiscordApiErrorCode(err);
	if (code === null) return err?.message || 'Unknown Discord API error';
	return `${code} ${err?.message || 'Discord API error'}`;
}

function formatInteractionDiagnostics(interaction, startedAt, adapter = null) {
	const ageMs = typeof interaction?.createdTimestamp === 'number'
		? Math.max(Date.now() - interaction.createdTimestamp, 0)
		: null;
	const elapsedMs = Math.max(Date.now() - startedAt, 0);
	const deferred = adapter?.deferred ?? interaction?.deferred ?? false;
	const replied = adapter?.replied ?? interaction?.replied ?? false;
	const parts = [
		`id=${interaction?.id || 'unknown'}`,
		`elapsed=${elapsedMs}ms`,
		`deferred=${deferred}`,
		`replied=${replied}`,
	];
	if (ageMs !== null) parts.push(`age=${ageMs}ms`);
	return parts.join(', ');
}

function formatInteractionContext(interaction) {
	return [
		`guild=${interaction?.guildId || 'dm'}`,
		`channel=${interaction?.channelId || 'unknown'}`,
		`user=${interaction?.user?.id || 'unknown'}`,
		`createdAt=${typeof interaction?.createdTimestamp === 'number' ? new Date(interaction.createdTimestamp).toISOString() : 'unknown'}`,
	].join(', ');
}

// Only attached when diagnostic logging is on. We wrap deferReply/reply/editReply/followUp
// to log each lifecycle step with context. Method replacement is idempotent per interaction.
const INSTRUMENTED_INTERACTION = Symbol('instrumentedInteraction');
function instrumentInteractionLifecycle(interaction, context, startedAt) {
	if (!interaction || interaction[INSTRUMENTED_INTERACTION]) return;
	interaction[INSTRUMENTED_INTERACTION] = true;

	for (const methodName of ['deferReply', 'reply', 'editReply', 'followUp']) {
		if (typeof interaction[methodName] !== 'function') continue;
		const original = interaction[methodName].bind(interaction);
		interaction[methodName] = async (...args) => {
			console.log(`[diag] ${context} calling ${methodName} (${formatInteractionDiagnostics(interaction, startedAt)})`);
			try {
				const result = await original(...args);
				console.log(`[diag] ${context} ${methodName} succeeded (${formatInteractionDiagnostics(interaction, startedAt)})`);
				return result;
			}
			catch (err) {
				const level = isHandledInteractionLifecycleError(err) ? 'warn' : 'error';
				console[level](`[index] ${context} ${methodName} failed: ${describeDiscordApiError(err)} (${formatInteractionDiagnostics(interaction, startedAt)})`);
				throw err;
			}
		};
	}
}

async function shutdown(signal) {
	if (shutdownInProgress) return;
	shutdownInProgress = true;

	console.log(`[shutdown] Received ${signal}. Closing the bot cleanly.`);

	if (pollInterval) clearInterval(pollInterval);

	try {
		if (client.isReady()) client.destroy();
	}
	catch (err) {
		console.error('[shutdown] Failed to destroy Discord client cleanly:', err);
	}

	try {
		await logger.flush();
	}
	catch (err) {
		console.error('[shutdown] Failed to flush logger queue:', err);
	}

	process.exit(0);
}

function resolvePollEndpoint() {
	const serverEndpoint = normalizeEndpoint(config.serverIP, 27015);
	if (serverEndpoint) return serverEndpoint;

	if (config.serverIP) {
		console.warn('[poller] Invalid serverIP format; expected "host:port". Falling back to rconIP/rconPort.');
	}

	return normalizeEndpoint(config.rconIP, config.rconPort || 27015);
}

function readCString(buffer, startOffset) {
	let end = startOffset;
	while (end < buffer.length && buffer[end] !== 0x00) end += 1;
	if (end >= buffer.length) {
		throw new Error('Malformed A2S string field.');
	}
	return {
		value: buffer.toString('utf8', startOffset, end),
		nextOffset: end + 1,
	};
}

function buildA2SInfoRequest(challenge) {
	return challenge ? Buffer.concat([A2S_INFO_REQUEST, challenge]) : A2S_INFO_REQUEST;
}

function sendUdpPacket(host, port, payload) {
	return new Promise((resolve, reject) => {
		const family = net.isIP(host) === 6 ? 'udp6' : 'udp4';
		const socket = dgram.createSocket(family);
		let settled = false;

		const finish = (callback) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.close();
			callback();
		};

		const timeout = setTimeout(() => finish(() => reject(new Error('A2S request timed out.'))), A2S_TIMEOUT_MS);

		socket.once('error', err => finish(() => reject(err)));
		socket.once('message', message => finish(() => resolve(message)));
		socket.send(payload, port, host, err => {
			if (err) finish(() => reject(err));
		});
	});
}

function parseA2SInfoResponse(packet) {
	if (packet.length < 6 || packet.readInt32LE(0) !== -1) {
		throw new Error('Unexpected A2S response header.');
	}

	const kind = packet.readUInt8(4);
	if (kind !== S2A_INFO_RESPONSE) {
		throw new Error(`Unexpected A2S response type: 0x${kind.toString(16)}`);
	}

	let offset = 6;
	const serverName = readCString(packet, offset); offset = serverName.nextOffset;
	const map = readCString(packet, offset); offset = map.nextOffset;
	const folder = readCString(packet, offset); offset = folder.nextOffset;
	const game = readCString(packet, offset); offset = game.nextOffset;

	if (offset + 5 > packet.length) throw new Error('A2S response truncated.');

	offset += 2;
	const players = packet.readUInt8(offset); offset += 1;
	const maxPlayers = packet.readUInt8(offset); offset += 1;
	const bots = packet.readUInt8(offset);

	return {
		serverName: serverName.value || null,
		currentMap: map.value || null,
		folder: folder.value || null,
		game: game.value || null,
		playerCount: players,
		maxPlayers,
		botCount: bots,
	};
}

async function queryA2SInfo(host, port) {
	const initial = await sendUdpPacket(host, port, buildA2SInfoRequest());
	const isChallenge = initial.length >= 9
		&& initial.readInt32LE(0) === -1
		&& initial.readUInt8(4) === S2C_CHALLENGE_RESPONSE;
	if (!isChallenge) return parseA2SInfoResponse(initial);

	const challenge = initial.subarray(5, 9);
	const challenged = await sendUdpPacket(host, port, buildA2SInfoRequest(challenge));
	return parseA2SInfoResponse(challenged);
}

async function fetchServerStatus() {
	if (!pollEndpoint) return null;
	try {
		const info = await queryA2SInfo(pollEndpoint.host, pollEndpoint.port);
		return {
			humanCount: Math.max(info.playerCount - info.botCount, 0),
			currentMap: info.currentMap,
		};
	}
	catch (err) {
		console.error('[a2s] Query failed:', err.message);
		return null;
	}
}

function resolveChannel(channelId) {
	if (!client.isReady()) return null;

	const guild = client.guilds.cache.find(candidate => candidate.channels.cache.has(channelId));
	if (!guild) {
		console.error(`[poller] Could not find channel ${channelId} in any cached guild.`);
		return null;
	}

	const channel = guild.channels.cache.get(channelId);
	if (!channel || typeof channel.setName !== 'function') {
		console.error(`[poller] Channel ${channelId} is missing or cannot be renamed.`);
		return null;
	}

	const permissions = channel.permissionsFor(guild.members.me);
	const missing = requiredChannelPermissions
		.filter(permission => !permissions?.has(permission.flag))
		.map(permission => permission.label);
	if (missing.length > 0) {
		console.error(`[poller] Missing permissions on #${channel.name}: ${missing.join(', ')}`);
		return null;
	}

	return channel;
}

async function pollChannels() {
	const status = await fetchServerStatus();
	if (!status) return;

	const { humanCount, currentMap } = status;

	if (humanCount !== pollerState.lastPubCount) {
		await updatePubChannel(humanCount);
	}

	if (currentMap && currentMap !== pollerState.lastTierMap) {
		await handleTierPushCycle(currentMap);
	}

	if (currentMap && currentMap !== pollerState.lastMapName) {
		await updateMapChannel(currentMap);
	}
}

async function updatePubChannel(humanCount) {
	const channel = resolveChannel(PUB_CHANNEL_ID);
	if (!channel) return;
	try {
		await channel.setName(`${PUB_CHANNEL_PREFIX}${humanCount}`);
		pollerState.lastPubCount = humanCount;
		console.log(`[poller] Updated pub channel to ${PUB_CHANNEL_PREFIX}${humanCount}`);
	}
	catch (err) {
		console.error(`[poller] Failed to rename pub channel: ${err.code || 'unknown'} ${err.message}`);
	}
}

async function updateMapChannel(currentMap) {
	const channel = resolveChannel(MAP_CHANNEL_ID);
	if (!channel) return;
	// Maps not in the snapshot (or canonical tier 1) fall back to T1 so the
	// channel name always carries a tier badge.
	const tier = getTier(currentMap) ?? 1;
	const newName = `${MAP_CHANNEL_PREFIX}${currentMap} (T${tier})`;
	try {
		await channel.setName(newName);
		pollerState.lastMapName = currentMap;
		console.log(`[poller] Updated map channel to ${newName}`);
	}
	catch (err) {
		console.error(`[poller] Failed to rename map channel: ${err.code || 'unknown'} ${err.message}`);
	}
}

// Wraps pushTierForMap with bounded retries so a sustained RCON outage
// doesn't spam logs every poll cycle. After MAX_TIER_RETRIES consecutive
// failures on the same map we give up and wait for the next map change.
// The retry counter is scoped to a specific map so failures on map A
// don't shorten the budget for map B.
async function handleTierPushCycle(currentMap) {
	if (currentMap !== tierRetry.map) {
		tierRetry.map = currentMap;
		tierRetry.count = 0;
	}

	let handled = false;
	try {
		handled = await pushTierForMap(currentMap);
	}
	catch (err) {
		console.warn('[tiers] Push raised:', err.message);
	}

	if (handled) {
		pollerState.lastTierMap = currentMap;
		tierRetry.map = null;
		tierRetry.count = 0;
		return;
	}

	tierRetry.count += 1;
	if (tierRetry.count >= MAX_TIER_RETRIES) {
		console.warn(`[tiers] Giving up on ${currentMap} after ${MAX_TIER_RETRIES} failed attempts; will retry on next map change.`);
		pollerState.lastTierMap = currentMap;
		tierRetry.map = null;
		tierRetry.count = 0;
	}
}

// Returns true when the map has been handled (push succeeded, or nothing
// to push). Returns false on transient RCON failures so the caller can
// retry on the next poll cycle.
//
// We use the single-argument form `sm_settier <tier>` which updates the
// currently loaded map's live in-memory tier. The two-argument form only
// updates the stored record and does not affect the running map.
async function pushTierForMap(currentMap) {
	if (!isValidMapName(currentMap)) return true;

	const tier = getTier(currentMap);
	if (tier === null) return true;

	const result = await runRconCommand(`sm_settier ${tier}`, { expectResponse: false });
	if (result.ok) {
		console.log(`[tiers] sm_settier ${tier} -> ok (map: ${currentMap})`);
		return true;
	}

	console.warn(`[tiers] sm_settier ${tier} failed for ${currentMap}: ${result.error?.message || 'unknown error'}`);
	return false;
}
