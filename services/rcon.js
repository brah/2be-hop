const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const Rcon = require('rcon-srcds').default;

const DEFAULT_EXECUTE_TIMEOUT_MS = 5000;
const FIRE_AND_FORGET_TIMEOUT_MS = 1500;

function createRcon() {
	return new Rcon({
		host: config.rconIP,
		port: config.rconPort || 27015,
		encoding: 'utf8',
		timeout: 5000,
	});
}

// Wraps a promise with a hard timeout. rcon-srcds's constructor
// `timeout` option sets a socket timeout but never attaches a listener,
// so it's effectively a no-op — we have to enforce timeouts ourselves.
function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const err = new Error(`RCON ${label} timed out after ${ms}ms`);
			err.code = 'RCON_TIMEOUT';
			reject(err);
		}, ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Runs a single RCON command and tears the connection down. Returns
// { ok, output, error } so callers can decide how to surface failures
// without throwing through the poller or other long-lived loops.
//
// Source RCON commands that mutate state (sm_settier, sm_kick, etc.)
// send no response packet, so the underlying library hangs forever
// waiting on `execute`. Callers that issue such commands should pass
// `{ expectResponse: false }` so we treat an execute timeout as success
// instead of an error.
async function runRconCommand(command, options = {}) {
	const { expectResponse = true } = options;
	const executeTimeoutMs = options.executeTimeoutMs
		?? (expectResponse ? DEFAULT_EXECUTE_TIMEOUT_MS : FIRE_AND_FORGET_TIMEOUT_MS);

	if (!config.rconIP || !config.rconPass) {
		return { ok: false, output: null, error: new Error('RCON is not configured.') };
	}

	const rcon = createRcon();
	try {
		await withTimeout(rcon.authenticate(config.rconPass), DEFAULT_EXECUTE_TIMEOUT_MS, 'authenticate');
		try {
			const output = await withTimeout(rcon.execute(command), executeTimeoutMs, 'execute');
			return { ok: true, output, error: null };
		}
		catch (err) {
			if (err?.code === 'RCON_TIMEOUT' && !expectResponse) {
				// Fire-and-forget command: auth succeeded so the server is
				// reachable, and the timeout means the command was sent and
				// the server simply didn't echo a reply. Treat as success.
				return { ok: true, output: null, error: null };
			}
			throw err;
		}
	}
	catch (err) {
		return { ok: false, output: null, error: err };
	}
	finally {
		try {
			await rcon.disconnect();
		}
		catch {
			// Ignore disconnect failures after command completion.
		}
	}
}

module.exports = {
	runRconCommand,
};
