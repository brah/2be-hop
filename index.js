const logger = require('./logger');

const path = require('node:path');
const fs = require('node:fs');
const dgram = require('node:dgram');
const net = require('node:net');
const { Client, GatewayIntentBits, Collection, PermissionsBitField, MessageFlags } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const config = require('./config.json');
const { isNonEmptyString } = require('./utils');
const { runRconCommand } = require('./services/rcon');
const { refreshSnapshot, getTier } = require('./services/tiers');

const VALID_MAP_NAME = /^[A-Za-z0-9_./-]+$/;

const applicationId = config.applicationId;
const commandsDirectory = path.join(__dirname, 'commands');
const clearGuildCommandsOnStartup = config.clearGuildCommandsOnStartup !== false;
const diagnosticCommandLogging = config.diagnosticCommandLogging === true;

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

client.on('interactionCreate', async interaction => {
	if (!interaction.isChatInputCommand()) return;
	const commandContext = `/${interaction.commandName}`;
	const startedAt = Date.now();

	instrumentInteractionLifecycle(interaction, commandContext, startedAt);
	logInteractionReceipt(commandContext, interaction);

	if (!interaction.inGuild()) {
		await replyToInteraction(interaction, {
			content: 'This command can only be used in a server.',
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const command = client.commands.get(interaction.commandName);
	if (!command) {
		console.warn(`[index] No command found for /${interaction.commandName}`);
		await replyToInteraction(interaction, {
			content: 'That command is not available right now.',
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		await command.execute(interaction);
		logInteractionCompletion(commandContext, interaction, startedAt);
	}
	catch (err) {
		await handleInteractionCommandError(commandContext, interaction, err, interaction.deferred || interaction.replied, startedAt);
	}
});

client.on('interactionCreate', async interaction => {
	if (!interaction.isButton()) return;
	const buttonContext = `button ${interaction.customId}`;
	const startedAt = Date.now();

	instrumentInteractionLifecycle(interaction, buttonContext, startedAt);
	logInteractionReceipt(buttonContext, interaction);

	if (!interaction.inGuild()) {
		await replyToInteraction(interaction, {
			content: 'This button can only be used in a server.',
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const colonIndex = interaction.customId.indexOf(':');
	if (colonIndex === -1) {
		console.warn(`[index] Ignoring malformed button customId: ${interaction.customId}`);
		return;
	}

	const action = interaction.customId.slice(0, colonIndex);
	const mapName = interaction.customId.slice(colonIndex + 1).trim();
	if (!mapName) {
		await replyToInteraction(interaction, {
			content: 'That button is missing its map name.',
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const command = client.commands.get(action);
	if (!command) {
		console.warn(`[index] No command found for button action: ${action}`);
		await replyToInteraction(interaction, {
			content: 'That button action is no longer available.',
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const adapter = createButtonAdapter(interaction, mapName);
	try {
		await command.execute(adapter);
		logInteractionCompletion(buttonContext, interaction, startedAt, adapter);
	}
	catch (err) {
		await handleInteractionCommandError(buttonContext, interaction, err, adapter.deferred, startedAt, adapter);
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

const PREFIX = '.';
const PUB_CHANNEL_ID = '864832817749819452';
const MAP_CHANNEL_ID = '864834961508007946';
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const A2S_TIMEOUT_MS = 4000;
const PUB_CHANNEL_PREFIX = '\u{1F37A} Pub: ';
const MAP_CHANNEL_PREFIX = '\u{1F5FA}\uFE0F ';
const A2S_INFO_REQUEST = Buffer.concat([
	Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
	Buffer.from('Source Engine Query\0', 'utf8'),
]);
const S2A_INFO_RESPONSE = 0x49;
const S2C_CHALLENGE_RESPONSE = 0x41;
const pollEndpoint = resolvePollEndpoint();
const requiredChannelPermissions = [
	{ flag: PermissionsBitField.Flags.ViewChannel, label: 'ViewChannel' },
	{ flag: PermissionsBitField.Flags.ManageChannels, label: 'ManageChannels' },
];
const DISCORD_API_ERROR_CODES = {
	UnknownInteraction: 10062,
	InteractionAlreadyAcknowledged: 40060,
};
const INSTRUMENTED_INTERACTION = Symbol('instrumentedInteraction');

let lastPubCount = null;
let lastMapName = null;
let lastTierMap = null;
let tierRetryMap = null;
let tierRetryCount = 0;
const MAX_TIER_RETRIES = 3;
let discordClient = null;
let shutdownInProgress = false;

client.on('error', err => {
	console.error('[discord] Client error:', err);
});

client.on('warn', warning => {
	console.warn('[discord] Client warning:', warning);
});

client.on('shardError', err => {
	console.error('[discord] Shard error:', err);
});

client.on('invalidated', () => {
	console.error('[discord] Client session invalidated.');
});

process.once('SIGINT', () => {
	void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
	void shutdown('SIGTERM');
});

client.once('clientReady', async readyClient => {
	console.log('Bot ready.');
	discordClient = readyClient;

	await refreshSnapshot().catch(err => console.warn('[tiers] Snapshot refresh raised:', err.message));

	if (!pollEndpoint) {
		console.warn('[poller] No status endpoint configured. Set serverIP or rconIP/rconPort.');
		return;
	}

	console.log(`[poller] Using A2S endpoint ${pollEndpoint.host}:${pollEndpoint.port}`);
	pollChannels().catch(err => console.error('[poller] Unexpected error:', err));

	const interval = setInterval(() => {
		pollChannels().catch(err => console.error('[poller] Unexpected error:', err));
	}, POLL_INTERVAL_MS);
	interval.unref();
});

void bootstrap();

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
	const loaded = loadCommandModule(entry);
	if (!loaded) return;

	for (const command of (Array.isArray(loaded) ? loaded : [loaded])) {
		const definition = getCommandDefinition(command, entry.name);
		if (!definition) continue;
		if (!registerCommandDefinition(command, definition, entry.name)) continue;
		definitions.push(definition);
	}
}

function loadCommandModule(entry) {
	const filePath = path.join(commandsDirectory, entry.name);
	try {
		return require(filePath);
	}
	catch (err) {
		console.error(`[startup] Failed to load command module ${entry.name}:`, err);
		return null;
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

async function bootstrap() {
	const hasToken = isNonEmptyString(config.token);
	if (hasToken) {
		try {
			await client.login(config.token);
			await waitForClientReady();
			await registerSlashCommands();
		}
		catch (err) {
			console.error('[startup] Failed during bot startup:', err);
			process.exitCode = 1;
		}
		return;
	}

	console.error('[startup] Discord bot token is missing from config.json.');
	process.exitCode = 1;
}

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

	if (clearGuildCommandsOnStartup) {
		await clearGuildCommands();
	}

	console.log('[startup] Refreshing global slash commands.');
	await rest.put(Routes.applicationCommands(applicationId), { body: commands });
	console.log('[startup] Global slash commands registered.');
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

	await new Promise(resolve => {
		client.once('clientReady', () => {
			resolve();
		});
	});
}

function createButtonAdapter(interaction, mapName) {
	return {
		deferred: false,
		replied: false,
		member: interaction.member,
		async deferReply() {
			this.deferred = true;
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		},
		async editReply(content) {
			const payload = normalizeReplyPayload(content);
			return interaction.editReply(payload);
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

async function replyWithError(interaction, alreadyDeferred = interaction.deferred || interaction.replied) {
	const payload = { content: 'There was an error executing this command.', flags: MessageFlags.Ephemeral };
	if (alreadyDeferred) {
		await replyToInteraction(interaction, { content: payload.content });
		return;
	}
	await replyToInteraction(interaction, payload);
}

async function handleInteractionCommandError(context, interaction, err, alreadyDeferred = interaction.deferred || interaction.replied, startedAt = Date.now(), adapter = null) {
	if (isHandledInteractionLifecycleError(err)) {
		console.warn(`[index] Ignoring ${context} failure caused by an expired or already-handled interaction: ${describeDiscordApiError(err)} (${formatInteractionDiagnostics(interaction, startedAt, adapter)}). Likely causes: another bot instance handled it first, the process restarted mid-command, or Discord delivered the interaction too late to acknowledge.`);
		return;
	}

	console.error(`[index] Error in ${context} (${formatInteractionDiagnostics(interaction, startedAt, adapter)}):`, err);
	await replyWithError(interaction, alreadyDeferred);
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

function getInteractionAgeMs(interaction) {
	return typeof interaction?.createdTimestamp === 'number'
		? Math.max(Date.now() - interaction.createdTimestamp, 0)
		: null;
}

function formatInteractionDiagnostics(interaction, startedAt, adapter = null) {
	const ageMs = getInteractionAgeMs(interaction);
	const elapsedMs = Math.max(Date.now() - startedAt, 0);
	const deferred = adapter?.deferred ?? interaction?.deferred ?? false;
	const replied = adapter?.replied ?? interaction?.replied ?? false;
	const parts = [
		`id=${interaction?.id || 'unknown'}`,
		`elapsed=${elapsedMs}ms`,
		`deferred=${deferred}`,
		`replied=${replied}`,
	];
	if (ageMs !== null) {
		parts.push(`age=${ageMs}ms`);
	}
	return parts.join(', ');
}

function formatInteractionContext(interaction) {
	const parts = [
		`guild=${interaction?.guildId || 'dm'}`,
		`channel=${interaction?.channelId || 'unknown'}`,
		`user=${interaction?.user?.id || 'unknown'}`,
		`app=${interaction?.applicationId || client.application?.id || 'unknown'}`,
		`clientUser=${client.user?.id || 'unknown'}`,
		`createdAt=${typeof interaction?.createdTimestamp === 'number' ? new Date(interaction.createdTimestamp).toISOString() : 'unknown'}`,
	];
	return parts.join(', ');
}

function instrumentInteractionLifecycle(interaction, context, startedAt) {
	if (!interaction || interaction[INSTRUMENTED_INTERACTION]) return;
	interaction[INSTRUMENTED_INTERACTION] = true;

	wrapInteractionMethod(interaction, 'deferReply', context, startedAt);
	wrapInteractionMethod(interaction, 'reply', context, startedAt);
	wrapInteractionMethod(interaction, 'editReply', context, startedAt);
	wrapInteractionMethod(interaction, 'followUp', context, startedAt);
}

function wrapInteractionMethod(interaction, methodName, context, startedAt) {
	if (typeof interaction[methodName] !== 'function') return;

	const originalMethod = interaction[methodName].bind(interaction);
	interaction[methodName] = async (...args) => {
		if (diagnosticCommandLogging) {
			console.log(`[diag] ${context} calling ${methodName} (${formatInteractionDiagnostics(interaction, startedAt)}; ${formatInteractionContext(interaction)})`);
		}

		try {
			const result = await originalMethod(...args);
			if (diagnosticCommandLogging) {
				console.log(`[diag] ${context} ${methodName} succeeded (${formatInteractionDiagnostics(interaction, startedAt)}; ${formatInteractionContext(interaction)})`);
			}
			return result;
		}
		catch (err) {
			const level = isHandledInteractionLifecycleError(err) ? 'warn' : 'error';
			console[level](`[index] ${context} ${methodName} failed: ${describeDiscordApiError(err)} (${formatInteractionDiagnostics(interaction, startedAt)}; ${formatInteractionContext(interaction)})`);
			throw err;
		}
	};
}

function logInteractionReceipt(context, interaction) {
	if (!diagnosticCommandLogging) return;
	console.log(`[diag] Received ${context} (${formatInteractionDiagnostics(interaction, Date.now())}; ${formatInteractionContext(interaction)})`);
}

function logInteractionCompletion(context, interaction, startedAt, adapter = null) {
	if (!diagnosticCommandLogging) return;
	console.log(`[diag] Completed ${context} (${formatInteractionDiagnostics(interaction, startedAt, adapter)}; ${formatInteractionContext(interaction)})`);
}

async function shutdown(signal) {
	if (shutdownInProgress) return;
	shutdownInProgress = true;

	console.log(`[shutdown] Received ${signal}. Closing the bot cleanly.`);

	try {
		if (client.isReady()) {
			client.destroy();
		}
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

function parseAddress(value, fallbackPort) {
	if (!isNonEmptyString(value)) return null;
	try {
		const parsed = new URL(value.includes('://') ? value : `udp://${value}`);
		const port = parsed.port ? Number.parseInt(parsed.port, 10) : fallbackPort;
		if (!parsed.hostname || Number.isNaN(port)) return null;
		return {
			host: parsed.hostname,
			port,
		};
	}
	catch {
		return null;
	}
}

function resolvePollEndpoint() {
	if (config.serverIP) {
		const endpoint = parseAddress(config.serverIP, 27015);
		if (endpoint) return endpoint;
		console.warn('[poller] Invalid serverIP format; expected "host:port". Falling back to rconIP/rconPort.');
	}

	if (config.rconIP) {
		return {
			host: config.rconIP,
			port: config.rconPort || 27015,
		};
	}

	return null;
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
	return challenge
		? Buffer.concat([A2S_INFO_REQUEST, challenge])
		: A2S_INFO_REQUEST;
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

		const timeout = setTimeout(() => {
			finish(() => reject(new Error('A2S request timed out.')));
		}, A2S_TIMEOUT_MS);

		socket.once('error', err => {
			finish(() => reject(err));
		});

		socket.once('message', message => {
			finish(() => resolve(message));
		});

		socket.send(payload, port, host, err => {
			if (!err) return;
			finish(() => reject(err));
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
	const serverName = readCString(packet, offset);
	offset = serverName.nextOffset;
	const map = readCString(packet, offset);
	offset = map.nextOffset;
	const folder = readCString(packet, offset);
	offset = folder.nextOffset;
	const game = readCString(packet, offset);
	offset = game.nextOffset;

	if (offset + 5 > packet.length) {
		throw new Error('A2S response truncated.');
	}

	offset += 2;
	const players = packet.readUInt8(offset);
	offset += 1;
	const maxPlayers = packet.readUInt8(offset);
	offset += 1;
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
	if (!isChallenge) {
		return parseA2SInfoResponse(initial);
	}

	const challenge = initial.subarray(5, 9);
	const challenged = await sendUdpPacket(host, port, buildA2SInfoRequest(challenge));
	return parseA2SInfoResponse(challenged);
}

async function fetchServerStatus() {
	if (!pollEndpoint) return null;

	try {
		const info = await queryA2SInfo(pollEndpoint.host, pollEndpoint.port);
		const humans = Math.max(info.playerCount - info.botCount, 0);
		return {
			humanCount: humans.toString(),
			currentMap: info.currentMap,
		};
	}
	catch (err) {
		console.error('[a2s] Query failed:', err.message);
		return null;
	}
}

function resolveChannel(channelId) {
	if (!discordClient?.isReady()) return null;

	const guild = discordClient.guilds.cache.find(candidate => candidate.channels.cache.has(channelId));
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

	if (humanCount !== lastPubCount) {
		await updatePubChannel(humanCount);
	}

	if (currentMap && currentMap !== lastTierMap) {
		await handleTierPushCycle(currentMap);
	}

	if (currentMap && currentMap !== lastMapName) {
		await updateMapChannel(currentMap);
	}
}

async function updatePubChannel(humanCount) {
	const channel = resolveChannel(PUB_CHANNEL_ID);
	if (!channel) return;
	try {
		await channel.setName(`${PUB_CHANNEL_PREFIX}${humanCount}`);
		lastPubCount = humanCount;
		console.log(`[poller] Updated pub channel to ${PUB_CHANNEL_PREFIX}${humanCount}`);
	}
	catch (err) {
		console.error(`[poller] Failed to rename pub channel: ${err.code || 'unknown'} ${err.message}`);
	}
}

async function updateMapChannel(currentMap) {
	const channel = resolveChannel(MAP_CHANNEL_ID);
	if (!channel) return;
	// Maps not in the snapshot (or tier 1, the server default) fall back to T1
	// so the channel name always carries a tier badge.
	const tier = getTier(currentMap) ?? 1;
	const newName = `${MAP_CHANNEL_PREFIX}${currentMap} (T${tier})`;
	try {
		await channel.setName(newName);
		lastMapName = currentMap;
		console.log(`[poller] Updated map channel to ${newName}`);
	}
	catch (err) {
		console.error(`[poller] Failed to rename map channel: ${err.code || 'unknown'} ${err.message}`);
	}
}

// Wraps pushTierForMap with bounded retries so a sustained RCON outage
// doesn't spam logs and reconnect attempts every poll cycle. After
// MAX_TIER_RETRIES consecutive failures on the same map, we give up and
// wait for the next actual map change to try again. The retry counter is
// scoped to a specific map via tierRetryMap so failures on map A don't
// shorten the retry budget for map B when the server moves on.
async function handleTierPushCycle(currentMap) {
	if (currentMap !== tierRetryMap) {
		tierRetryMap = currentMap;
		tierRetryCount = 0;
	}

	let handled = false;
	try {
		handled = await pushTierForMap(currentMap);
	}
	catch (err) {
		console.warn('[tiers] Push raised:', err.message);
	}

	if (handled) {
		lastTierMap = currentMap;
		tierRetryMap = null;
		tierRetryCount = 0;
		return;
	}

	tierRetryCount += 1;
	if (tierRetryCount >= MAX_TIER_RETRIES) {
		console.warn(`[tiers] Giving up on ${currentMap} after ${MAX_TIER_RETRIES} failed attempts; will retry on next map change.`);
		lastTierMap = currentMap;
		tierRetryMap = null;
		tierRetryCount = 0;
	}
}

// Returns true when the map has been "handled" (push succeeded, or there is
// nothing to push because the map is invalid or unknown to the snapshot).
// Returns false on transient failures so the caller can retry on the next
// poll cycle without skipping over the map.
async function pushTierForMap(currentMap) {
	if (!VALID_MAP_NAME.test(currentMap)) {
		console.warn(`[tiers] Refusing to push tier for invalid map name: ${currentMap}`);
		return true;
	}

	const tier = getTier(currentMap);
	if (tier === null) {
		console.log(`[tiers] No tier known for ${currentMap}; leaving server default in place.`);
		return true;
	}

	const result = await runRconCommand(`sm_settier ${currentMap} ${tier}`);
	if (result.ok) {
		console.log(`[tiers] sm_settier ${currentMap} ${tier} -> ok`);
		return true;
	}

	console.warn(`[tiers] sm_settier ${currentMap} ${tier} failed: ${result.error?.message || 'unknown error'}`);
	return false;
}
