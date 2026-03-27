const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const SteamID = require('steamid');
const SteamIDResolver = require('steamid-resolver');
const {
	fetchSourceJumpJson,
	fetchSteamAvatar,
	safeString,
} = require('../utils');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('isbanned')
		.setDescription('Check if a user is banned on SourceJump')
		.setContexts(InteractionContextType.Guild)
		.addStringOption(option =>
			option.setName('user')
				.setDescription('SteamID or profile url of the user')
				.setRequired(true)),
	async execute(interaction) {
		const profile = interaction.options.getString('user')?.trim();
		await interaction.deferReply();

		if (!profile) {
			return interaction.editReply({ content: 'Please provide a Steam ID or profile URL.' });
		}

		let steamID64;
		try {
			steamID64 = await getSteamID(profile);
		}
		catch {
			return interaction.editReply({ content: 'There is an issue with the provided Steam ID/URL.' });
		}

		try {
			const sid = new SteamID(steamID64);
			const steamID3 = sid.getSteam3RenderedID();
			const players = await fetchSourceJumpJson('/players/banned', config.SJ_API_KEY);
			if (!Array.isArray(players)) {
				throw new TypeError('Banned players response was not an array.');
			}

			const player = players.find(element => element?.steamid === steamID3);
			if (!player) {
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
			}

			const avatarUrl = await fetchSteamAvatar(steamID64);
			const embed = {
				color: 0xE74C3C,
				author: {
					name: safeString(player?.name, 'Unknown player'),
					url: `https://steamcommunity.com/profiles/${steamID64}`,
					...(avatarUrl ? { icon_url: avatarUrl } : {}),
				},
				title: 'Player is banned on SourceJump.',
				...(avatarUrl ? { thumbnail: { url: avatarUrl } } : {}),
				fields: [
					{
						name: 'Ban Date',
						value: safeString(player?.ban_date, 'Unknown'),
					},
				],
				timestamp: new Date(),
			};
			return interaction.editReply({ embeds: [embed] });
		}
		catch (err) {
			console.error('[isbanned] Failed to query SourceJump bans:', err);
			return interaction.editReply({ content: 'There was an error fetching data from the SourceJump API.' });
		}
	},
};

function getSteamID(profile) {
	return new Promise((resolve, reject) => {
		const trimmed = typeof profile === 'string' ? profile.trim() : '';
		if (!trimmed) {
			reject(new TypeError('Missing Steam profile input.'));
			return;
		}

		try {
			const parsed = new URL(trimmed);
			const hostname = parsed.hostname.toLowerCase();
			const parts = parsed.pathname.split('/').filter(Boolean);
			if (hostname.endsWith('steamcommunity.com') && parts[0] === 'profiles' && parts[1]) {
				resolve(parts[1]);
				return;
			}
			if (hostname.endsWith('steamcommunity.com') && parts[0] === 'id' && parts[1]) {
				const vanityUrl = `https://steamcommunity.com/id/${parts[1]}`;
				SteamIDResolver.customUrlToSteamID64(vanityUrl, (err, res) => {
					if (err || !res) {
						reject(err instanceof Error ? err : new TypeError('Could not resolve vanity URL.'));
						return;
					}
					resolve(res);
				});
				return;
			}
		}
		catch {
			// Not a URL; fall through to plain SteamID parsing.
		}

		try {
			const steamID = new SteamID(trimmed);
			if (!steamID.isValid()) {
				reject(new TypeError('Invalid Steam ID.'));
				return;
			}
			resolve(steamID.getSteamID64());
		}
		catch {
			reject(new TypeError('Invalid Steam ID.'));
		}
	});
}
