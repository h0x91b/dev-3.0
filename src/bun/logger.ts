import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEV3_HOME } from "./paths";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
	debug: "\x1b[36m", // cyan
	info: "\x1b[32m",  // green
	warn: "\x1b[33m",  // yellow
	error: "\x1b[31m", // red
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/** Keep today's file plus the previous 13 calendar days. */
export const LOG_RETENTION_DAYS = 14;

const REDACTED = "[redacted]";
const LOG_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// These values can contain the task prompt, agent instructions, credentials,
// or command arguments. Keep the key names broad because many RPC handlers log
// their params object directly.
const COMMAND_KEYS = new Set([
	"command",
	"cmd",
	"args",
	"argv",
	"agentcmd",
	"agentcommand",
	"tmuxcmd",
	"tmuxcommand",
	"installcmd",
	"resolvedcommand",
	"resumecommand",
	"resumecmd",
	"shellcommand",
	"wrappedcommand",
	"installcommand",
]);
const PAYLOAD_KEYS = new Set([
	"description",
	"taskdescription",
	"prompt",
	"taskprompt",
	"title",
	"tasktitle",
	"customtitle",
	"overview",
	"useroverview",
	"content",
	"body",
	"url",
	"baseurl",
	"token",
	"secret",
	"password",
	"authorization",
	"cookie",
	"env",
	"extraenv",
	"envtext",
	"input",
]);

function normalizeKey(key: string): string {
	return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function stringLength(value: unknown): number | undefined {
	if (typeof value === "string" || Array.isArray(value)) return value.length;
	return undefined;
}

function redactedPayload(value: unknown): Record<string, unknown> {
	const length = stringLength(value);
	return length === undefined
		? { redacted: true }
		: { redacted: true, length };
}

function executableName(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	const trimmed = value.trim();
	if (!trimmed) return "unknown";
	const first = trimmed.match(/^(?:'([^']+)'|"([^"]+)"|(\S+))/);
	const token = first?.[1] ?? first?.[2] ?? first?.[3] ?? trimmed;
	return token.split(/[\\/]/).pop() || "unknown";
}

interface CommandSummary {
	redacted: true;
	executable: string;
	argumentCount: number;
}

/** Preserve command shape for diagnostics without retaining any arguments. */
function summarizeCommand(command: unknown): CommandSummary {
	if (Array.isArray(command)) {
		return {
			redacted: true,
			executable: executableName(command[0]),
			argumentCount: Math.max(0, command.length - 1),
		};
	}
	if (typeof command === "string") {
		const trimmed = command.trim();
		return {
			redacted: true,
			executable: executableName(trimmed),
			argumentCount: trimmed ? Math.max(0, trimmed.split(/\s+/).length - 1) : 0,
		};
	}
	return { redacted: true, executable: "unknown", argumentCount: 0 };
}

type SeenObjects = WeakSet<object>;

function sanitizeLogValue(value: unknown, key: string | undefined, seen: SeenObjects): unknown {
	const normalized = key ? normalizeKey(key) : "";
	if (COMMAND_KEYS.has(normalized)) return summarizeCommand(value);
	if (PAYLOAD_KEYS.has(normalized)) return redactedPayload(value);

	if (value === null || value === undefined) return value;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "function" || typeof value === "symbol") return REDACTED;
	if (typeof value !== "object") return REDACTED;
	if (seen.has(value)) return "[circular]";
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeLogValue(item, undefined, seen));
	}

	const result: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		try {
			result[childKey] = sanitizeLogValue(childValue, childKey, seen);
		} catch {
			result[childKey] = REDACTED;
		}
	}
	return result;
}

/** Return a JSON-safe log payload with prompt-like values removed. */
function sanitizeLogExtra(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!extra) return undefined;
	try {
		const safe = sanitizeLogValue(extra, undefined, new WeakSet<object>());
		return safe && typeof safe === "object" && !Array.isArray(safe)
			? safe as Record<string, unknown>
			: { value: safe };
	} catch {
		return { redacted: true };
	}
}

/**
 * Resolve the initial minimum log level.
 *
 * History: this used to be hard-coded to `"debug"`, and nothing ever lowered
 * it — so every build (including prod) wrote every DEBUG line to disk via a
 * synchronous `appendFileSync` on each call. On a busy machine the git-status
 * pollers alone produced tens of thousands of DEBUG lines per session
 * (multi-MB/day) and the synchronous writes nibbled at the event loop.
 *
 * Rules (first match wins):
 *   1. `DEV3_LOG_LEVEL=debug|info|warn|error` — explicit override, always honored.
 *   2. dev builds (`DEV3_CHANNEL=dev`) keep full `debug` logs.
 *   3. everything else (prod/staging/canary) defaults to `info`.
 */
