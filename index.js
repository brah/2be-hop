const { Client, GatewayIntentBits, Collection, PermissionsBitField } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const config = require('./config.json');
const fs = require('node:fs');
const Rcon = require('rcon-srcds').default;

const applicationId = config.applicationId;
const guildId = config.guildId;

// MESSAGE_CONTENT is a privileged intent — enable it in the Discord Developer Portal
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

// Load commands — a file may export a single command object or an array
client.commands = new Collection();
const commands = [];
for (const file of fs.readdirSync('./commands').filter(f => f.endsWith('.js'))) {
	const loaded = require(`./commands/${file}`);
	for (const command of (Array.isArray(loaded) ? loaded : [loaded])) {
		client.commands.set(command.data.name, command);
		commands.push(command.data.toJSON());
	}
}

const rest = new REST({ version: '10' }).setToken(config.token);

(async () => {
	try {
		console.log('Refreshing slash commands');
		await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commands });
		console.log('Slash commands registered!');
	}
	catch (err) {
		console.error(err);
	}
})();

// Slash command handler
client.on('interactionCreate', async interaction => {
	if (!interaction.isChatInputCommand()) return;
	const command = client.commands.get(interaction.commandName);
	if (!command) {
		console.warn(`[index] no command found for: ${interaction.commandName}`);
		return;
	}

	async function replyWithError() {
		const content = 'There was an error executing this command.';
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply({ content });
		}
		else {
			await interaction.reply({ content, ephemeral: true });
		}
	}

	try {
		await command.execute(interaction);
	}
	catch (err) {
		console.error(`[index] error in /${interaction.commandName}:`, err);
		try { await replyWithError(); }
		catch (error_) { console.error('[index] failed to send error reply:', error_); }
	}
});

// Button handler — re-runs a command ephemerally from a button click
client.on('interactionCreate', async interaction => {
	if (!interaction.isButton()) return;

	const colonIdx = interaction.customId.indexOf(':');
	if (colonIdx === -1) return;

	const action = interaction.customId.slice(0, colonIdx);
	const mapName = interaction.customId.slice(colonIdx + 1);

	const command = client.commands.get(action);
	if (!command) return;

	// Mimics a slash interaction but ephemeral; no followUp so buttons aren't re-added
	const adapter = {
		deferred: false,
		replied:  false,
		member:   interaction.member,
		async deferReply() {
			this.deferred = true;
			await interaction.deferReply();
		},
		async editReply(content) {
			return interaction.editReply(content);
		},
		options: {
			getString(name) { return name === 'map' ? mapName : null; },
			getInteger() { return null; },
		},
	};

	try {
		await command.execute(adapter);
	}
	catch (err) {
		console.error(`[index] error in button ${action}:`, err);
		try {
			if (adapter.deferred) await interaction.editReply({ content: 'There was an error.' });
			else await interaction.reply({ content: 'There was an error.', ephemeral: true });
		}
		catch (error_) { console.error('[index] failed to send button error reply:', error_); }
	}
});

// Adapts a Discord message into the same interface as slash command execute(),
// so prefix and slash commands can share handler code.
function createMessageAdapter(message, command) {
	let sentMessage = null;
	const args = message.content.trim().split(/\s+/).slice(1);
	return {
		deferred: false,
		replied:  false,
		member:   message.member,
		async deferReply() {
			this.deferred = true;
			await message.channel.sendTyping();
		},
		async editReply(content) {
			const payload = typeof content === 'string' ? { content } : content;
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
				const idx = command.data.options?.findIndex(o => o.name === name) ?? -1;
				return idx >= 0 ? (args[idx] ?? null) : null;
			},
			getInteger(name) {
				const idx = command.data.options?.findIndex(o => o.name === name) ?? -1;
				const val = args[idx];
				return (idx >= 0 && val !== undefined) ? Number.parseInt(val, 10) : null;
			},
		},
	};
}

const PREFIX = '.';

// Prefix command handler (.command)
client.on('messageCreate', async message => {
	if (message.author.bot || !message.content.startsWith(PREFIX)) return;

	const commandName = message.content.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase();
	const command = client.commands.get(commandName);
	if (!command) return;

	const adapter = createMessageAdapter(message, command);
	try {
		await command.execute(adapter);
	}
	catch (err) {
		console.error(`[index] error in .${commandName}:`, err);
		try { await adapter.editReply('There was an error executing this command.'); }
		catch {
			// ignore
		}
	}
});

