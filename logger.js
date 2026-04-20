/**
 * Webhook logger that mirrors console warnings and errors to Discord.
 *
 * Messages are queued and drained with backoff-aware pacing so we stay
 * below webhook rate limits. The queue is bounded so repeated failures
 * cannot grow memory without limit.
 *
 * Side effects only run after `init()` is called, not on require.
 */

const config = require('./config.json');

const WEBHOOK_URL = typeof config.logWebhook === 'string' ? config.logWebhook.trim() : '';
const DRAIN_INTERVAL_MS = 2500;
const MAX_QUEUE = 20;
const WARN_PREFIX = '\u26A0\uFE0F **WARN** ';
const ERROR_PREFIX = '\u{1F534} **ERROR** ';
const EXIT_GRACE_MS = 3000;

const queue = [];
let drainTimer = null;
// Promise representing an in-flight webhook POST, or null if idle. Both
// drain() (for re-entrancy) and flush() (to wait for shutdown delivery)
// synchronize on this single handle.
let currentDrain = null;
let nextAllowedPostAt = 0;
let initialized = false;

function getLogPrefix() {
	return `[${new Date().toISOString()} pid=${process.pid}]`;
}

function scheduleDrain() {
	if (drainTimer || currentDrain || queue.length === 0 || !WEBHOOK_URL) return;
	const delay = Math.max(nextAllowedPostAt - Date.now(), DRAIN_INTERVAL_MS);
	drainTimer = setTimeout(() => {
		drainTimer = null;
		drain().catch(err => process.stderr.write(`[logger] drain failed: ${err.message}\n`));
	}, delay);
	drainTimer.unref();
}

async function postOnce(content) {
	try {
		const response = await fetch(WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content }),
		});

		if (response.status === 429) {
			const retryAfter = Number(response.headers.get('retry-after')) || 2;
			nextAllowedPostAt = Date.now() + (retryAfter * 1000) + 250;
			return { requeue: true };
		}

		if (!response.ok) {
			process.stderr.write(`[logger] webhook returned ${response.status}\n`);
			return { requeue: false };
		}

		const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));
		if (Number.isFinite(resetAfter) && resetAfter > 0) {
			nextAllowedPostAt = Date.now() + (resetAfter * 1000);
		}
		return { requeue: false };
	}
	catch (err) {
		process.stderr.write(`[logger] failed to post to webhook: ${err.message}\n`);
		return { requeue: false };
	}
}

async function drain() {
	if (currentDrain || queue.length === 0 || !WEBHOOK_URL) return currentDrain;
	currentDrain = (async () => {
		try {
			const content = queue.shift();
			const { requeue } = await postOnce(content);
			if (requeue) queue.unshift(content);
		}
		finally {
			currentDrain = null;
		}
	})();
	const inFlight = currentDrain;
	await inFlight;
	if (queue.length > 0) scheduleDrain();
	return inFlight;
}

async function flush() {
	if (!WEBHOOK_URL) return;
	if (drainTimer) {
		clearTimeout(drainTimer);
		drainTimer = null;
	}

	// Wait for any in-flight post first, then drain the rest serially.
	// If a post is in flight we must not shift the queue ourselves, and
	// we must not return before that post resolves (or requeues).
	while (currentDrain || queue.length > 0) {
		if (currentDrain) {
			await currentDrain;
			continue;
		}
		const wait = nextAllowedPostAt - Date.now();
		if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
		await drain();
	}
}

function enqueue(content) {
	if (!WEBHOOK_URL) return;
	if (queue.length >= MAX_QUEUE) queue.shift();
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
	return truncated.includes('\n') ? `\`\`\`\n${truncated}\n\`\`\`` : `\`${truncated}\``;
}

function patchConsole() {
	const originalWarn = console.warn.bind(console);
	const originalError = console.error.bind(console);
	const originalLog = console.log.bind(console);

	console.log = (...args) => originalLog(getLogPrefix(), ...args);
	console.warn = (...args) => {
		originalWarn(getLogPrefix(), ...args);
		enqueue(`${WARN_PREFIX}${wrapCode(formatArgs(args))}`);
	};
	console.error = (...args) => {
		originalError(getLogPrefix(), ...args);
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
		// Best-effort flush. Do not `.unref()` the timer — we want it to keep
		// the loop alive long enough to actually ship the message.
		flush()
			.catch(flushError => process.stderr.write(`[logger] failed to flush after uncaught exception: ${flushError.message}\n`))
			.finally(() => setTimeout(() => process.exit(1), EXIT_GRACE_MS));
	});
}

function init() {
	if (initialized) return;
	initialized = true;
	patchConsole();
	attachGlobalHandlers();
}

module.exports = {
	init,
	flush,
};
