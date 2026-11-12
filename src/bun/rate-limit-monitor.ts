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
 * - Kimi Code: an opt-in, cached request to the user's own provider base URL
 *   (`/v1/usages`) with that provider's catalog key.
 *
 * Also owns the static `--settings` file injected into Claude launches, which
 * routes the session's statusLine through `dev3 statusline`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport } from "../shared/rate-limits";
import {
	RATE_LIMIT_ACTIVITY_WINDOW_MS,
	extractCodexSnapshotFromRolloutLines,
	isRateLimitSnapshotRecent,
	mergeCodexRateLimitSnapshots,
	parseClaudeStatusLinePayload,
	kimiUsageUrl,
	parseKimiUsage,
	rateLimitActivityAt,
	rateLimitLoginKey,
} from "../shared/rate-limits";
import type { AgentSessionStats } from "../shared/session-stats";
import { SESSION_STATS_RECENT_MS, parseClaudeSessionStats } from "../shared/session-stats";
import { fetchCodexRateLimitSnapshot } from "./codex-rate-limits";
import { providerDisplayName, type CatalogProvider } from "../shared/model-catalog";
import { loadModelCatalog, loadProviderKeys } from "./model-catalog-store";
import { loadProjects, loadTasks, loadVirtualProjects } from "./data";
import { TERMINAL_STATUSES, getTaskTitle } from "../shared/types";
import type { Project, Task, TaskStatus } from "../shared/types";
import { listClaudeAccountDirs, listCodexAccountDirs } from "./agent-accounts";
import { managedClaudeAccountIdForConfigDir } from "../shared/claude-config-dir";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";
import { loadSettings } from "./settings";

const log = createLogger("rate-limit-monitor");
const POLL_INTERVAL_MS = 30_000;
/** Avoid spawning app-server and hitting the account endpoint every poll. */
const CODEX_LIVE_REFRESH_MS = 5 * 60_000;
/** One usage request per Kimi provider per interval, success or not. */
const KIMI_USAGE_REFRESH_MS = 5 * 60_000;
const KIMI_USAGE_TIMEOUT_MS = 10_000;
/** How much of a rollout file tail to scan for the last rate_limits event. */
const CODEX_TAIL_BYTES = 256 * 1024;
/** How many most-recent day directories to consider when locating the live rollout. */
const CODEX_DAY_DIRS_TO_SCAN = 3;

export const RATE_LIMITS_DIR = join(DEV3_HOME, "data", "rate-limits");
export const CLAUDE_RATE_LIMIT_DUMP_PATH = join(RATE_LIMITS_DIR, "claude.json");
/** Per-managed-account Claude dumps. The legacy global dump remains the system
 * login fallback and is also written for compatibility with older builds. */
export const CLAUDE_ACCOUNT_RATE_LIMITS_DIR = join(RATE_LIMITS_DIR, "claude");
/** One dump per project-pinned `CLAUDE_CONFIG_DIR`, named by a hash of the dir;
 *  the dir itself is stored inside each dump. */
export const CLAUDE_CONFIG_DIR_RATE_LIMITS_DIR = join(RATE_LIMITS_DIR, "claude-config-dirs");
/** Per-task Claude session dumps, written by `dev3 statusline` inside a dev3 task. */
export const CLAUDE_SESSION_STATS_DIR = join(RATE_LIMITS_DIR, "sessions");
/** The dev3-managed settings file injected via `claude --settings <path>`. It
 * always suppresses the one-time bypass-permission confirmation and optionally
 * routes statusLine through `dev3 statusline` (see buildClaudeManagedSettings). */
export const CLAUDE_STATUSLINE_SETTINGS_PATH = join(RATE_LIMITS_DIR, "claude-statusline-settings.json");
/** The same file plus `awsAuthRefresh`, for launches that inject a picked AWS
 *  profile. A separate path, so the shared file never flips between launches. */
export const CLAUDE_BEDROCK_SSO_SETTINGS_PATH = join(RATE_LIMITS_DIR, "claude-bedrock-sso-settings.json");
/** Claude runs this when Bedrock credentials fail. It reads the AWS_PROFILE the
 *  launch injected, so one command serves every profile. */
