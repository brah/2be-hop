const SteamID = require('steamid');
const SteamIDResolver = require('steamid-resolver');

const SOURCEJUMP_API_URL = 'https://sourcejump.net/api';
const SOURCEJUMP_TIMEOUT_MS = 8000;
const STEAM_LOOKUP_TIMEOUT_MS = 5000;

const VALID_MAP_NAME = /^[A-Za-z0-9_./-]+$/;

function isNonEmptyString(value) {
	return typeof value === 'string' && value.trim() !== '';
}

function isValidMapName(value) {
	return typeof value === 'string' && VALID_MAP_NAME.test(value);
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

function normalizeEndpoint(value, fallbackPort = 27015) {
	if (!isNonEmptyString(value)) return null;
	try {
		const parsed = new URL(value.includes('://') ? value : `udp://${value}`);
		if (!parsed.hostname) return null;
		const port = parsed.port ? Number.parseInt(parsed.port, 10) : fallbackPort;
		if (Number.isNaN(port)) return null;
		return { host: parsed.hostname.toLowerCase(), port };
	}
	catch {
		return null;
	}
}

function endpointKey(endpoint) {
	return endpoint ? `${endpoint.host}:${endpoint.port}` : null;
}

function promisifyResolver(fn, ...args) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			settled = true;
			reject(new Error(`Steam resolver timed out after ${STEAM_LOOKUP_TIMEOUT_MS}ms`));
		}, STEAM_LOOKUP_TIMEOUT_MS);

		fn(...args, (err, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (err || !result) reject(err || new Error('Empty resolver response.'));
			else resolve(result);
		});
	});
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
			throw new Error(`Request timed out after ${timeoutMs}ms`, { cause: err });
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

	const resolved = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
	return fetchJson(`${SOURCEJUMP_API_URL}${resolved}`, {
		method: 'GET',
		headers: { 'api-key': apiKey },
	});
}

async function fetchSteamAvatar(steamID64) {
	if (!isNonEmptyString(steamID64)) return null;
	try {
		const info = await promisifyResolver(SteamIDResolver.steamID64ToFullInfo, steamID64);
		return info?.avatarMedium?.[0] || null;
	}
	catch {
		return null;
	}
}

async function resolveVanityUrl(vanityUrl) {
	return promisifyResolver(SteamIDResolver.customUrlToSteamID64, vanityUrl);
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
		author: {
			name: safeString(record?.name, 'Unknown player'),
			...(profileUrl ? { url: profileUrl } : {}),
			...(avatarUrl ? { icon_url: avatarUrl } : {}),
		},
		title: safeString(record?.map, 'Unknown map'),
		fields: [
			{ name: 'Time', value: safeString(timeValue, 'Unknown'), inline: true },
			{ name: 'SJ', value: `[link](https://sourcejump.net/records/map/${encodeURIComponent(safeString(record?.map, 'unknown'))})`, inline: true },
			// Zero-width spacer field forces the row layout below to render 3-wide.
			{ name: '\u200b', value: '\u200b', inline: true },
			{ name: 'Jumps', value: safeString(record?.jumps, 'Unknown'), inline: true },
			{ name: 'Sync', value: safePercent(record?.sync), inline: true },
			{ name: 'Strafes', value: safeString(record?.strafes, 'Unknown'), inline: true },
			{ name: 'Run Date', value: safeString(record?.date, 'Unknown'), inline: true },
			{ name: 'Server', value: safeString(record?.hostname, 'Unknown'), inline: true },
		],
		footer: { text: safeString(label, 'Record') },
		timestamp: new Date(),
		...(avatarUrl ? { thumbnail: { url: avatarUrl } } : {}),
	};
}

module.exports = {
	VALID_MAP_NAME,
	buildSourceJumpRecordEmbed,
	endpointKey,
	fetchSourceJumpJson,
	fetchSteamAvatar,
	isNonEmptyString,
	isValidMapName,
	normalizeEndpoint,
	resolveVanityUrl,
	safeString,
};
