const path = require('node:path');
const config = require(path.join(__dirname, '..', 'config.json'));
const Rcon = require('rcon-srcds').default;

function createRcon() {
	return new Rcon({
		host: config.rconIP,
		port: config.rconPort || 27015,
		encoding: 'utf8',
		timeout: 5000,
	});
}

// Runs a single RCON command and tears the connection down. Returns
// { ok, output, error } so callers can decide how to surface failures
// without throwing through the poller or other long-lived loops.
async function runRconCommand(command) {
	if (!config.rconIP || !config.rconPass) {
		return { ok: false, output: null, error: new Error('RCON is not configured.') };
	}

	const rcon = createRcon();
	try {
		await rcon.authenticate(config.rconPass);
		const output = await rcon.execute(command);
		return { ok: true, output, error: null };
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
