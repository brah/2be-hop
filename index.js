// Import required dependencies
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const config = require('./config.json');
const fs = require('node:fs');
const Rcon = require('srcds-rcon');

const applicationId = config.applicationId;
const guildId = config.guildId;

// Instantiate a new Discord client with permitted intents
// MESSAGE_CONTENT is a privileged intent — enable it in the Discord Developer Portal
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

// Create command containers
client.commands = new Collection();
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
const commands = [];

// Read command files and add them to containers
// A file may export a single command object or an array of command objects
for (const file of commandFiles) {
	const loaded = require(`./commands/${file}`);
	const commandList = Array.isArray(loaded) ? loaded : [loaded];
	for (const command of commandList) {
		client.commands.set(command.data.name, command);
		commands.push(command.data.toJSON());
	}
}

// Create a Discord.js REST API object
const rest = new REST({ version: '10' }).setToken(config.token);

// Register slash commands with Discord's API
(async () => {
	try {
		console.log('Refreshing slash commands');
		await rest.put(
			Routes.applicationGuildCommands(applicationId, guildId),
			{ body: commands },
		);
		console.log('Slash commands registered!');
	}
	catch (err) {
		console.error(err);
	}
})();

// Interaction handler
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

// Adapts a Discord message into the same interface the slash command execute()
// functions expect (deferReply / editReply / options), so prefix and slash commands share code.
function createMessageAdapter(message, command) {
	let sentMessage = null;
	const args = message.content.trim().split(/\s+/).slice(1);
	const adapter = {
		deferred: false,
		replied:  false,
		member: message.member,
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
	return adapter;
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
		try {
			await adapter.editReply('There was an error executing this command.');
		}
		catch {
			// ignore
		}
	}
});

// ---------------------------------------------------------------------------
// Pub channel player-count poller
// ---------------------------------------------------------------------------
const PUB_CHANNEL_ID = '864832817749819452';
// 5 minutes
const POLL_INTERVAL_MS = 5 * 60 * 1000;

let lastPubCount = null;

async function fetchHumanCount() {
	if (!config.rconIP || !config.rconPass) return null;
	const rcon = Rcon({
		address:  `${config.rconIP}:${config.rconPort || 27015}`,
		password: config.rconPass,
	});
	try {
		await rcon.connect();
		const raw = await rcon.command('status', 5000);
		const m = raw.match(/(\d+)\s*humans/i);
		return m ? m[1] : '?';
	}
	catch (err) {
		console.error('[pub-poller] RCON error:', err.message);
		return null;
	}
	finally {
		try {
			await rcon.disconnect();
		}
		catch {
			// ignore
		}
	}
}

async function updatePubChannel(discordClient) {
	// Resolve channel from the guild cache to ensure proper guild context
	const guild = discordClient.guilds.cache.find(g => g.channels.cache.has(PUB_CHANNEL_ID));
	const channel = guild?.channels.cache.get(PUB_CHANNEL_ID) ?? null;
	if (!channel) {
		console.error('[pub-poller] Could not find channel', PUB_CHANNEL_ID, 'in any cached guild');
		return;
	}

	const me = guild.members.me;
	const perms = channel.permissionsFor(me);
	const missing = ['ViewChannel', 'ManageChannels'].filter(p => !perms?.has(p));
	if (missing.length) {
		console.error('[pub-poller] Bot is missing channel permissions:', missing.join(', '));
		return;
	}

	const humanCount = await fetchHumanCount();
	if (humanCount === null) return;

	// Skip the API call if the count hasn't changed
	if (humanCount === lastPubCount) return;

	try {
		await discordClient.rest.patch(Routes.channel(PUB_CHANNEL_ID), { body: { name: `🍺 Pub: ${humanCount}` } });
		lastPubCount = humanCount;
	}
	catch (err) {
		console.error(`[pub-poller] Failed to update channel name — code:${err.code} status:${err.status} message:${err.message}`);
	}
}

client.once('clientReady', async () => {
	console.log('Bot ready!');

	void updatePubChannel(client).catch(err => console.error('[pub-poller] Unexpected error:', err));
	setInterval(
		() => updatePubChannel(client).catch(err => console.error('[pub-poller] Unexpected error:', err)),
		POLL_INTERVAL_MS,
	);
});

client.login(config.token);