const SteamIDResolver = require('steamid-resolver');

async function fetchSteamAvatar(steamID64) {
	return new Promise((resolve) => {
		SteamIDResolver.steamID64ToFullInfo(steamID64, (err, info) => {
			resolve((err || !info) ? null : (info.avatarMedium?.[0] || null));
		});
	});
}

module.exports = { fetchSteamAvatar };