export const AWS_SSO_REFRESH_COMMAND = "aws sso login";

type PushMessageFn = (name: string, payload: unknown) => void;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pushMessageFn: PushMessageFn | null = null;
let lastPushedKey = "";
let cachedReport: AgentRateLimitsReport | null = null;
const cachedCodexLiveSnapshots = new Map<string, AgentRateLimitSnapshot>();
const codexLiveAttemptedAt = new Map<string, number>();
const codexLiveRequests = new Map<string, Promise<AgentRateLimitSnapshot | null>>();
const cachedKimiSnapshots = new Map<string, AgentRateLimitSnapshot>();
const kimiAttemptedAt = new Map<string, number>();
const kimiRequests = new Map<string, Promise<void>>();
/** Hash of a provider's base URL + key: a change drops its cached reading. */
const kimiConfigStamps = new Map<string, string>();
/** `<providerId>:<failure kind>` pairs already logged, so a dead endpoint warns once. */
const kimiWarned = new Set<string>();

/**
 * Build the dev3-managed Claude settings object injected via `claude --settings`.
 * `skipDangerousModePermissionPrompt` is ALWAYS present: dev3 launches every
 * Claude session with a dangerous-bypass flag available (`--allow-dangerously-
 * skip-permissions` or a preset's `--dangerously-skip-permissions`), which would
 * otherwise trigger a one-time confirmation prompt on startup. When rate-limit
 * tracking is on, statusLine is also routed through `dev3 statusline`. With
 * `awsSsoRefresh`, an expired AWS SSO session opens the browser login itself.
 */
export function buildClaudeManagedSettings(dev3Bin: string, includeStatusLine: boolean, awsSsoRefresh = false): Record<string, unknown> {
	const settings: Record<string, unknown> = { skipDangerousModePermissionPrompt: true };
	if (includeStatusLine) {
		settings.statusLine = { type: "command", command: `"${dev3Bin}" statusline` };
	}
	if (awsSsoRefresh) settings.awsAuthRefresh = AWS_SSO_REFRESH_COMMAND;
	return settings;
}

/**
 * Write (once) the dev3-managed Claude settings file and return its path. Always
 * carries skipDangerousModePermissionPrompt; includes the statusLine wrapper only
 * when rate-limit tracking is on, and `awsAuthRefresh` (in its own file) when
 * `awsSsoRefresh`. Returns null when writing fails — callers then simply skip
 * `--settings` injection.
 */
export function ensureClaudeStatusLineSettings(includeStatusLine = true, awsSsoRefresh = false): string | null {
	const path = awsSsoRefresh ? CLAUDE_BEDROCK_SSO_SETTINGS_PATH : CLAUDE_STATUSLINE_SETTINGS_PATH;
	try {
		mkdirSync(RATE_LIMITS_DIR, { recursive: true });
		const dev3Bin = join(homedir(), ".dev3.0", "bin", "dev3");
		const desired = JSON.stringify(buildClaudeManagedSettings(dev3Bin, includeStatusLine, awsSsoRefresh));
		let current = "";
		try {
			current = readFileSync(path, "utf-8");
		} catch {
			// missing — will write below
		}
		if (current !== desired) writeFileSync(path, desired);
		return path;
	} catch (err) {
		log.warn("Failed to write claude managed settings file", { error: String(err) });
		return null;
	}
}

function listJsonFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

/** Parse the dump written by `dev3 statusline`. Null when absent/corrupt. */
export function readClaudeSnapshot(dumpPath: string = CLAUDE_RATE_LIMIT_DUMP_PATH, accountId?: string | null): AgentRateLimitSnapshot | null {
	try {
		if (!existsSync(dumpPath)) return null;
		const parsed = JSON.parse(readFileSync(dumpPath, "utf-8")) as {
			capturedAt?: number;
			accountId?: unknown;
			configDir?: unknown;
			payload?: unknown;
		};
		const capturedAt = typeof parsed.capturedAt === "number" ? parsed.capturedAt : statSync(dumpPath).mtimeMs;
		const snapshot = parseClaudeStatusLinePayload(parsed.payload, capturedAt);
		if (!snapshot) return null;
		const dumpAccountId =
			parsed.accountId === null ? null : typeof parsed.accountId === "string" && parsed.accountId.trim() ? parsed.accountId : undefined;
		const resolvedAccountId = accountId !== undefined ? accountId : dumpAccountId;
		const attributed = resolvedAccountId === undefined ? snapshot : { ...snapshot, accountId: resolvedAccountId };
		const configDir = typeof parsed.configDir === "string" && parsed.configDir.trim() ? parsed.configDir : null;
		return configDir && !resolvedAccountId ? { ...attributed, configDir } : attributed;
	} catch {
		return null; // torn write or corrupt file — keep whatever we knew before
	}
}

