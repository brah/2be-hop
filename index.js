// Import required dependencies
const { Client, Intents, Collection } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const config = require('./config.json');
const fs = require('fs');
const db = require('./db');

const applicationId = config.applicationId;
const guildId = config.guildId;

// Instantiate a new Discord client with permitted intents
// MESSAGE_CONTENT is a privileged intent — enable it in the Discord Developer Portal
const client = new Client({
	intents: [
		Intents.FLAGS.GUILDS,
		Intents.FLAGS.GUILD_MESSAGES,
		Intents.FLAGS.MESSAGE_CONTENT,
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
const rest = new REST({ version: '9' }).setToken(config.token);

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
	if (!interaction.isCommand()) return;
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
		if (command.requireDB) {
			await command.execute(interaction, db.con);
		}
		else {
			await command.execute(interaction);
		}
	}
	catch (err) {
		console.error(`[index] error in /${interaction.commandName}:`, err);
		try { await replyWithError(); }
		catch (replyErr) { console.error('[index] failed to send error reply:', replyErr); }
	}
});

// Adapts a Discord message into the same interface the slash command execute()
// functions expect (deferReply / editReply), so prefix and slash commands share code.
function createMessageAdapter(message) {
	let sentMessage = null;
	const adapter = {
		deferred: false,
		replied:  false,
		async deferReply() {
			this.deferred = true;
			await message.channel.sendTyping();
		},
		async editReply(content) {
			const payload = typeof content === 'string' ? content : (content.content ?? '');
			if (sentMessage) {
				sentMessage = await sentMessage.edit(payload);
			}
			else {
				sentMessage = await message.channel.send(payload);
				this.replied = true;
			}
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

	const adapter = createMessageAdapter(message);
	try {
		if (command.requireDB) {
			await command.execute(adapter, db.con);
		}
		else {
			await command.execute(adapter);
		}
	}
	catch (err) {
		console.error(`[index] error in .${commandName}:`, err);
		try {
			await adapter.editReply('There was an error executing this command.');
		}
		catch (_) { /* ignore */ }
	}
});

client.once('ready', () => {
	console.log('Bot ready!');
});

client.login(config.token);