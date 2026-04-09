const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const tarStream = require('tar-stream');

const TARBALL_URL = 'https://codeload.github.com/srcwr/zones-cstrike/tar.gz/refs/heads/main';
const TIER_ENTRY_REGEX = /^zones-cstrike-main\/i\/([A-Za-z0-9_./-]+)\.json$/;
const VALID_MAP_NAME = /^[A-Za-z0-9_./-]+$/;
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'tiers.json');
const SNAPSHOT_TMP_PATH = path.join(DATA_DIR, 'tiers.json.tmp');

let tierIndex = Object.create(null);
let snapshotMeta = { fetched: null, version: null, count: 0 };

function loadTierIndex() {
	try {
		const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed.tiers === 'object' && parsed.tiers !== null) {
			tierIndex = parsed.tiers;
			snapshotMeta = {
				fetched: parsed.fetched ?? null,
				version: parsed.version ?? null,
				count: Object.keys(parsed.tiers).length,
			};
			console.log(`[tiers] Loaded ${snapshotMeta.count} tier entries from snapshot.`);
			return snapshotMeta.count;
		}
		console.warn('[tiers] Snapshot file is malformed; using empty index.');
	}
	catch (err) {
		if (err.code !== 'ENOENT') {
			console.warn(`[tiers] Failed to read snapshot: ${err.message}`);
		}
	}
	tierIndex = Object.create(null);
	snapshotMeta = { fetched: null, version: null, count: 0 };
	return 0;
}

function getTier(map) {
	if (typeof map !== 'string') return null;
	const tier = tierIndex[map];
	return Number.isInteger(tier) ? tier : null;
}

function getSnapshotMeta() {
	return { ...snapshotMeta };
}

function snapshotIsFresh() {
	if (!snapshotMeta.fetched) return false;
	const fetchedAt = Date.parse(snapshotMeta.fetched);
	if (Number.isNaN(fetchedAt)) return false;
	return Date.now() - fetchedAt < REFRESH_MAX_AGE_MS;
}

async function ensureDataDir() {
	await fsPromises.mkdir(DATA_DIR, { recursive: true });
}

// Streams the srcwr tarball, extracts every i/<map>.json entry, and
// builds a flat { map: tier } map. Tier 0 and tier 1 are skipped because
// the server's default is tier 1, so pushing them via sm_settier would
// just be RCON noise. Wrapped in an AbortController so a stalled
// codeload connection cannot block bot startup forever.
async function downloadTierMap() {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new Error(`Tarball download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
	}, DOWNLOAD_TIMEOUT_MS);

	try {
		const response = await fetch(TARBALL_URL, { signal: controller.signal });
		if (!response.ok || !response.body) {
			throw new Error(`Tarball download failed: ${response.status} ${response.statusText}`);
		}

		const tiers = Object.create(null);
		let totalEntries = 0;
		let acceptedEntries = 0;

		const extract = tarStream.extract();
		extract.on('entry', (header, stream, next) => {
			totalEntries += 1;
			const match = header.name.match(TIER_ENTRY_REGEX);
			if (!match || header.type !== 'file') {
				stream.resume();
				stream.on('end', next);
				return;
			}

			const mapName = match[1];
			if (!VALID_MAP_NAME.test(mapName)) {
				stream.resume();
				stream.on('end', next);
				return;
			}

			const chunks = [];
			stream.on('data', chunk => chunks.push(chunk));
			stream.on('end', () => {
				try {
					const text = Buffer.concat(chunks).toString('utf8');
					const parsed = JSON.parse(text);
					const tier = Array.isArray(parsed) ? parsed[0]?.tier : null;
					if (Number.isInteger(tier) && tier >= 2 && tier <= 10) {
						tiers[mapName] = tier;
						acceptedEntries += 1;
					}
				}
				catch {
					// Skip files that aren't valid JSON or don't carry a usable tier.
				}
				next();
			});
			stream.on('error', next);
		});

		const gunzip = zlib.createGunzip();
		await pipeline(response.body, gunzip, extract, { signal: controller.signal });

		console.log(`[tiers] Parsed ${totalEntries} tarball entries; kept ${acceptedEntries} non-default tiers.`);
		return tiers;
	}
	catch (err) {
		if (err?.name === 'AbortError') {
			throw new Error(`Tarball download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
		}
		throw err;
	}
	finally {
		clearTimeout(timeout);
	}
}

async function refreshSnapshot({ force = false } = {}) {
	loadTierIndex();
	if (!force && snapshotIsFresh()) {
		console.log(`[tiers] Snapshot is fresh (fetched ${snapshotMeta.fetched}); skipping refresh.`);
		return snapshotMeta.count;
	}

	console.log('[tiers] Refreshing snapshot from srcwr/zones-cstrike...');
	try {
		const tiers = await downloadTierMap();
		const fetched = new Date().toISOString();
		const payload = { version: 'main', fetched, tiers };
		await ensureDataDir();
		await fsPromises.writeFile(SNAPSHOT_TMP_PATH, JSON.stringify(payload), 'utf8');
		await fsPromises.rename(SNAPSHOT_TMP_PATH, SNAPSHOT_PATH);
		tierIndex = tiers;
		snapshotMeta = { fetched, version: 'main', count: Object.keys(tiers).length };
		console.log(`[tiers] Refreshed snapshot (${snapshotMeta.count} maps).`);
		return snapshotMeta.count;
	}
	catch (err) {
		console.warn(`[tiers] Refresh failed: ${err.message}. Falling back to cached snapshot.`);
		try {
			await fsPromises.unlink(SNAPSHOT_TMP_PATH);
		}
		catch {
			// tmp file may not exist
		}
		return snapshotMeta.count;
	}
}

module.exports = {
	loadTierIndex,
	refreshSnapshot,
	getTier,
	getSnapshotMeta,
};