/** Drop a task's session dump once its agent exits: the file outlives the process by
 *  up to SESSION_STATS_RECENT_MS, and the card would keep reporting a session that is gone. */
export function forgetClaudeSessionDump(taskId: string, dir: string = CLAUDE_SESSION_STATS_DIR): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) return;
	try {
		rmSync(join(dir, `${taskId}.json`), { force: true });
	} catch {
		// the next statusLine render rewrites it anyway
	}
}

/** Parse every per-task session dump captured within SESSION_STATS_RECENT_MS, newest first. */
export function readClaudeSessionDumps(dir: string = CLAUDE_SESSION_STATS_DIR, now: number = Date.now()): AgentSessionStats[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const sessions: AgentSessionStats[] = [];
	for (const file of files) {
		const path = join(dir, file);
		try {
			if (statSync(path).mtimeMs < now - SESSION_STATS_RECENT_MS) continue;
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
				capturedAt?: unknown;
				accountId?: unknown;
				configDir?: unknown;
				payload?: unknown;
			};
			const capturedAt = typeof parsed.capturedAt === "number" ? parsed.capturedAt : statSync(path).mtimeMs;
			if (capturedAt < now - SESSION_STATS_RECENT_MS) continue;
			const stats = parseClaudeSessionStats(parsed.payload, basename(file, ".json"), capturedAt);
			if (!stats) continue;
			// The envelope, not the payload, names the login that wrote it (dumpPayload in statusline.ts).
			if (typeof parsed.accountId === "string" && parsed.accountId) stats.accountId = parsed.accountId;
			if (typeof parsed.configDir === "string" && parsed.configDir) stats.configDir = parsed.configDir;
			sessions.push(stats);
		} catch {
			// torn write or corrupt dump - skip it this round
		}
	}
	return sessions.sort((a, b) => b.capturedAt - a.capturedAt);
}

/** Statuses in which the task waits on the user, so an expiring cache is theirs to save. */
const AWAITING_USER_STATUSES: readonly TaskStatus[] = ["user-questions", "review-by-user"];

/** Attach board identity and drop sessions whose task is gone or finished. No cap:
 *  the Sessions screen lists them all, and the panel's attention strip bounds itself. */