export function resolveLogLevel(env: Record<string, string | undefined>): LogLevel {
	const explicit = env.DEV3_LOG_LEVEL?.toLowerCase();
	if (
		explicit === "debug" ||
		explicit === "info" ||
		explicit === "warn" ||
		explicit === "error"
	) {
		return explicit;
	}
	return env.DEV3_CHANNEL === "dev" ? "debug" : "info";
}

/**
 * Resolve the directory the daily log files live in.
 *
 * History: this used to be hard-coded to `${DEV3_HOME}/logs`. Every vitest
 * worker that imported a module calling `createLogger` (updater.ts, data.ts,
 * git.ts, …) without a per-file `vi.mock("../logger")` therefore appended its
 * synthetic INFO/WARN/ERROR lines to the *real* user log — polluting it with
 * fake `[NNNN:updater] applyUpdate` errors and `bbbb2222` update hashes that
 * cost real time to misdiagnose during a live incident. See decision 108.
 *
 * Rules (first match wins):
 *   1. `DEV3_LOG_DIR` — explicit override, always honored (tests, sandboxes).
 *   2. under a test runner (`VITEST` / `NODE_ENV=test`) — an isolated tmp dir,
 *      so unit tests never touch `${DEV3_HOME}/logs`. This fixes every current
 *      and future bun/cli test at once, with no per-file logger mock needed.
 *   3. everything else (the real app / CLI) — `${DEV3_HOME}/logs`.
 */
export function resolveLogDir(env: Record<string, string | undefined>): string {
	const override = env.DEV3_LOG_DIR?.trim();
	if (override) return override;
	if (env.VITEST || env.NODE_ENV === "test") {
		return `${tmpdir()}/dev3-test-logs`;
	}
	return `${DEV3_HOME}/logs`;
}

let minLevel: LogLevel = resolveLogLevel(process.env);
let logDir: string | null = null;
let currentLogFile: string | null = null;
let currentLogDate: string | null = null;
let lastPrunedLogDate: string | null = null;

// Track which directories have been created so we only mkdir once per dir.
const ensuredDirs = new Set<string>();

function getLogDir(): string {
	if (!logDir) {
		logDir = resolveLogDir(process.env);
	}
	return logDir;
}

