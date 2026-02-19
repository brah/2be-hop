const { SlashCommandBuilder } = require('discord.js');
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.json'));
const SOURCEJUMP_API_URL = 'https://sourcejump.net/api';
const SERVER_IP = '203.209.209.92:27015';
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
				const serverRecords = records.filter(r => r.ip === SERVER_IP);

				if (!serverRecords.length) {
					return interaction.editReply({ content: `No times found for ${mapName} on SpaceBar Warriors` });
				}

				const wr = serverRecords[0];

				let avatarUrl = null;
				let steamID64 = null;
				if (wr.steamid) {
					try {
						steamID64 = new SteamID(wr.steamid).getSteamID64();
						avatarUrl = await new Promise((resolve) => {
							SteamIDResolver.steamID64ToFullInfo(steamID64, (err, info) => {
								resolve((err || !info) ? null : (info.avatarMedium?.[0] || null));
							});
						});
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
								const t = typeof wr.time === 'number' ? formatTime(wr.time) : wr.time.toString();
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
