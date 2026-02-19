const { SlashCommandBuilder } = require('@discordjs/builders');
const path = require('path');
const SteamID = require('steamid');
const SteamIDResolver = require('steamid-resolver');
const trackMap = require(path.join(__dirname, '..', 'tracks.json'));
const styleMap = require(path.join(__dirname, '..', 'styles.json'));

module.exports = {
	requireDB: true,
	data: new SlashCommandBuilder()
		.setName('wr')
		.setDescription('Retrieves the specified record')
		.addStringOption(option =>
			option.setName('map')
				.setDescription('Name of the map')
				.setRequired(true))
		.addIntegerOption(option =>
			option.setName('track')
				.setDescription('Normal/Bonus')
				.addChoice('Normal', 0)
				.addChoice('Bonus', 1))
		.addIntegerOption(option => {
			option.setName('style').setDescription('Style of the record');
			Object.entries(styleMap).forEach(([key, name]) => option.addChoice(name, Number.parseInt(key)));
			return option;
		}),
	async execute(interaction, con) {
		const mapName = interaction.options.getString('map');
		const track = interaction.options.getInteger('track') || 0;
		const style = interaction.options.getInteger('style') || 0;

		const textTrack = trackMap[track];
		const textStyle = styleMap[style];
		let sql;

		await interaction.deferReply();

		// Match exact map name
		if (mapName.startsWith('bhop_') || mapName.startsWith('bhop_kz_') || mapName.startsWith('kz_bhop_') || mapName.startsWith('kz_')) {
			sql = 'SELECT time, jumps, sync, strafes, date, map, u.name, p.auth FROM playertimes p, users u WHERE map =  ' + con.escape(mapName) + '  AND track = ? AND style = ? AND u.auth = p.auth ORDER BY time ASC LIMIT 1';
		}
		// Match close enough
		else {
			sql = 'SELECT time, jumps, sync, strafes, date, map, u.name, p.auth FROM playertimes p, users u WHERE map LIKE ' + con.escape('%' + mapName + '%') + ' AND track = ? AND style = ? AND u.auth = p.auth ORDER BY time ASC LIMIT 1';
		}
		con.query(sql, [track, style], async (err, result) => {
			if (err) {
				return interaction.editReply({ content: 'There has been an issue with this query. Yell at Merz.' + err });
			}

			if (!result.length) {
				return interaction.editReply({ content: 'Map not found.' });
			}

			let avatarUrl = null;
			let steamID64 = null;
			try {
				steamID64 = new SteamID(result[0].auth).getSteamID64();
				avatarUrl = await new Promise((resolve) => {
					SteamIDResolver.steamID64ToFullInfo(steamID64, (err, info) => {
						resolve((err || !info) ? null : (info.avatarMedium?.[0] || null));
					});
				});
			}
			catch (e) {
				// no avatar, continue
			}

			return interaction.editReply({ embeds: [buildEmbed(result, textTrack, textStyle, steamID64, avatarUrl)] });
		});
	},
};

function buildEmbed(result, textTrack, textStyle, steamID64, avatarUrl) {
	const hours = Math.floor(result[0].time / 3600);
	const minutes = Math.floor((result[0].time % 3600) / 60);
	const seconds = Math.floor(result[0].time % 60);
	let formatted;
	if (hours < 1) {
		formatted = minutes.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
	}
	else {
		formatted = hours.toString().padStart(2, '0') + ':' + minutes.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
	}

	const profileUrl = steamID64
		? `https://steamcommunity.com/profiles/${steamID64}`
		: null;

	const embed = {
		color: 0x3498DB,
		author: {
			name: result[0].name.toString(),
			...(profileUrl ? { url: profileUrl } : {}),
			...(avatarUrl ? { icon_url: avatarUrl } : {}),
		},
		title: result[0].map.toString(),
		fields: [
			{
				name: 'Time',
				value: formatted,
				inline: true,
			},
			{
				name: 'Track',
				value: textTrack,
				inline: true,
			},
			{
				name: 'Style',
				value: textStyle,
				inline: true,
			},
			{
				name: 'Jumps',
				value: result[0].jumps.toString(),
				inline: true,
			},
			{
				name: 'Sync',
				value: Number(result[0].sync).toFixed(2) + '%',
				inline: true,
			},
			{
				name: 'Strafes',
				value: result[0].strafes.toString(),
				inline: true,
			},
		],
		timestamp: new Date(),
		footer: {
			text: 'Wrong map/style? Try using the exact name!',
		},
	};
	return embed;
}
