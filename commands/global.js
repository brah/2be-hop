const { SlashCommandBuilder } = require('@discordjs/builders');
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.json'));
const SOURCEJUMP_API_URL = 'https://sourcejump.net/api';
const fetch = require('node-fetch');
const SteamID = require('steamid');
const SteamIDResolver = require('steamid-resolver');

function formatTime(seconds) {
	const totalSeconds = Math.floor(seconds);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = totalSeconds % 60;
	if (hours < 1) {
		return minutes.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
	}
	return hours.toString().padStart(2, '0') + ':' + minutes.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
}

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

				// Parse the response data
				body = JSON.parse(body);
				body = body[0];

				// Attempt to fetch Steam avatar
				let avatarUrl = null;
				let steamID64 = null;
				if (body.steamid) {
					try {
						steamID64 = new SteamID(body.steamid).getSteamID64();
						avatarUrl = await new Promise((resolve) => {
							SteamIDResolver.steamID64ToFullInfo(steamID64, (err, info) => {
								resolve((err || !info) ? null : (info.avatarMedium?.[0] || null));
							});
						});
					}
					catch (e) {
						// no avatar, continue
					}
				}

				const profileUrl = steamID64
					? `https://steamcommunity.com/profiles/${steamID64}`
					: null;

				const embed = {
					color: 0x3498DB,
					author: {
						name: body.name.toString(),
						...(profileUrl ? { url: profileUrl } : {}),
						...(avatarUrl ? { icon_url: avatarUrl } : {}),
					},
					title: body.map.toString(),
					fields: [
						{
							name: 'Time',
							value: typeof body.time === 'number' ? formatTime(body.time) : body.time.toString(),
							inline: true,
						},
						{
							name: 'SJ',
							value: `[link](https://sourcejump.net/records/map/${body.map})`,
							inline: true,
						},
						{
							name: '\u200b',
							value: '\u200b',
							inline: true,
						},
						{
							name: 'Jumps',
							value: body.jumps.toString(),
							inline: true,
						},
						{
							name: 'Sync',
							value: Number(body.sync).toFixed(2) + '%',
							inline: true,
						},
						{
							name: 'Strafes',
							value: body.strafes.toString(),
							inline: true,
						},
						{
							name: 'Run Date',
							value: body.date.toString(),
							inline: true,
						},
						{
							name: 'Server',
							value: body.hostname.toString(),
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