function dateStr(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeStr(): string {
	const d = new Date();
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function getLogFile(): string {
	const today = dateStr();
	if (currentLogDate !== today || !currentLogFile) {
		currentLogDate = today;
		const dir = `${getLogDir()}/${today.slice(0, 4)}/${today.slice(5, 7)}`;
		currentLogFile = `${dir}/${today}.log`;
	}
	return currentLogFile;
}

function ensureDir(filePath: string): void {
	const dir = filePath.slice(0, filePath.lastIndexOf("/"));
	if (ensuredDirs.has(dir)) return;
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// Directory may already exist — that's fine
	}
	ensuredDirs.add(dir);
}

type LogDirectoryEntry = {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
};

function readLogDirectory(path: string): LogDirectoryEntry[] {
	return readdirSync(path, { withFileTypes: true }) as unknown as LogDirectoryEntry[];
}

function parseLogDay(fileName: string): number | null {
	const match = LOG_FILE_RE.exec(fileName);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date.getTime();
}

/** Delete dated diagnostic files outside the retention window, best-effort. */
export function pruneLogFiles(now: Date = new Date(), root: string = getLogDir()): number {
	const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	const cutoff = today - (LOG_RETENTION_DAYS - 1) * DAY_MS;
	let removed = 0;

	try {
		for (const yearEntry of readLogDirectory(root)) {
			if (!yearEntry.isDirectory()) continue;
			const yearDir = `${root}/${yearEntry.name}`;
			for (const monthEntry of readLogDirectory(yearDir)) {
				if (!monthEntry.isDirectory()) continue;
				const monthDir = `${yearDir}/${monthEntry.name}`;
				for (const fileEntry of readLogDirectory(monthDir)) {
					if (!fileEntry.isFile()) continue;
					const fileDay = parseLogDay(fileEntry.name);
					if (!fileDay || fileDay >= cutoff) continue;
					try {
						unlinkSync(`${monthDir}/${fileEntry.name}`);
						removed += 1;
					} catch {
						// A concurrent writer or a permission change must not affect logging.
					}
				}
			}
		}
	} catch {
		// Missing, unreadable, or partially removed log directories are harmless.
	}

	return removed;
}

function pruneLogFilesIfNeeded(): void {
	const today = dateStr();
	if (lastPrunedLogDate === today) return;
	lastPrunedLogDate = today;
	try {
		pruneLogFiles();
	} catch {
		// pruneLogFiles is already defensive; keep this guard for unusual fs mocks.
	}
}

function appendToFile(line: string): void {
	const filePath = getLogFile();
	let wrote = false;
	try {
		ensureDir(filePath);
		appendFileSync(filePath, line + "\n");
		wrote = true;
	} catch {
		// The log directory may have been removed out from under us after we
		// cached it in `ensuredDirs` — e.g. a tmp dir wiped between tests, or a
		// user clearing ~/.dev3.0/logs while the app runs. The stale cache then
		// makes `ensureDir` skip the mkdir, so the append hits a missing dir.
		// Drop the cache entry, recreate the directory, and retry once.
		try {
			const dir = filePath.slice(0, filePath.lastIndexOf("/"));
			ensuredDirs.delete(dir);
			ensureDir(filePath);
			appendFileSync(filePath, line + "\n");
			wrote = true;
		} catch (retryErr) {
			// Last resort — don't let file logging break the app.
			console.error("[logger] Failed to write log file:", retryErr);
		}
	}
	if (wrote) pruneLogFilesIfNeeded();
}

function stringifyExtra(extra?: Record<string, unknown>): string {
	try {
		return JSON.stringify(extra) ?? "{}";
	} catch {
		return JSON.stringify({ redacted: true });
	}
}

function formatForConsole(
	level: LogLevel,
	tag: string,
	msg: string,
	extra?: Record<string, unknown>,
): string {
	const color = LEVEL_COLORS[level];
	const lvl = level.toUpperCase().padEnd(5);
	const t = timeStr();
	let line = `${DIM}${t}${RESET} ${color}${lvl}${RESET} ${DIM}[${tag}]${RESET} ${msg}`;
	if (extra && Object.keys(extra).length > 0) {
		line += ` ${DIM}${stringifyExtra(extra)}${RESET}`;
	}
	return line;
}

function formatForFile(
	level: LogLevel,
	tag: string,
	msg: string,
	extra?: Record<string, unknown>,
): string {
	const lvl = level.toUpperCase().padEnd(5);
	const t = `${dateStr()} ${timeStr()}`;
	// PID disambiguates writers: the app, CLI invocations, and test-spawned
	// processes all append to the same daily file, and interleaved lines
	// without a PID make stall/timing analysis attribute work to the wrong
	// process.
	let line = `${t} ${lvl} [${process.pid}:${tag}] ${msg}`;
	if (extra && Object.keys(extra).length > 0) {
		line += ` ${stringifyExtra(extra)}`;
	}
	return line;
}

function log(
	level: LogLevel,
	tag: string,
	msg: string,
	extra?: Record<string, unknown>,
): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
	const safeExtra = sanitizeLogExtra(extra);

	const consoleLine = formatForConsole(level, tag, msg, safeExtra);
	const fileLine = formatForFile(level, tag, msg, safeExtra);

	// Console output
	switch (level) {
		case "error":
			console.error(consoleLine);
			break;
		case "warn":
			console.warn(consoleLine);
			break;
		default:
			console.log(consoleLine);
	}

	// File output (synchronous append — no memory overhead)
	appendToFile(fileLine);
}

export interface Logger {
	debug(msg: string, extra?: Record<string, unknown>): void;
	info(msg: string, extra?: Record<string, unknown>): void;
	warn(msg: string, extra?: Record<string, unknown>): void;
	error(msg: string, extra?: Record<string, unknown>): void;
}

export function createLogger(tag: string): Logger {
	return {
		debug: (msg, extra) => log("debug", tag, msg, extra),
		info: (msg, extra) => log("info", tag, msg, extra),
		warn: (msg, extra) => log("warn", tag, msg, extra),
		error: (msg, extra) => log("error", tag, msg, extra),
	};
}

export function setMinLevel(level: LogLevel): void {
	minLevel = level;
}

export function getMinLevel(): LogLevel {
	return minLevel;
}

export function getLogPath(): string {
	return getLogDir();
}

// Init: ensure log directory exists on first import
ensureDir(`${getLogDir()}/init.log`);
