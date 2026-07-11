/**
 * Agent rate-limit monitor — periodically reads local rate-limit sources and
 * pushes changes to the renderer:
 *
 * - Claude: ~/.dev3.0/data/rate-limits/claude.json, written by the injected
 *   `dev3 statusline` wrapper on every statusLine refresh of any dev3-launched
 *   Claude session (see src/cli/commands/statusline.ts).
 * - Codex: the newest rollout file under ~/.codex/sessions/YYYY/MM/DD/ — the
 *   tail contains `token_count` events with a `rate_limits` object.
 * - Codex monthly credits: a cached read-only request through the locally
 *   authenticated `codex app-server`, with rollout-only fallback.
 *
 * Also owns the static `--settings` file injected into Claude launches, which
 * routes the session's statusLine through `dev3 statusline`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport } from "../shared/rate-limits";
import { extractCodexSnapshotFromRolloutLines, mergeCodexRateLimitSnapshots, parseClaudeStatusLinePayload } from "../shared/rate-limits";
import { fetchCodexRateLimitSnapshot } from "./codex-rate-limits";
import { listCodexAccountDirs } from "./agent-accounts";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";
import { loadSettings } from "./settings";

const log = createLogger("rate-limit-monitor");
const POLL_INTERVAL_MS = 30_000;
/** Avoid spawning app-server and hitting the account endpoint every poll. */
const CODEX_LIVE_REFRESH_MS = 5 * 60_000;
/** How much of a rollout file tail to scan for the last rate_limits event. */
const CODEX_TAIL_BYTES = 256 * 1024;
/** How many most-recent day directories to consider when locating the live rollout. */
const CODEX_DAY_DIRS_TO_SCAN = 3;

export const RATE_LIMITS_DIR = join(DEV3_HOME, "data", "rate-limits");
export const CLAUDE_RATE_LIMIT_DUMP_PATH = join(RATE_LIMITS_DIR, "claude.json");
/** The static settings file injected via `claude --settings <path>`. */
export const CLAUDE_STATUSLINE_SETTINGS_PATH = join(RATE_LIMITS_DIR, "claude-statusline-settings.json");

type PushMessageFn = (name: string, payload: unknown) => void;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pushMessageFn: PushMessageFn | null = null;
let lastPushedKey = "";
let cachedReport: AgentRateLimitsReport | null = null;
let cachedCodexLiveSnapshot: AgentRateLimitSnapshot | null = null;
let codexLiveAttemptedAt = 0;
let codexLiveRequest: Promise<AgentRateLimitSnapshot | null> | null = null;

/**
 * Write (once) the settings file whose statusLine routes through
 * `dev3 statusline`, and return its path. Returns null when writing fails —
 * callers then simply skip `--settings` injection.
 */
export function ensureClaudeStatusLineSettings(): string | null {
	try {
		mkdirSync(RATE_LIMITS_DIR, { recursive: true });
		const dev3Bin = join(homedir(), ".dev3.0", "bin", "dev3");
		const desired = JSON.stringify({
			statusLine: { type: "command", command: `"${dev3Bin}" statusline` },
		});
		let current = "";
		try {
			current = readFileSync(CLAUDE_STATUSLINE_SETTINGS_PATH, "utf-8");
		} catch {
			// missing — will write below
		}
		if (current !== desired) writeFileSync(CLAUDE_STATUSLINE_SETTINGS_PATH, desired);
		return CLAUDE_STATUSLINE_SETTINGS_PATH;
	} catch (err) {
		log.warn("Failed to write statusline settings file", { error: String(err) });
		return null;
	}
}

/** Parse the dump written by `dev3 statusline`. Null when absent/corrupt. */
export function readClaudeSnapshot(dumpPath: string = CLAUDE_RATE_LIMIT_DUMP_PATH): AgentRateLimitSnapshot | null {
	try {
		if (!existsSync(dumpPath)) return null;
		const parsed = JSON.parse(readFileSync(dumpPath, "utf-8")) as { capturedAt?: number; payload?: unknown };
		const capturedAt = typeof parsed.capturedAt === "number" ? parsed.capturedAt : statSync(dumpPath).mtimeMs;
		return parseClaudeStatusLinePayload(parsed.payload, capturedAt);
	} catch {
		return null; // torn write or corrupt file — keep whatever we knew before
	}
}

function codexSessionsRoot(): string {
	return process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "sessions") : join(homedir(), ".codex", "sessions");
}

/** Every codex session root to scan: the system login (~/.codex or $CODEX_HOME)
 *  plus each managed account's per-account CODEX_HOME — per-launch account
 *  injection scatters rollouts across those, so a single root would miss the
 *  latest session whenever it ran under a non-default account. */
function codexSessionRoots(): string[] {
	const roots = [codexSessionsRoot()];
	for (const dir of listCodexAccountDirs()) roots.push(join(dir, "sessions"));
	return roots;
}

function listSortedDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

/**
 * Locate the most recently written rollout file. Sessions can span midnight
 * (a file named for yesterday may still be the live one), so pick by mtime
 * across the last few day directories rather than by filename alone.
 */