export async function attachTaskIdentity(
	sessions: AgentSessionStats[],
	load: { projects: () => Promise<Project[]>; tasks: (project: Project) => Promise<Task[]> } = {
		projects: async () => [...(await loadProjects()), ...(await loadVirtualProjects())],
		tasks: loadTasks,
	},
): Promise<AgentSessionStats[]> {
	if (sessions.length === 0) return [];
	const wanted = new Set(sessions.map((s) => s.taskId));
	const found = new Map<
		string,
		{ title: string; seq: number; projectName: string; projectId: string; awaitingUser: boolean }
	>();
	let projects: Project[];
	try {
		projects = await load.projects();
	} catch (err) {
		log.warn("Session stats project lookup failed", { error: String(err) });
		return [];
	}
	for (const project of projects) {
		if (found.size === wanted.size) break;
		try {
			for (const task of await load.tasks(project)) {
				if (!wanted.has(task.id) || TERMINAL_STATUSES.includes(task.status)) continue;
				found.set(task.id, {
					title: getTaskTitle(task),
					seq: task.seq,
					projectName: project.name,
					projectId: project.id,
					awaitingUser: AWAITING_USER_STATUSES.includes(task.status),
				});
			}
		} catch (err) {
			// One unreadable board must not hide every other project's sessions.
			log.warn("Session stats task lookup failed", { projectId: project.id, error: String(err) });
		}
	}
	const out: AgentSessionStats[] = [];
	for (const s of sessions) {
		const task = found.get(s.taskId);
		if (!task) continue;
		out.push({
			...s,
			taskTitle: task.title,
			taskSeq: task.seq,
			projectName: task.projectName,
			projectId: task.projectId,
			awaitingUser: task.awaitingUser,
		});
	}
	return out;
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

function warnKimiOnce(providerId: string, kind: string, extra: Record<string, unknown> = {}): void {
	const marker = `${providerId}:${kind}`;
	if (kimiWarned.has(marker)) return;
	kimiWarned.add(marker);
	log.warn("Kimi usage read failed", { providerId, kind, ...extra });
}

const KIMI_FAILURE_KINDS = ["http", "parse", "request"];

function kimiConfigStamp(provider: CatalogProvider, apiKey: string): string {
	return createHash("sha256").update(`${provider.baseUrl?.trim()}\n${apiKey}`).digest("hex");
}

function forgetKimiProvider(id: string): void {
	cachedKimiSnapshots.delete(id);
	kimiAttemptedAt.delete(id);
	kimiRequests.delete(id);
	kimiConfigStamps.delete(id);
	for (const kind of KIMI_FAILURE_KINDS) kimiWarned.delete(`${id}:${kind}`);
}

async function requestKimiUsage(provider: CatalogProvider, apiKey: string, now: number): Promise<AgentRateLimitSnapshot | null> {
	try {
		const url = kimiUsageUrl(provider.baseUrl!);
		if (!url) throw new TypeError("invalid base URL");
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			redirect: "error",
			signal: AbortSignal.timeout(KIMI_USAGE_TIMEOUT_MS),
		});
		if (!res.ok) {
			// A revoked key must not keep showing an old reading; other failures keep the last good one.
			const sameConfig = kimiConfigStamps.get(provider.id) === kimiConfigStamp(provider, apiKey);
			if ((res.status === 401 || res.status === 403) && sameConfig) cachedKimiSnapshots.delete(provider.id);
			warnKimiOnce(provider.id, "http", { status: res.status });
			return null;
		}
		// A 200 that is not JSON is a parse failure, not a failed request.
		const body: unknown = await res.json().catch(() => null);
		const snapshot = body === null ? null : parseKimiUsage(body, now);
		if (!snapshot) {
			warnKimiOnce(provider.id, "parse");
			return null;
		}
		for (const kind of KIMI_FAILURE_KINDS) kimiWarned.delete(`${provider.id}:${kind}`);
		return { ...snapshot, providerId: provider.id };
	} catch (err) {
		// Only the error's name: its message can carry the request URL.
		warnKimiOnce(provider.id, "request", { error: err instanceof Error ? err.name : "unknown" });
		return null;
	}
}

/** Starts a refresh when one is due; never waits for it — the fresh reading
 *  lands in the cache and reaches the next poll's report. */
function refreshKimiUsage(provider: CatalogProvider, apiKey: string, now: number): void {
	const id = provider.id;
	const stamp = kimiConfigStamp(provider, apiKey);
	if (kimiConfigStamps.get(id) !== stamp) {
		forgetKimiProvider(id);
		kimiConfigStamps.set(id, stamp);
	}
	if (now - (kimiAttemptedAt.get(id) ?? 0) < KIMI_USAGE_REFRESH_MS || kimiRequests.has(id)) return;
	kimiAttemptedAt.set(id, now);
	const request = requestKimiUsage(provider, apiKey, now)
		.then((snapshot) => {
			// A config change while this was in flight made the result stale.
			if (snapshot && kimiConfigStamps.get(id) === stamp) cachedKimiSnapshots.set(id, snapshot);
		})
		.finally(() => {
			if (kimiRequests.get(id) === request) kimiRequests.delete(id);
		});
	kimiRequests.set(id, request);
}

