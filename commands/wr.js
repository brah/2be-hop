const { SlashCommandBuilder } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const SteamID = require('steamid');
const { SOURCEJUMP_API_URL, fetchSteamAvatar } = require('../utils');

async function buildRecordEmbed(record, color, label, timeValue) {
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
	return {
		color,
		description: label,
		author: {
			name: record.name.toString(),
			...(profileUrl ? { url: profileUrl } : {}),
			...(avatarUrl ? { icon_url: avatarUrl } : {}),
		},
		title: record.map.toString(),
		fields: [
			{ name: 'Time', value: timeValue, inline: true },
			{ name: 'SJ', value: `[link](https://sourcejump.net/records/map/${record.map})`, inline: true },
			{ name: '\u200b', value: '\u200b', inline: true },
			{ name: 'Jumps', value: record.jumps.toString(), inline: true },
			{ name: 'Sync', value: Number(record.sync).toFixed(2) + '%', inline: true },
			{ name: 'Strafes', value: record.strafes.toString(), inline: true },
			{ name: 'Run Date', value: record.date.toString(), inline: true },
			{ name: 'Server', value: record.hostname.toString(), inline: true },
		],
		timestamp: new Date(),
	};
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('wr')
		.setDescription('Retrieves server and global world records for the map')
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
				const globalRecord = records[0];

				const embeds = [];

				if (serverRecords.length > 0) {
					const wr = serverRecords[0];
					const t = wr.time.toString();
					const timeValue = wr.wrDif === 'World Record'
						? `⭐ ${t}`
						: wr.wrDif ? `${t} (${wr.wrDif})` : t;
					embeds.push(await buildRecordEmbed(wr, 0x3498DB, 'Server WR', timeValue));
				}
				else {
					embeds.push({ description: `No server times found for ${mapName} on SpaceBar Warriors`, color: 0x3498DB });
				}

				if (globalRecord) {
					embeds.push(await buildRecordEmbed(globalRecord, 0x2ECC71, 'Global WR', globalRecord.time.toString()));
				}

				return interaction.editReply({ embeds });
			})
			.catch(err => {
				console.error(err);
				return interaction.editReply({ content: 'There was an error fetching data from the SourceJump API.' });
			});
	},
};
