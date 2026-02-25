const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const Rcon = require('rcon-srcds').default;

function createRcon() {
	return new Rcon({
		host:     config.rconIP,
		port:     config.rconPort || 27015,
		encoding: 'utf8',
		timeout:  5000,
	});
}

// Connects to RCON, runs fn(rcon), disconnects. Handles errors and replies.
async function withRcon(interaction, fn) {
	if (!config.rconIP || !config.rconPass) {
		return interaction.editReply('RCON is not configured.');
	}
	const rcon = createRcon();
	try {
		await rcon.authenticate(config.rconPass);
		return await fn(rcon);
	}
	catch (err) {
		console.error('[sourcemod] RCON error:', err);
		return interaction.editReply(`Could not reach the server: ${err.message}`);
	}
	finally {
		try { await rcon.disconnect(); }
		catch {
			// ignore
		}
	}
}

// Parses the raw output of the RCON "status" command.
function parseStatus(raw) {
	const lines = raw.split('\n');

	const mapLine = lines.find(l => /^map\s*:/i.test(l));
	const currentMap = mapLine
		? mapLine.replace(/^map\s*:\s*/i, '').split(' ')[0].trim()
		: 'Unknown';

	// Format: "players : 1 humans, 5 bots (24 max)"
	const playerCountLine = lines.find(l => /^players\s*:/i.test(l));
	let humanCount = '?', maxPlayers = '?';
	if (playerCountLine) {
		const m = playerCountLine.match(/(\d+)\s*humans.*?\((\d+)\s*max\)/i);
		if (m) {
			humanCount = m[1];
			maxPlayers = m[2];
		}
	}

	// Player rows begin with "# <number>".
	// Human row: #  97 "name" [U:1:xxx] 09:01  32  0 active
	// Bot row:   #  92 "name" BOT               active
	// Bots have no connected/ping/loss fields — filtered out by checking for a numeric ping.
	const playerLines = lines.filter(l => /^#\s+\d+/.test(l));
	const players = playerLines
		.map(l => {
			const nameMatch = l.match(/"([^"]*)"/);
			const name = nameMatch ? nameMatch[1] : 'Unknown';
			// Strip the quoted name, then split remaining fields
			// Fields: 0=# 1=userid 2=uniqueid 3=connected 4=ping 5=loss 6=state
			const rest = l.replace(/"[^"]*"/, '').trim().split(/\s+/);
			const ping = rest[4] || '?';
			return { name, ping };
		})
		.filter(p => p.ping !== '?' && !Number.isNaN(Number(p.ping)));

	return { currentMap, humanCount, maxPlayers, players };
}

// Returns the current Sydney time in the format: "The time is: 2:28PM Friday 20 February, 2026"
function sydneyTimeString() {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Australia/Sydney',
		weekday:  'long',
		day:      'numeric',
		month:    'long',
		year:     'numeric',
		hour:     'numeric',
		minute:   '2-digit',
		hour12:   true,
	}).formatToParts(new Date());
	const get = type => parts.find(p => p.type === type)?.value ?? '';
	return `The time is: ${get('hour')}:${get('minute')}${get('dayPeriod')} ${get('weekday')} ${get('day')} ${get('month')}, ${get('year')}`;
}

function isAdmin(interaction) {
	const adminRoles = config.adminRoles;
	if (!Array.isArray(adminRoles) || adminRoles.length === 0) return false;
	return adminRoles.some(id => interaction.member.roles.cache.has(String(id)));
}

module.exports = [
	{
		data: new SlashCommandBuilder()
			.setName('online')
			.setDescription('Show players currently on the server'),
		async execute(interaction) {
			await interaction.deferReply();
			return withRcon(interaction, async rcon => {
				const raw = await rcon.execute('status');
				const { currentMap, humanCount, maxPlayers, players } = parseStatus(raw);
				const playerList = players.length > 0
					? players.map(p => `• ${p.name} (${p.ping}ms)`).join('\n')
					: 'No players are currently online.';
				return interaction.editReply(`[SM] Players (${humanCount}/${maxPlayers}) on ${currentMap}:\n${playerList}`);
			});
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('map')
			.setDescription('Show the current map'),
		async execute(interaction) {
			await interaction.deferReply();
			return withRcon(interaction, async rcon => {
				const raw = await rcon.execute('status');
				const { currentMap } = parseStatus(raw);
				await interaction.editReply(`[SM] Current Map: ${currentMap}`);
				if (typeof interaction.followUp === 'function') {
					const row = new ActionRowBuilder().addComponents(
						new ButtonBuilder()
							.setCustomId(`global:${currentMap}`)
							.setLabel('Global record')
							.setStyle(ButtonStyle.Secondary),
						new ButtonBuilder()
							.setCustomId(`wr:${currentMap}`)
							.setLabel('Server WR')
							.setStyle(ButtonStyle.Secondary),
					);
					await interaction.followUp({ components: [row], ephemeral: true }).catch(Function.prototype);
				}
			});
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('nextmap')
			.setDescription('Show the next map'),
		async execute(interaction) {
			await interaction.deferReply();
			return withRcon(interaction, async rcon => {
				const raw = await rcon.execute('sm_nextmap');
				// Format: "sm_nextmap" = "bhop_axn_easy" ( def. "" )
				const match = raw.match(/"sm_nextmap"\s*=\s*"([^"]+)"/);
				const nextMap = match ? match[1] : raw.trim() || 'Unknown';
				return interaction.editReply(`[SM] Next Map: ${nextMap}`);
			});
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('timeleft')
			.setDescription('Show time left on the current map'),
		async execute(interaction) {
			await interaction.deferReply();
			return withRcon(interaction, async rcon => {
				const raw = await rcon.execute('timeleft');
				// Extract the first MM:SS or H:MM:SS time pattern from the response
				const match = raw.match(/(\d+:\d+(?::\d+)?)/);
				const timeLeft = match ? match[1] : raw.trim() || 'Unknown';
				return interaction.editReply(`[SM] Time Left: ${timeLeft}`);
			});
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('thetime')
			.setDescription('Show the current server time'),
		async execute(interaction) {
			await interaction.deferReply();
			return interaction.editReply(sydneyTimeString());
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('setmap')
			.setDescription('Change the current map (admin only)')
			.addStringOption(option =>
				option.setName('map')
					.setDescription('Map name to change to')
					.setRequired(true)),
		async execute(interaction) {
			await interaction.deferReply();
			if (!isAdmin(interaction)) {
				return interaction.editReply('[SM] You do not have permission to use this command.');
			}
			const map = interaction.options.getString('map');
			return withRcon(interaction, async rcon => {
				await rcon.execute(`changelevel ${map}`);
				return interaction.editReply(`[SM] Changing map to: ${map}`);
			});
		},
	},
];