async function trackingEnabled(): Promise<boolean> {
	try {
		const settings = await loadSettings();
		return settings.agentRateLimitTracking !== false;
	} catch {
		return true;
	}
}

/** A config-dir dump that names a managed account's own dir is that account's
 *  quota (an older `dev3 statusline` wrote those as plain pins). */
export function attributeManagedConfigDir(snapshot: AgentRateLimitSnapshot, dev3Home: string = DEV3_HOME): AgentRateLimitSnapshot {
	const accountId = snapshot.configDir ? managedClaudeAccountIdForConfigDir(snapshot.configDir, dev3Home) : null;
	if (!accountId) return snapshot;
	const { configDir: _configDir, ...rest } = snapshot;
	return { ...rest, accountId };
}

const SOURCE_ORDER: Record<AgentRateLimitSnapshot["source"], number> = { claude: 0, codex: 1, kimi: 2 };

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
		const key = rateLimitLoginKey(snapshot);
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
	for (const name of listJsonFiles(CLAUDE_CONFIG_DIR_RATE_LIMITS_DIR)) {
		const snapshot = readClaudeSnapshot(join(CLAUDE_CONFIG_DIR_RATE_LIMITS_DIR, name), null);
		if (snapshot?.configDir) addSnapshot(attributeManagedConfigDir(snapshot));
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

	const usageProviders = loadModelCatalog().providers.filter(
		(p) => p.kind === "custom" && p.usageSource === "kimi-code" && p.baseUrl?.trim(),
	);
	const keys = usageProviders.length > 0 ? loadProviderKeys() : {};
	const tracked = usageProviders.filter((p) => keys[p.id]?.trim());
	for (const id of kimiConfigStamps.keys()) {
		if (!tracked.some((p) => p.id === id)) forgetKimiProvider(id);
	}
	for (const p of tracked) {
		refreshKimiUsage(p, keys[p.id].trim(), now);
		addSnapshot(cachedKimiSnapshots.get(p.id) ?? null);
	}

	const snapshots = [...byAccount.values()].sort(
		(a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || rateLimitActivityAt(b) - rateLimitActivityAt(a),
	);
	const sessions = await attachTaskIdentity(readClaudeSessionDumps(CLAUDE_SESSION_STATS_DIR, now));
	const report: AgentRateLimitsReport = {
		snapshots,
		sessions,
		usageProviders: usageProviders.map((p) => ({
			id: p.id,
			label: providerDisplayName(p),
			source: "kimi-code",
			...(keys[p.id]?.trim() ? {} : { missingKey: true }),
		})),
		generatedAt: now,
	};
	cachedReport = report;
	return report;
}

/** Change-detection key: pushes happen only when the meaningful bits move. */
function reportKey(report: AgentRateLimitsReport): string {
	return report.snapshots
		.map(
			(s) =>
				`${rateLimitLoginKey(s)}:${s.capturedAt}:${s.activeAt ?? ""}:${s.windows.map((w) => `${w.id}=${w.usedPercent}@${w.resetsAt}`).join(",")}:${s.creditsBalance}:${s.monthlyCredits ? `${s.monthlyCredits.used}/${s.monthlyCredits.limit}@${s.monthlyCredits.resetsAt}` : ""}:${s.spendLimit ? `${s.spendLimit.usedUsd}/${s.spendLimit.limitUsd}/${s.spendLimit.period}` : ""}`,
		)
		.join("|")
		.concat(
			"@",
			(report.usageProviders ?? []).map((p) => `${p.id}:${p.label}:${p.missingKey ?? ""}`).join("|"),
			"#",
			(report.sessions ?? [])
				.map((s) => `${s.taskId}:${s.projectId}:${s.capturedAt}:${s.taskTitle}:${s.awaitingUser}:${s.cache?.warm}:${s.cache?.expiresAt}`)
				.join("|"),
		);
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
	cachedKimiSnapshots.clear();
	kimiAttemptedAt.clear();
	kimiRequests.clear();
	kimiConfigStamps.clear();
	kimiWarned.clear();
}

/** Last computed report (may be null before the first poll/RPC). */
export function getCachedRateLimitsReport(): AgentRateLimitsReport | null {
	return cachedReport;
}
