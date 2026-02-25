const SteamIDResolver = require('steamid-resolver');

const SOURCEJUMP_API_URL = 'https://sourcejump.net/api';

async function fetchSteamAvatar(steamID64) {
	return new Promise((resolve) => {
		SteamIDResolver.steamID64ToFullInfo(steamID64, (err, info) => {
			resolve((err || !info) ? null : (info.avatarMedium?.[0] || null));
		});
	});
}

module.exports = { SOURCEJUMP_API_URL, fetchSteamAvatar };
