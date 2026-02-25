const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const SteamID = require('steamid');
const { SOURCEJUMP_API_URL, fetchSteamAvatar } = require('../utils');


module.exports = {
	data: new SlashCommandBuilder()
		.setName('global')
		.setDescription('Retrieves global world record for the map from the SourceJump database')
		.addStringOption(option =>
			option.setName('map')
				.setDescription('Name of the map')
				.setRequired(true)),
	async execute(interaction) {
		const mapName = interaction.options.getString('map');
		await interaction.deferReply();

		const apiOptions = {
			method: 'GET',
			headers: {
				'api-key': config.SJ_API_KEY,
			},
		};

		return fetch(`${SOURCEJUMP_API_URL}/records/${mapName}`, apiOptions)
			.then(response => response.text())
			.then(async body => {
				// Check if there is a valid response (empty array [] has string length 2).
				if (body.length === 2) {
					return interaction.editReply({ content: `No times found for ${mapName}` });
				}

				const record = JSON.parse(body)[0];

				// Attempt to fetch Steam avatar
				let avatarUrl = null;
				let steamID64 = null;
				if (record.steamid) {
					try {
						steamID64 = new SteamID(record.steamid).getSteamID64();
						avatarUrl = await fetchSteamAvatar(steamID64);
					}
					catch {
						// no avatar, continue
					}
				}

				const profileUrl = steamID64
					? `https://steamcommunity.com/profiles/${steamID64}`
					: null;

				const embed = {
					color: 0x3498DB,
					author: {
						name: record.name.toString(),
						...(profileUrl ? { url: profileUrl } : {}),
						...(avatarUrl ? { icon_url: avatarUrl } : {}),
					},
					title: record.map.toString(),
					fields: [
						{
							name: 'Time',
							value: record.time.toString(),
							inline: true,
						},
						{
							name: 'SJ',
							value: `[link](https://sourcejump.net/records/map/${record.map})`,
							inline: true,
						},
						{
							name: '\u200b',
							value: '\u200b',
							inline: true,
						},
						{
							name: 'Jumps',
							value: record.jumps.toString(),
							inline: true,
						},
						{
							name: 'Sync',
							value: Number(record.sync).toFixed(2) + '%',
							inline: true,
						},
						{
							name: 'Strafes',
							value: record.strafes.toString(),
							inline: true,
						},
						{
							name: 'Run Date',
							value: record.date.toString(),
							inline: true,
						},
						{
							name: 'Server',
							value: record.hostname.toString(),
							inline: true,
						},
					],
					timestamp: new Date(),
				};
				await interaction.editReply({ embeds: [embed] });
				if (typeof interaction.followUp === 'function') {
					const row = new ActionRowBuilder().addComponents(
						new ButtonBuilder()
							.setCustomId(`wr:${record.map}`)
							.setLabel('Server WR')
							.setStyle(ButtonStyle.Secondary),
					);
					await interaction.followUp({ components: [row], ephemeral: true }).catch(Function.prototype);
				}
			})
			.catch(err => {
				console.error(err);
				return interaction.editReply({ content: 'There was an error fetching data from the SourceJump API.' });
			});
	},
};
