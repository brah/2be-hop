const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, MessageFlags } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const {
	buildSourceJumpRecordEmbed,
	fetchSourceJumpJson,
	safeString,
} = require('../utils');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('global')
		.setDescription('Retrieves global world record for the map from the SourceJump database')
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

			const record = records[0];
			const embed = await buildSourceJumpRecordEmbed(record, {
				color: 0x3498DB,
				label: 'Global WR',
				timeValue: safeString(record?.time, 'Unknown'),
			});

			await interaction.editReply({ embeds: [embed] });

			if (interaction.supportsFollowUp !== false) {
				const row = new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setCustomId(`wr:${safeString(record?.map, mapName)}`)
						.setLabel('Server WR')
						.setStyle(ButtonStyle.Secondary),
				);
				await interaction.followUp({ components: [row], flags: MessageFlags.Ephemeral })
					.catch(err => console.warn('[global] Failed to send follow-up button:', err));
			}
		}
		catch (err) {
			console.error('[global] Failed to fetch SourceJump record:', err);
			return interaction.editReply({ content: 'There was an error fetching data from the SourceJump API.' });
		}
	},
};
