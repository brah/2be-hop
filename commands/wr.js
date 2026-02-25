const { SlashCommandBuilder } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const SOURCEJUMP_API_URL = 'https://sourcejump.net/api';
const SteamID = require('steamid');
const { fetchSteamAvatar } = require('../utils');


module.exports = {
	data: new SlashCommandBuilder()
		.setName('wr')
		.setDescription('Retrieves the SpaceBar Warriors server world record for the map')
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
				if (body.length === 2) {
					return interaction.editReply({ content: `No times found for ${mapName}` });
				}

				const records = JSON.parse(body);
				const serverRecords = records.filter(r => r.ip === config.serverIP);

				if (!serverRecords.length) {
					return interaction.editReply({ content: `No times found for ${mapName} on SpaceBar Warriors` });
				}

				const wr = serverRecords[0];

				let avatarUrl = null;
				let steamID64 = null;
				if (wr.steamid) {
					try {
						steamID64 = new SteamID(wr.steamid).getSteamID64();
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
						name: wr.name.toString(),
						...(profileUrl ? { url: profileUrl } : {}),
						...(avatarUrl ? { icon_url: avatarUrl } : {}),
					},
					title: wr.map.toString(),
					fields: [
						{
							name: 'Time',
							value: (() => {
								const t = wr.time.toString();
								if (wr.wrDif === 'World Record') return `⭐ ${t}`;
								return wr.wrDif ? `${t} (${wr.wrDif})` : t;
							})(),
							inline: true,
						},
						{
							name: 'SJ',
							value: `[link](https://sourcejump.net/records/map/${wr.map})`,
							inline: true,
						},
						{
							name: '\u200b',
							value: '\u200b',
							inline: true,
						},
						{
							name: 'Jumps',
							value: wr.jumps.toString(),
							inline: true,
						},
						{
							name: 'Sync',
							value: Number(wr.sync).toFixed(2) + '%',
							inline: true,
						},
						{
							name: 'Strafes',
							value: wr.strafes.toString(),
							inline: true,
						},
						{
							name: 'Run Date',
							value: wr.date.toString(),
							inline: true,
						},
						{
							name: 'Server',
							value: wr.hostname.toString(),
							inline: true,
						},
					],
					timestamp: new Date(),
				};
				return interaction.editReply({ embeds: [embed] });
			})
			.catch(err => {
				console.error(err);
				return interaction.editReply({ content: 'There was an error fetching data from the SourceJump API.' });
			});
	},
};