export function findLatestCodexRollout(root: string = codexSessionsRoot()): string | null {
	const dayDirs: string[] = [];
	for (const year of listSortedDirs(root).reverse()) {
		for (const month of listSortedDirs(join(root, year)).reverse()) {
			for (const day of listSortedDirs(join(root, year, month)).reverse()) {
				dayDirs.push(join(root, year, month, day));
				if (dayDirs.length >= CODEX_DAY_DIRS_TO_SCAN) break;
			}
			if (dayDirs.length >= CODEX_DAY_DIRS_TO_SCAN) break;
		}
		if (dayDirs.length >= CODEX_DAY_DIRS_TO_SCAN) break;
	}

	let newest: { path: string; mtimeMs: number } | null = null;
	for (const dir of dayDirs) {
		let entries: string[];
		try {
			entries = readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of entries) {
			const path = join(dir, file);
			try {
				const mtimeMs = statSync(path).mtimeMs;
				if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
			} catch {
				// file vanished mid-scan
			}
		}
	}
	return newest?.path ?? null;
}

/** Read the tail of a file (bounded), split into lines. */
function readTailLines(path: string, maxBytes: number): string[] {
	const size = statSync(path).size;
	const start = Math.max(0, size - maxBytes);
	const length = size - start;
	if (length <= 0) return [];
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(length);
		const read = readSync(fd, buf, 0, length, start);
		return buf.toString("utf-8", 0, read).split("\n");
	} finally {
		closeSync(fd);
	}
}

/** Pick the globally-newest rollout across the given roots (default: the system
 *  root + every managed-account CODEX_HOME), so the indicator reflects whichever
 *  codex session ran most recently regardless of which account it used. Pass an
 *  explicit `root` to scan just one (used by tests). */
export function readCodexSnapshot(root?: string): AgentRateLimitSnapshot | null {
	try {
		const roots = root !== undefined ? [root] : codexSessionRoots();
		let best: { path: string; mtimeMs: number } | null = null;
		for (const r of roots) {
			const rollout = findLatestCodexRollout(r);
			if (!rollout) continue;
			try {
				const mtimeMs = statSync(rollout).mtimeMs;
				if (!best || mtimeMs > best.mtimeMs) best = { path: rollout, mtimeMs };
			} catch {
				// file vanished mid-scan
			}
		}
		if (!best) return null;
		return extractCodexSnapshotFromRolloutLines(readTailLines(best.path, CODEX_TAIL_BYTES));
	} catch (err) {
		log.warn("Codex rollout scan failed", { error: String(err) });
		return null;
	}
}

async function readCodexLiveSnapshot(now: number = Date.now()): Promise<AgentRateLimitSnapshot | null> {
	if (now - codexLiveAttemptedAt < CODEX_LIVE_REFRESH_MS) return cachedCodexLiveSnapshot;
	if (codexLiveRequest) return codexLiveRequest;
	codexLiveAttemptedAt = now;
	codexLiveRequest = fetchCodexRateLimitSnapshot()
		.then((snapshot) => {
			if (snapshot) cachedCodexLiveSnapshot = snapshot;
			return cachedCodexLiveSnapshot;
		})
		.finally(() => {
			codexLiveRequest = null;
		});
	return codexLiveRequest;
}

async function trackingEnabled(): Promise<boolean> {
	try {
		const settings = await loadSettings();
		return settings.agentRateLimitTracking !== false;
	} catch {
		return true;
	}
}

export async function getAgentRateLimitsReport(): Promise<AgentRateLimitsReport> {
	if (!(await trackingEnabled())) {
		return { snapshots: [], generatedAt: Date.now() };
	}
	const snapshots: AgentRateLimitSnapshot[] = [];
	const claude = readClaudeSnapshot();
	if (claude) snapshots.push(claude);
	const codex = mergeCodexRateLimitSnapshots(readCodexSnapshot(), await readCodexLiveSnapshot());
	if (codex) snapshots.push(codex);
	const report: AgentRateLimitsReport = { snapshots, generatedAt: Date.now() };
	cachedReport = report;
	return report;
}

/** Change-detection key: pushes happen only when the meaningful bits move. */
function reportKey(report: AgentRateLimitsReport): string {
	return report.snapshots
		.map(
			(s) =>
				`${s.source}:${s.capturedAt}:${s.windows.map((w) => `${w.id}=${w.usedPercent}@${w.resetsAt}`).join(",")}:${s.creditsBalance}:${s.monthlyCredits ? `${s.monthlyCredits.used}/${s.monthlyCredits.limit}@${s.monthlyCredits.resetsAt}` : ""}`,
		)
		.join("|");
}

async function poll() {
	try {
		if (!pushMessageFn) return;
		const report = await getAgentRateLimitsReport();
		const key = reportKey(report);
		if (key !== lastPushedKey) {
			lastPushedKey = key;
			pushMessageFn("agentRateLimitsUpdated", report);
		}
	} catch (err) {
		log.error("Rate-limit poll cycle failed", { error: String(err) });
	} finally {
		pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
	}
}

export function startRateLimitMonitor(push: PushMessageFn): void {
	pushMessageFn = push;
	log.info("Rate-limit monitor started", { intervalMs: POLL_INTERVAL_MS });
	pollTimer = setTimeout(poll, 3_000); // first read shortly after startup
}

export function stopRateLimitMonitor(): void {
	if (pollTimer) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
	pushMessageFn = null;
	lastPushedKey = "";
	cachedReport = null;
	cachedCodexLiveSnapshot = null;
	codexLiveAttemptedAt = 0;
	codexLiveRequest = null;
}

/** Last computed report (may be null before the first poll/RPC). */
export function getCachedRateLimitsReport(): AgentRateLimitsReport | null {
	return cachedReport;
}
