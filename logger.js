/**
 * Webhook logger that mirrors console warnings and errors to Discord.
 *
 * Messages are queued and drained slowly to stay below webhook rate limits.
 * The queue is bounded so repeated failures cannot grow memory without limit.
 */

const config = require('./config.json');

const WEBHOOK_URL = typeof config.logWebhook === 'string' ? config.logWebhook.trim() : '';
const DRAIN_INTERVAL_MS = 2500;
const MAX_QUEUE = 20;
const WARN_PREFIX = '\u26A0\uFE0F **WARN** ';
const ERROR_PREFIX = '\u{1F534} **ERROR** ';

const queue = [];
let drainTimer = null;
let consolePatched = false;

function getLogPrefix() {
	return `[${new Date().toISOString()} pid=${process.pid}]`;
}

function formatConsoleArgs(args) {
	return [getLogPrefix(), ...args];
}

function scheduleDrain() {
	if (drainTimer || queue.length === 0) return;

	drainTimer = setTimeout(() => {
		drain().catch(err => {
			process.stderr.write(`[logger] drain failed: ${err.message}\n`);
		});
	}, DRAIN_INTERVAL_MS);
	drainTimer.unref();
}

async function drain() {
	drainTimer = null;
	if (queue.length === 0 || !WEBHOOK_URL) return;

	const content = queue.shift();
	try {
		const response = await fetch(WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content }),
		});
		if (!response.ok) {
			process.stderr.write(`[logger] webhook returned ${response.status}\n`);
		}
	}
	catch (err) {
		process.stderr.write(`[logger] failed to post to webhook: ${err.message}\n`);
	}

	scheduleDrain();
}

async function flush() {
	if (!WEBHOOK_URL) return;
	if (drainTimer) {
		clearTimeout(drainTimer);
		drainTimer = null;
	}

	while (queue.length > 0) {
		await drain();
	}
}

function enqueue(content) {
	if (!WEBHOOK_URL) return;

	if (queue.length >= MAX_QUEUE) {
		queue.shift();
	}
	queue.push(content);
	scheduleDrain();
}

function formatArgs(args) {
	return args.map(arg => {
		if (arg instanceof Error) return arg.stack || arg.message;
		if (typeof arg === 'object' && arg !== null) {
			try {
				return JSON.stringify(arg, null, 2);
			}
			catch {
				return String(arg);
			}
		}
		return String(arg);
	}).join(' ');
}

function wrapCode(text) {
	const trimmed = text.trim();
	const maxLength = 1900;
	const truncated = trimmed.length > maxLength
		? `${trimmed.slice(0, maxLength)}\n... (truncated)`
		: trimmed;
	return truncated.includes('\n')
		? `\`\`\`\n${truncated}\n\`\`\``
		: `\`${truncated}\``;
}

function patchConsole() {
	if (consolePatched) return;
	consolePatched = true;

	const originalWarn = console.warn.bind(console);
	const originalError = console.error.bind(console);
	const originalLog = console.log.bind(console);

	console.log = (...args) => {
		originalLog(...formatConsoleArgs(args));
	};

	console.warn = (...args) => {
		originalWarn(...formatConsoleArgs(args));
		enqueue(`${WARN_PREFIX}${wrapCode(formatArgs(args))}`);
	};

	console.error = (...args) => {
		originalError(...formatConsoleArgs(args));
		enqueue(`${ERROR_PREFIX}${wrapCode(formatArgs(args))}`);
	};
}

function attachGlobalHandlers() {
	process.on('warning', warning => {
		console.warn('[process] Warning:', warning.stack || warning.message);
	});

	process.on('unhandledRejection', reason => {
		const text = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
		console.error('[process] Unhandled promise rejection:', text);
	});

	process.on('uncaughtException', err => {
		console.error('[process] Uncaught exception:', err.stack || err.message);
		drain().catch(drainError => {
			process.stderr.write(`[logger] failed to flush after uncaught exception: ${drainError.message}\n`);
		});
		setTimeout(() => process.exit(1), DRAIN_INTERVAL_MS + 500).unref();
	});
}

patchConsole();
attachGlobalHandlers();

module.exports = {
	flush,
};
