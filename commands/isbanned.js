const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const SteamID = require('steamid');
const {
	fetchSourceJumpJson,
	fetchSteamAvatar,
	resolveVanityUrl,
	safeString,
} = require('../utils');

async function getSteamID64(profile) {
	const trimmed = typeof profile === 'string' ? profile.trim() : '';
	if (!trimmed) throw new TypeError('Missing Steam profile input.');

	try {
		const parsed = new URL(trimmed);
		const hostname = parsed.hostname.toLowerCase();
		if (hostname.endsWith('steamcommunity.com')) {
			const [segment, value] = parsed.pathname.split('/').filter(Boolean);
			if (segment === 'profiles' && value) return value;
			if (segment === 'id' && value) return resolveVanityUrl(`https://steamcommunity.com/id/${value}`);
		}
	}
	catch {
		// Not a URL; fall through to plain SteamID parsing.
	}

	const steamID = new SteamID(trimmed);
	if (!steamID.isValid()) throw new TypeError('Invalid Steam ID.');
	return steamID.getSteamID64();
}

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
			steamID64 = await getSteamID64(profile);
		}
		catch {
			return interaction.editReply({ content: 'There is an issue with the provided Steam ID/URL.' });
		}

		try {
			const steamID3 = new SteamID(steamID64).getSteam3RenderedID();
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
						fields: [{
							name: 'Steam Profile',
							value: `[View Profile](https://steamcommunity.com/profiles/${steamID64})`,
						}],
						timestamp: new Date(),
					}],
				});
			}

			const avatarUrl = await fetchSteamAvatar(steamID64);
			return interaction.editReply({
				embeds: [{
					color: 0xE74C3C,
					author: {
						name: safeString(player?.name, 'Unknown player'),
						url: `https://steamcommunity.com/profiles/${steamID64}`,
						...(avatarUrl ? { icon_url: avatarUrl } : {}),
					},
					title: 'Player is banned on SourceJump.',
					...(avatarUrl ? { thumbnail: { url: avatarUrl } } : {}),
					fields: [{ name: 'Ban Date', value: safeString(player?.ban_date, 'Unknown') }],
					timestamp: new Date(),
				}],
			});
		}
		catch (err) {
			console.error('[isbanned] Failed to query SourceJump bans:', err);
			return interaction.editReply({ content: 'There was an error fetching data from the SourceJump API.' });
		}
	},
};