// ---------------------------------------------------------------------------
// Server status poller (pub player count + current map)
// ---------------------------------------------------------------------------
const PUB_CHANNEL_ID = '864832817749819452';
const MAP_CHANNEL_ID = '864834961508007946';
// 5 minutes
const POLL_INTERVAL_MS = 5 * 60 * 1000;

let lastPubCount = null;
let lastMapName = null;
let discordClient = null;

// Persistent RCON connection with exponential-backoff reconnection
let rcon = null;
let rconReady = false;
let rconReconnectTimer = null;
let rconReconnectDelay = 5_000;
const RCON_RECONNECT_MAX = 60_000;

async function rconConnect() {
	if (rconReconnectTimer) {
		clearTimeout(rconReconnectTimer);
		rconReconnectTimer = null;
	}
	rcon = new Rcon({
		host:     config.rconIP,
		port:     config.rconPort || 27015,
		encoding: 'utf8',
		timeout:  5000,
	});
	try {
		await rcon.authenticate(config.rconPass);
		rconReady = true;
		rconReconnectDelay = 5_000;
		console.log('[rcon] Connected');
		if (discordClient) pollChannels().catch(Function.prototype);
	}
	catch (err) {
		rconReady = false;
		console.error('[rcon] Connection failed:', err.message);
		scheduleRconReconnect();
	}
}

function scheduleRconReconnect() {
	if (rconReconnectTimer) return;
	console.log(`[rcon] Reconnecting in ${rconReconnectDelay / 1000}s`);
	rconReconnectTimer = setTimeout(() => {
		rconReconnectTimer = null;
		rconConnect();
	}, rconReconnectDelay);
	rconReconnectDelay = Math.min(rconReconnectDelay * 2, RCON_RECONNECT_MAX);
}

async function fetchServerStatus() {
	if (!rconReady) return null;
	try {
		const raw = await rcon.execute('status');
		return {
			humanCount: raw.match(/(\d+)\s*humans/i)?.[1] ?? '?',
			currentMap: raw.match(/^map\s*:\s*(\S+)/im)?.[1] ?? null,
		};
	}
	catch (err) {
		console.error('[rcon] Lost connection:', err.message);
		rconReady = false;
		scheduleRconReconnect();
		return null;
	}
}

function resolveChannel(channelId) {
	const guild = discordClient.guilds.cache.find(g => g.channels.cache.has(channelId));
	if (!guild) {
		console.error('[poller] Could not find channel', channelId, 'in any cached guild');
		return null;
	}
	const channel = guild.channels.cache.get(channelId);
	const perms = channel.permissionsFor(guild.members.me);
	const missing = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ManageChannels]
		.filter(p => !perms?.has(p));
	if (missing.length) {
		console.error(`[poller] Missing permissions on #${channel.name}:`, missing.map(p => PermissionsBitField.resolve(p).toString()).join(', '));
		return null;
	}
	return channel;
}

async function pollChannels() {
	const status = await fetchServerStatus();
	if (!status) return;

	const { humanCount, currentMap } = status;

	if (humanCount !== lastPubCount) {
		const ch = resolveChannel(PUB_CHANNEL_ID);
		if (ch) {
			try {
				await ch.setName(`🍺 Pub: ${humanCount}`);
				lastPubCount = humanCount;
				console.log(`[poller] Pub → 🍺 Pub: ${humanCount}`);
			}
			catch (err) {
				console.error(`[poller] Failed to rename pub channel — ${err.code}: ${err.message}`);
			}
		}
	}

	if (currentMap && currentMap !== lastMapName) {
		const ch = resolveChannel(MAP_CHANNEL_ID);
		if (ch) {
			try {
				await ch.setName(`🗺️ ${currentMap}`);
				lastMapName = currentMap;
				console.log(`[poller] Map → 🗺️ ${currentMap}`);
			}
			catch (err) {
				console.error(`[poller] Failed to rename map channel — ${err.code}: ${err.message}`);
			}
		}
	}
}

client.once('clientReady', c => {
	console.log('Bot ready!');
	discordClient = c;
	if (config.rconIP && config.rconPass) {
		rconConnect();
		setInterval(
			() => pollChannels().catch(err => console.error('[poller] Unexpected error:', err)),
			POLL_INTERVAL_MS,
		);
	}
});

client.login(config.token);
