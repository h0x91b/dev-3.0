import { appendFileSync, mkdirSync } from "node:fs";
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

let minLevel: LogLevel = "debug";
let logDir: string | null = null;
let currentLogFile: string | null = null;
let currentLogDate: string | null = null;

// Track which directories have been created so we only mkdir once per dir.
const ensuredDirs = new Set<string>();

function getLogDir(): string {
	if (!logDir) {
		logDir = `${DEV3_HOME}/logs`;
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

function appendToFile(line: string): void {
	try {
		const filePath = getLogFile();
		ensureDir(filePath);
		appendFileSync(filePath, line + "\n");
	} catch (err) {
		// Last resort — don't let file logging break the app
		console.error("[logger] Failed to write log file:", err);
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
		line += ` ${DIM}${JSON.stringify(extra)}${RESET}`;
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
	let line = `${t} ${lvl} [${tag}] ${msg}`;
	if (extra && Object.keys(extra).length > 0) {
		line += ` ${JSON.stringify(extra)}`;
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

	const consoleLine = formatForConsole(level, tag, msg, extra);
	const fileLine = formatForFile(level, tag, msg, extra);

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

export function getLogPath(): string {
	return getLogDir();
}

// Init: ensure log directory exists on first import
ensureDir(`${getLogDir()}/init.log`);
