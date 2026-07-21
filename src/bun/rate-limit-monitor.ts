/**
 * Agent rate-limit monitor — periodically reads local rate-limit sources and
 * pushes changes to the renderer:
 *
 * - Claude: the legacy global dump plus one dump per managed account under
 *   ~/.dev3.0/data/rate-limits/claude/, written by the injected `dev3 statusline`
 *   wrapper on every statusLine refresh (see src/cli/commands/statusline.ts).
 * - Codex: the newest rollout file under each system or managed CODEX_HOME's
 *   sessions/YYYY/MM/DD/ directory — the tail contains `token_count` events
 *   with a `rate_limits` object.
 * - Codex monthly credits: a cached read-only request through the locally
 *   authenticated `codex app-server`, with rollout-only fallback.
 *
 * Also owns the static `--settings` file injected into Claude launches, which
 * routes the session's statusLine through `dev3 statusline`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport } from "../shared/rate-limits";
import {
	RATE_LIMIT_ACTIVITY_WINDOW_MS,
	extractCodexSnapshotFromRolloutLines,
	isRateLimitSnapshotRecent,
	mergeCodexRateLimitSnapshots,
	parseClaudeStatusLinePayload,
	rateLimitActivityAt,
} from "../shared/rate-limits";
import { fetchCodexRateLimitSnapshot } from "./codex-rate-limits";
import { listClaudeAccountDirs, listCodexAccountDirs } from "./agent-accounts";
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
/** Per-managed-account Claude dumps. The legacy global dump remains the system
 * login fallback and is also written for compatibility with older builds. */
export const CLAUDE_ACCOUNT_RATE_LIMITS_DIR = join(RATE_LIMITS_DIR, "claude");
/** The dev3-managed settings file injected via `claude --settings <path>`. It
 * always suppresses the one-time bypass-permission confirmation and optionally
 * routes statusLine through `dev3 statusline` (see buildClaudeManagedSettings). */
export const CLAUDE_STATUSLINE_SETTINGS_PATH = join(RATE_LIMITS_DIR, "claude-statusline-settings.json");

type PushMessageFn = (name: string, payload: unknown) => void;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pushMessageFn: PushMessageFn | null = null;
let lastPushedKey = "";
let cachedReport: AgentRateLimitsReport | null = null;
const cachedCodexLiveSnapshots = new Map<string, AgentRateLimitSnapshot>();
const codexLiveAttemptedAt = new Map<string, number>();
const codexLiveRequests = new Map<string, Promise<AgentRateLimitSnapshot | null>>();

/**
 * Build the dev3-managed Claude settings object injected via `claude --settings`.
 * `skipDangerousModePermissionPrompt` is ALWAYS present: dev3 launches every
 * Claude session with a dangerous-bypass flag available (`--allow-dangerously-
 * skip-permissions` or a preset's `--dangerously-skip-permissions`), which would
 * otherwise trigger a one-time confirmation prompt on startup. When rate-limit
 * tracking is on, statusLine is also routed through `dev3 statusline`.
 */
export function buildClaudeManagedSettings(dev3Bin: string, includeStatusLine: boolean): Record<string, unknown> {
	const settings: Record<string, unknown> = { skipDangerousModePermissionPrompt: true };
	if (includeStatusLine) {
		settings.statusLine = { type: "command", command: `"${dev3Bin}" statusline` };
	}
	return settings;
}

/**
 * Write (once) the dev3-managed Claude settings file and return its path. Always
 * carries skipDangerousModePermissionPrompt; includes the statusLine wrapper only
 * when rate-limit tracking is on. Returns null when writing fails — callers then
 * simply skip `--settings` injection.
 */
export function ensureClaudeStatusLineSettings(includeStatusLine = true): string | null {
	try {
		mkdirSync(RATE_LIMITS_DIR, { recursive: true });
		const dev3Bin = join(homedir(), ".dev3.0", "bin", "dev3");
		const desired = JSON.stringify(buildClaudeManagedSettings(dev3Bin, includeStatusLine));
		let current = "";
		try {
			current = readFileSync(CLAUDE_STATUSLINE_SETTINGS_PATH, "utf-8");
		} catch {
			// missing — will write below
		}
		if (current !== desired) writeFileSync(CLAUDE_STATUSLINE_SETTINGS_PATH, desired);
		return CLAUDE_STATUSLINE_SETTINGS_PATH;
	} catch (err) {
		log.warn("Failed to write claude managed settings file", { error: String(err) });
		return null;
	}
}

