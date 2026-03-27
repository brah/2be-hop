const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const {
	buildSourceJumpRecordEmbed,
	fetchSourceJumpJson,
	safeString,
} = require('../utils');

function normalizeEndpoint(value, fallbackPort = 27015) {
	if (typeof value !== 'string' || value.trim() === '') return null;
	try {
		const parsed = new URL(value.includes('://') ? value : `udp://${value}`);
		return `${parsed.hostname.toLowerCase()}:${parsed.port || fallbackPort}`;
	}
	catch {
		return value.trim().toLowerCase();
	}
}

function getConfiguredServerKeys() {
	return new Set([
		normalizeEndpoint(config.serverIP),
		normalizeEndpoint(config.rconIP && `${config.rconIP}:${config.rconPort || 27015}`),
		normalizeEndpoint(config.rconIP),
	].filter(Boolean));
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('wr')
		.setDescription('Retrieves server and global world records for the map')
		.setContexts(InteractionContextType.Guild)
		.addStringOption(option =>
			option.setName('map')
				.setDescription('Name of the map')
				.setRequired(true)),
	async execute(interaction) {
		const mapName = interaction.options.getString('map')?.trim();
		await interaction.deferReply();

		if (!mapName) {
			return interaction.editReply({ content: 'Please provide a map name.' });
		}

		try {
			const records = await fetchSourceJumpJson(`/records/${encodeURIComponent(mapName)}`, config.SJ_API_KEY);
			if (!Array.isArray(records) || records.length === 0) {
				return interaction.editReply({ content: `No times found for ${mapName}` });
			}

			const configuredServerKeys = getConfiguredServerKeys();
			const serverRecords = records.filter(record => configuredServerKeys.has(normalizeEndpoint(record?.ip)));
			const globalRecord = records[0];
			const embeds = [];

			if (serverRecords.length > 0) {
				const wr = serverRecords[0];
				const time = safeString(wr?.time, 'Unknown');
				const difference = safeString(wr?.wrDif, '');
				let timeValue = time;
				if (difference === 'World Record') {
					timeValue = `${time} (World Record)`;
				}
				else if (difference) {
					timeValue = `${time} (${difference})`;
				}
				embeds.push(await buildSourceJumpRecordEmbed(wr, {
					color: 0x3498DB,
					label: 'Server WR',
					timeValue,
				}));
			}
			else {
				embeds.push({
					description: `No server times found for ${mapName} on SpaceBar Warriors.`,
					color: 0x3498DB,
				});
			}

			if (globalRecord) {
				embeds.push(await buildSourceJumpRecordEmbed(globalRecord, {
					color: 0x2ECC71,
					label: 'Global WR',
					timeValue: safeString(globalRecord?.time, 'Unknown'),
				}));
			}

			return interaction.editReply({ embeds });
		}
		catch (err) {
			console.error('[wr] Failed to fetch SourceJump records:', err);
			return interaction.editReply({ content: 'There was an error fetching data from the SourceJump API.' });
		}
	},
};
