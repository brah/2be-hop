const SteamID = require('steamid');
const SteamIDResolver = require('steamid-resolver');

const SOURCEJUMP_API_URL = 'https://sourcejump.net/api';
const SOURCEJUMP_TIMEOUT_MS = 8000;
const STEAM_LOOKUP_TIMEOUT_MS = 5000;

function isNonEmptyString(value) {
	return typeof value === 'string' && value.trim() !== '';
}

function safeString(value, fallback = 'Unknown') {
	if (value === null || value === undefined) return fallback;
	const text = String(value).trim();
	return text || fallback;
}

function safePercent(value, fallback = 'Unknown') {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? `${numeric.toFixed(2)}%` : fallback;
}

async function fetchJson(url, options = {}, timeoutMs = SOURCEJUMP_TIMEOUT_MS) {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	try {
		const response = await fetch(url, { ...options, signal: controller.signal });
		const body = await response.text();
		if (!response.ok) {
			const summary = safeString(body, '').slice(0, 200);
			throw new Error(summary ? `HTTP ${response.status}: ${summary}` : `HTTP ${response.status}`);
		}
		try {
			return JSON.parse(body);
		}
		catch {
			throw new Error('Received invalid JSON from remote API.');
		}
	}
	catch (err) {
		if (err?.name === 'AbortError') {
			throw new Error(`Request timed out after ${timeoutMs}ms`);
		}
		throw err;
	}
	finally {
		clearTimeout(timeout);
	}
}

async function fetchSourceJumpJson(resourcePath, apiKey) {
	if (!isNonEmptyString(apiKey)) {
		throw new Error('SourceJump API key is not configured.');
	}

	const path = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
	return fetchJson(`${SOURCEJUMP_API_URL}${path}`, {
		method: 'GET',
		headers: {
			'api-key': apiKey,
		},
	});
}

async function fetchSteamAvatar(steamID64) {
	if (!isNonEmptyString(steamID64)) return null;

	return new Promise((resolve) => {
		let settled = false;
		const timeout = setTimeout(() => {
			settled = true;
			resolve(null);
		}, STEAM_LOOKUP_TIMEOUT_MS);

		SteamIDResolver.steamID64ToFullInfo(steamID64, (err, info) => {
			if (settled) return;
			clearTimeout(timeout);
			resolve((err || !info) ? null : (info.avatarMedium?.[0] || null));
		});
	});
}

async function buildSourceJumpRecordEmbed(record, { color, label, timeValue }) {
	let avatarUrl = null;
	let profileUrl = null;

	if (isNonEmptyString(record?.steamid)) {
		try {
			const steamID64 = new SteamID(record.steamid).getSteamID64();
			profileUrl = `https://steamcommunity.com/profiles/${steamID64}`;
			avatarUrl = await fetchSteamAvatar(steamID64);
		}
		catch {
			// Ignore bad steamid data from the API and fall back to a text-only embed.
		}
	}

	return {
		color,
		description: safeString(label, 'Record'),
		author: {
			name: safeString(record?.name, 'Unknown player'),
			...(profileUrl ? { url: profileUrl } : {}),
			...(avatarUrl ? { icon_url: avatarUrl } : {}),
		},
		title: safeString(record?.map, 'Unknown map'),
		fields: [
			{ name: 'Time', value: safeString(timeValue, 'Unknown'), inline: true },
			{ name: 'SJ', value: `[link](https://sourcejump.net/records/map/${encodeURIComponent(safeString(record?.map, 'unknown'))})`, inline: true },
			{ name: '\u200b', value: '\u200b', inline: true },
			{ name: 'Jumps', value: safeString(record?.jumps, 'Unknown'), inline: true },
			{ name: 'Sync', value: safePercent(record?.sync), inline: true },
			{ name: 'Strafes', value: safeString(record?.strafes, 'Unknown'), inline: true },
			{ name: 'Run Date', value: safeString(record?.date, 'Unknown'), inline: true },
			{ name: 'Server', value: safeString(record?.hostname, 'Unknown'), inline: true },
		],
		timestamp: new Date(),
		...(avatarUrl ? { thumbnail: { url: avatarUrl } } : {}),
	};
}

module.exports = {
	SOURCEJUMP_API_URL,
	buildSourceJumpRecordEmbed,
	fetchSourceJumpJson,
	fetchSteamAvatar,
	isNonEmptyString,
	safeString,
};