/** Parse the dump written by `dev3 statusline`. Null when absent/corrupt. */
export function readClaudeSnapshot(dumpPath: string = CLAUDE_RATE_LIMIT_DUMP_PATH, accountId?: string | null): AgentRateLimitSnapshot | null {
	try {
		if (!existsSync(dumpPath)) return null;
		const parsed = JSON.parse(readFileSync(dumpPath, "utf-8")) as {
			capturedAt?: number;
			accountId?: unknown;
			payload?: unknown;
		};
		const capturedAt = typeof parsed.capturedAt === "number" ? parsed.capturedAt : statSync(dumpPath).mtimeMs;
		const snapshot = parseClaudeStatusLinePayload(parsed.payload, capturedAt);
		if (!snapshot) return null;
		const dumpAccountId =
			parsed.accountId === null ? null : typeof parsed.accountId === "string" && parsed.accountId.trim() ? parsed.accountId : undefined;
		const resolvedAccountId = accountId !== undefined ? accountId : dumpAccountId;
		return resolvedAccountId === undefined ? snapshot : { ...snapshot, accountId: resolvedAccountId };
	} catch {
		return null; // torn write or corrupt file — keep whatever we knew before
	}
}

function codexHomeRoot(): string {
	return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function codexSessionsRoot(): string {
	return join(codexHomeRoot(), "sessions");
}

interface CodexSessionRoot {
	home: string;
	sessions: string;
	accountId: string | null;
}

/** Every codex session root to scan: the system login (~/.codex or $CODEX_HOME)
 *  plus each managed account's per-account CODEX_HOME — per-launch account
 *  injection scatters rollouts across those, so a single root would miss the
 *  latest session whenever it ran under a non-default account. */
function codexSessionRoots(): CodexSessionRoot[] {
	const managed = listCodexAccountDirs().map((home) => ({ home, sessions: join(home, "sessions"), accountId: basename(home) }));
	const systemHome = codexHomeRoot();
	const system = managed.find((root) => root.home === systemHome) ?? { home: systemHome, sessions: join(systemHome, "sessions"), accountId: null };
	const roots = [system];
	for (const root of managed) {
		if (!roots.some((existing) => existing.home === root.home)) roots.push(root);
	}
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
export function readCodexSnapshot(root?: string, accountId?: string | null): AgentRateLimitSnapshot | null {
	try {
		const roots = root !== undefined ? [{ sessions: root, accountId }] : codexSessionRoots();
		let best: { path: string; mtimeMs: number; accountId?: string | null } | null = null;
		for (const r of roots) {
			const rollout = findLatestCodexRollout(r.sessions);
			if (!rollout) continue;
			try {
				const mtimeMs = statSync(rollout).mtimeMs;
				if (!best || mtimeMs > best.mtimeMs) best = { path: rollout, mtimeMs, accountId: r.accountId };
			} catch {
				// file vanished mid-scan
			}
		}
		if (!best) return null;
		const snapshot = extractCodexSnapshotFromRolloutLines(readTailLines(best.path, CODEX_TAIL_BYTES));
		if (!snapshot || best.accountId === undefined) return snapshot;
		return { ...snapshot, accountId: best.accountId };
	} catch (err) {
		log.warn("Codex rollout scan failed", { error: String(err) });
		return null;
	}
}

async function readCodexLiveSnapshot(root: CodexSessionRoot, now: number): Promise<AgentRateLimitSnapshot | null> {
	const key = root.accountId ?? "system";
	const attemptedAt = codexLiveAttemptedAt.get(key) ?? 0;
	if (now - attemptedAt < CODEX_LIVE_REFRESH_MS) return cachedCodexLiveSnapshots.get(key) ?? null;
	const existingRequest = codexLiveRequests.get(key);
	if (existingRequest) return existingRequest;
	codexLiveAttemptedAt.set(key, now);
	const request = fetchCodexRateLimitSnapshot(undefined, undefined, now, { CODEX_HOME: root.home })
		.then((snapshot) => {
			if (snapshot) cachedCodexLiveSnapshots.set(key, { ...snapshot, accountId: root.accountId });
			return cachedCodexLiveSnapshots.get(key) ?? null;
		})
		.finally(() => {
			codexLiveRequests.delete(key);
		});
	codexLiveRequests.set(key, request);
	return request;
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
	const now = Date.now();
	if (!(await trackingEnabled())) {
		return { snapshots: [], generatedAt: now };
	}
	const byAccount = new Map<string, AgentRateLimitSnapshot>();
	const knownClaudeAccountIds = new Set(listClaudeAccountDirs().map((dir) => basename(dir)));
	const addSnapshot = (snapshot: AgentRateLimitSnapshot | null): void => {
		if (!snapshot || !isRateLimitSnapshotRecent(snapshot, now)) return;
		if (snapshot.source === "claude" && snapshot.accountId && !knownClaudeAccountIds.has(snapshot.accountId)) return;
		const key = `${snapshot.source}:${snapshot.accountId ?? "system"}`;
		const existing = byAccount.get(key);
		if (!existing || rateLimitActivityAt(snapshot) > rateLimitActivityAt(existing) || snapshot.capturedAt > existing.capturedAt) {
			byAccount.set(key, snapshot);
		}
	};

	// Claude's statusline wrapper writes one legacy/system dump and one additive
	// dump per managed account. The account id in the wrapper is the only source
	// that can distinguish concurrent Claude sessions, so never collapse these to
	// the active/default registry account.
	addSnapshot(readClaudeSnapshot());
	for (const dir of listClaudeAccountDirs()) {
		const accountId = basename(dir);
		addSnapshot(readClaudeSnapshot(join(CLAUDE_ACCOUNT_RATE_LIMITS_DIR, `${accountId}.json`), accountId));
	}

	// Codex sessions are naturally partitioned by CODEX_HOME. Enrich only roots
	// with a rollout written in the activity window; querying app-server itself
	// must not make an idle account look active.
	for (const root of codexSessionRoots()) {
		const latestRollout = findLatestCodexRollout(root.sessions);
		if (!latestRollout) continue;
		let rolloutMtime = 0;
		try {
			rolloutMtime = statSync(latestRollout).mtimeMs;
		} catch {
			continue;
		}
		if (rolloutMtime < now - RATE_LIMIT_ACTIVITY_WINDOW_MS) continue;
		const rollout = readCodexSnapshot(root.sessions, root.accountId);
		const live = await readCodexLiveSnapshot(root, now);
		const combined = mergeCodexRateLimitSnapshots(rollout, live);
		if (combined) {
			const parsedActivityAt = rollout ? rateLimitActivityAt(rollout) : 0;
			combined.activeAt = Math.max(Number.isFinite(parsedActivityAt) ? parsedActivityAt : 0, rolloutMtime);
			addSnapshot(combined);
		}
	}

	const snapshots = [...byAccount.values()].sort(
		(a, b) => (a.source === b.source ? 0 : a.source === "claude" ? -1 : 1) || rateLimitActivityAt(b) - rateLimitActivityAt(a),
	);
	const report: AgentRateLimitsReport = { snapshots, generatedAt: now };
	cachedReport = report;
	return report;
}

/** Change-detection key: pushes happen only when the meaningful bits move. */
function reportKey(report: AgentRateLimitsReport): string {
	return report.snapshots
		.map(
			(s) =>
				`${s.source}:${s.accountId ?? "system"}:${s.capturedAt}:${s.activeAt ?? ""}:${s.windows.map((w) => `${w.id}=${w.usedPercent}@${w.resetsAt}`).join(",")}:${s.creditsBalance}:${s.monthlyCredits ? `${s.monthlyCredits.used}/${s.monthlyCredits.limit}@${s.monthlyCredits.resetsAt}` : ""}`,
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
	cachedCodexLiveSnapshots.clear();
	codexLiveAttemptedAt.clear();
	codexLiveRequests.clear();
}

/** Last computed report (may be null before the first poll/RPC). */
export function getCachedRateLimitsReport(): AgentRateLimitsReport | null {
	return cachedReport;
}
