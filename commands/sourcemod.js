const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, MessageFlags } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const { runRconCommand } = require('../services/rcon');

// Interaction-aware wrapper around runRconCommand. Hands the caller a
// minimal `rcon`-like shim with `.execute()` so existing command bodies
// keep working unchanged.
async function withRcon(interaction, fn) {
	const shim = {
		async execute(command) {
			const result = await runRconCommand(command);
			if (!result.ok) throw result.error;
			return result.output;
		},
	};

	try {
		return await fn(shim);
	}
	catch (err) {
		console.error('[sourcemod] RCON error:', err);
		return interaction.editReply(`Could not reach the server: ${err.message}`);
	}
}

// Parses the raw output of the RCON "status" command.
function parseStatus(raw) {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return {
			currentMap: 'Unknown',
			humanCount: '?',
			maxPlayers: '?',
			players: [],
		};
	}

	const lines = raw.split('\n');

	const mapLine = lines.find(line => /^map\s*:/i.test(line));
	const currentMap = mapLine
		? mapLine.replace(/^map\s*:\s*/i, '').split(' ')[0].trim()
		: 'Unknown';

	const playerCountLine = lines.find(line => /^players\s*:/i.test(line));
	let humanCount = '?';
	let maxPlayers = '?';
	if (playerCountLine) {
		const match = /(\d+)\s*humans.*?\((\d+)\s*max\)/i.exec(playerCountLine);
		if (match) {
			humanCount = match[1];
			maxPlayers = match[2];
		}
	}

	const playerLines = lines.filter(line => /^#\s+\d+/.test(line));
	const players = playerLines
		.map(line => {
			const nameMatch = /"([^"]*)"/.exec(line);
			const name = nameMatch ? nameMatch[1] : 'Unknown';
			const rest = line.replace(/"[^"]*"/, '').trim().split(/\s+/);
			const ping = rest[4] || '?';
			return { name, ping };
		})
		.filter(player => player.ping !== '?' && !Number.isNaN(Number(player.ping)));

	return { currentMap, humanCount, maxPlayers, players };
}

function sydneyTimeString() {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Australia/Sydney',
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	}).formatToParts(new Date());

	const get = type => parts.find(part => part.type === type)?.value ?? '';
	return `The time is: ${get('hour')}:${get('minute')}${get('dayPeriod')} ${get('weekday')} ${get('day')} ${get('month')}, ${get('year')}`;
}

function isAdmin(interaction) {
	const adminRoles = config.adminRoles;
	if (!Array.isArray(adminRoles) || adminRoles.length === 0) return false;
	const roleCache = interaction.member?.roles?.cache;
	return adminRoles.some(id => roleCache?.has(String(id)));
}

function isValidMapName(map) {
	return typeof map === 'string' && /^[A-Za-z0-9_./-]+$/.test(map);
}

module.exports = [
	{
		data: new SlashCommandBuilder()
			.setName('online')
			.setDescription('Show players currently on the server')
			.setContexts(InteractionContextType.Guild),
		async execute(interaction) {
			await interaction.deferReply();
			return withRcon(interaction, async rcon => {
				const raw = await rcon.execute('status');
				const { currentMap, humanCount, maxPlayers, players } = parseStatus(raw);
				const playerList = players.length > 0
					? players.map(player => `- ${player.name} (${player.ping}ms)`).join('\n')
					: 'No players are currently online.';
				return interaction.editReply(`[SM] Players (${humanCount}/${maxPlayers}) on ${currentMap}:\n${playerList}`);
			});
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('map')
			.setDescription('Show the current map')
			.setContexts(InteractionContextType.Guild),
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
					await interaction.followUp({ components: [row], flags: MessageFlags.Ephemeral })
						.catch(err => console.warn('[sourcemod] Failed to send map follow-up:', err));
				}
			});
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('nextmap')
			.setDescription('Show the next map')
			.setContexts(InteractionContextType.Guild),
		async execute(interaction) {
			await interaction.deferReply();
			return withRcon(interaction, async rcon => {
				const raw = await rcon.execute('sm_nextmap');
				const match = raw.match(/"sm_nextmap"\s*=\s*"([^"]+)"/);
				const nextMap = match ? match[1] : raw.trim() || 'Unknown';
				return interaction.editReply(`[SM] Next Map: ${nextMap}`);
			});
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('timeleft')
			.setDescription('Show time left on the current map')
			.setContexts(InteractionContextType.Guild),
		async execute(interaction) {
			await interaction.deferReply();
			return withRcon(interaction, async rcon => {
				const raw = await rcon.execute('timeleft');
				const match = raw.match(/(\d+:\d+(?::\d+)?)/);
				const timeLeft = match ? match[1] : raw.trim() || 'Unknown';
				return interaction.editReply(`[SM] Time Left: ${timeLeft}`);
			});
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('thetime')
			.setDescription('Show the current server time')
			.setContexts(InteractionContextType.Guild),
		async execute(interaction) {
			await interaction.deferReply();
			return interaction.editReply(sydneyTimeString());
		},
	},
	{
		data: new SlashCommandBuilder()
			.setName('setmap')
			.setDescription('Change the current map (admin only)')
			.setContexts(InteractionContextType.Guild)
			.addStringOption(option =>
				option.setName('map')
					.setDescription('Map name to change to')
					.setRequired(true)),
		async execute(interaction) {
			await interaction.deferReply();
			if (!isAdmin(interaction)) {
				return interaction.editReply('[SM] You do not have permission to use this command.');
			}

			const map = interaction.options.getString('map')?.trim();
			if (!isValidMapName(map)) {
				return interaction.editReply('[SM] Invalid map name.');
			}

			return withRcon(interaction, async rcon => {
				await rcon.execute(`changelevel ${map}`);
				return interaction.editReply(`[SM] Changing map to: ${map}`);
			});
		},
	},
];
