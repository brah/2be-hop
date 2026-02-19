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
const client = new Client({ intents: [Intents.FLAGS.GUILDS] });

// Create command containers
client.commands = new Collection();
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
const commands = [];

// Read command files and add them to containers
for (const file of commandFiles) {
	const command = require(`./commands/${file}`);
	client.commands.set(command.data.name, command);
	commands.push(command.data.toJSON());
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

	if (!command) return;

	if (command.requireDB) {
		try {
			await command.execute(interaction, db.con);
		}
		catch (err) {
			console.error(err);
			await interaction.reply({ content: 'There was an error executing this command.', ephemeral: true });
		}
	}
	else {
		try {
			await command.execute(interaction);
		}
		catch (err) {
			console.error(err);
			await interaction.reply({ content: 'There was an error executing this command.', ephemeral: true });
		}
	}
});

client.once('ready', () => {
	console.log('Bot ready!');
});

client.login(config.token);