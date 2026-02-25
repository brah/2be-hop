const { SlashCommandBuilder } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const SOURCEJUMP_API_URL = 'https://sourcejump.net/api';
const apiOptions = {
	method: 'GET',
	headers: {
		'api-key': config.SJ_API_KEY,
	},
};
const SteamID = require('steamid');
const SteamIDResolver = require('steamid-resolver');
const { fetchSteamAvatar } = require('../utils');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('isbanned')
		.setDescription('Check if a user is banned on SourceJump')
		.addStringOption(option =>
			option.setName('user')
				.setDescription('SteamID or profile url of the user')
				.setRequired(true)),
	async execute(interaction) {
		const profile = interaction.options.getString('user');
		await interaction.deferReply();

		let steamID64Raw;
		try {
			steamID64Raw = await getSteamID(profile);
		}
		catch {
			return interaction.editReply({ content: 'There is an issue with the provided Steam ID/URL.' });
		}

		const sid = new SteamID(steamID64Raw);
		const id = sid.getSteam3RenderedID();
		const steamID64 = sid.getSteamID64();

		return fetch(`${SOURCEJUMP_API_URL}/players/banned`, apiOptions)
			.then(response => response.text())
			.then(async body => {
				// Check if the body is empty (empty array [] has string length 2)
				if (body.length === 2) {
					return interaction.editReply({ content: 'Either Tony has unbanned all players, or there is an issue with the API. Try again later.' });
				}
				body = JSON.parse(body);
				for (const element of body) {
					if (element.steamid === id) {
						let avatarUrl = null;
						try {
							avatarUrl = await fetchSteamAvatar(steamID64);
						}
						catch {
							// no avatar, continue
						}

						const embed = {
							color: 0xE74C3C,
							author: {
								name: element.name.toString(),
								url: `https://steamcommunity.com/profiles/${steamID64}`,
								...(avatarUrl ? { icon_url: avatarUrl } : {}),
							},
							title: 'Player is banned on SourceJump.',
							...(avatarUrl ? { thumbnail: { url: avatarUrl } } : {}),
							fields: [
								{
									name: 'Ban Date',
									value: element.ban_date.toString(),
								},
							],
							timestamp: new Date(),
						};
						return interaction.editReply({ embeds: [embed] });
					}
				}
				return interaction.editReply({
					embeds: [{
						color: 0x57F287,
						title: 'Player is not banned on SourceJump.',
						fields: [
							{
								name: 'Steam Profile',
								value: `[View Profile](https://steamcommunity.com/profiles/${steamID64})`,
							},
						],
						timestamp: new Date(),
					}],
				});
			})
			.catch(err => {
				console.error(err);
				return interaction.editReply({ content: 'There was an error fetching data from the SourceJump API.' });
			});
	},
};

function getSteamID(profile) {
	return new Promise((resolve, reject) => {
		if (profile.includes('steamcommunity.com/profiles')) {
			// split url, check for trailing slash, and use the end of the url as steamid
			const parts = profile.split('/').filter(p => p !== '');
			resolve(parts[parts.length - 1]);
		}
		else if (profile.includes('steamcommunity.com/id')) {
			const clean = profile.endsWith('/') ? profile.slice(0, -1) : profile;
			SteamIDResolver.customUrlToSteamID64(clean, (err, res) => {
				if (err) return reject(err);
				resolve(res);
			});
		}
		else {
			try {
				const testSid = new SteamID(profile);
				if (!testSid.isValid()) return reject(new Error('invalid steamid'));
				resolve(profile);
			}
			catch {
				reject(new Error('invalid steamid'));
			}
		}
	});
}
