import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { TERMINAL_STATUSES, type AgentUsageReport, type AgentUsageSource, type Project, type SystemLoadSnapshot, type SystemMemorySnapshot, type Task, type TaskUsageReport, type WorktreeOrphanGroup } from "../../shared/types";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import { getAgentRateLimitsReport } from "../rate-limit-monitor";
import { getBusyTaskShortIds, getSystemLoadSnapshot, getSystemMemorySnapshot, resolveTaskConsumers } from "../resource-monitor";
import { scanWorktreeDiskUsage } from "../worktree-disk-usage";
import { killPids, scanWorktreeOrphans as scanOrphans } from "../worktree-reaper";
import { nativeModelIdForWireName } from "../../shared/model-catalog";
import { loadModelCatalog } from "../model-catalog-store";
import { listAgentDirAccountDirs, listClaudeAccountDirs, listCodexAccountDirs } from "../agent-accounts";
import { retainUsageHistory, usageHistoryStamp } from "../agent-usage-history";
import { getPricingResolver } from "../agent-pricing-refresh";
import { DEV3_HOME } from "../paths";
import { resolveCopilotHome } from "../copilot-config";
import { collectGeminiUsage } from "../usage-collectors/gemini";
import { collectCursorUsage } from "../usage-collectors/cursor";
import { collectCopilotUsage } from "../usage-collectors/copilot";
import { collectOpenCodeUsage, openCodeDatabases } from "../usage-collectors/opencode";
import { collectPiUsage, piSessionRoots } from "../usage-collectors/pi";
import { queryReadonlySqlite } from "../sqlite-readonly";
import { claudeStoreDir, codexRolloutCwd } from "../conversation-search";
import { toPosixSeparators } from "../../shared/project-storage-key";
import { conversationDumpDir } from "../conversation-parse";
import { taskWorkingDir } from "../task-conversation";
import { taskDir } from "../git";
import { beginCodexRollout, finalizeUsage, foldClaudeEntry, foldCodexEntry, newUsageState, summarizeUsageByModel, type UsageState } from "./agent-usage-parse";
import { log } from "./shared";

/**
 * Agent usage (tokens + API-equivalent cost) reconstructed from LOCAL on-disk
 * agent state. Covers Claude, Codex, Gemini, Cursor hooks, Copilot, OpenCode, pi and omp.
 * Usage stays local; public pricing refreshes independently of the raw records.
 */

/** Root of Claude Code's projects dir, honouring CLAUDE_CONFIG_DIR (used by the account switcher). */
function claudeProjectsDir(): string {
	const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return join(base, "projects");
}

/** Root of Codex state, honouring CODEX_HOME. */
function codexHome(): string {
	return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** Recursively collect every *.jsonl transcript under the projects dir. Never throws. */
function collectTranscriptFiles(dir: string, out: string[], codex = false): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // missing / unreadable dir → graceful absence
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectTranscriptFiles(full, out, codex);
		else if (entry.isFile() && entry.name.endsWith(".jsonl") && (!codex || entry.name.startsWith("rollout-"))) out.push(full);
	}
}

/** Parse in short slices so socket and RPC calls keep answering during a multi-GB scan. */
const SCAN_SLICE_MS = 20;
let sliceStartedAt = performance.now();

async function yieldToEventLoop(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	sliceStartedAt = performance.now();
}

async function foldJsonlFiles(
	files: string[],
	state: UsageState,
	fold: (state: UsageState, entry: unknown) => void,
	beforeFile?: (state: UsageState) => void,
): Promise<void> {
	for (const file of files) {
		beforeFile?.(state);
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch (err) {
			log.warn("getAgentUsage: read failed (skipped)", { file, error: String(err) });
			continue;
		}
		for (let start = 0; start <= text.length;) {
			const newline = text.indexOf("\n", start);
			const end = newline === -1 ? text.length : newline;
			const trimmed = text.slice(start, end).trim();
			start = end + 1;
			if (trimmed) {
				try {
					fold(state, JSON.parse(trimmed));
				} catch {
					// tolerate a truncated / partially-written last line
				}
			}
			if (performance.now() - sliceStartedAt >= SCAN_SLICE_MS) await yieldToEventLoop();
		}
	}
}

/**
 * Transcripts whose records are already merged into the usage history, as
 * path → size:mtime. Every record ever seen is retained there, so an unchanged
 * file adds nothing on a repeat scan. Valid only while the history file is the
 * one this process last saw: a rewrite by another app version, or a removal,
 * drops the whole map. Bounded by the transcripts on disk; a full scan prunes it.
 */
const foldedTranscripts = new Map<string, string>();
let foldedHistoryStamp: string | null = null;

/** Stamps every candidate it keeps in `seen`; returns only those not yet in the history. */
function transcriptsToRead(files: string[], notBefore: number, seen: Map<string, string>): string[] {
	return files.filter((file) => {
		let stat: import("node:fs").Stats;
		try { stat = statSync(file); } catch { return false; }
		// A transcript is only ever appended to, so its records are no newer than its mtime.
		if (stat.mtimeMs < notBefore) return false;
		const stamp = `${stat.size}:${stat.mtimeMs}`;
		seen.set(file, stamp);
		return foldedTranscripts.get(file) !== stamp;
	});
}

/** Local midnight of `since`'s day: the CLI keeps every day that overlaps the window, whole. */
function windowStart(since: string | undefined): number {
	const at = since === undefined ? NaN : Date.parse(since);
	if (!Number.isFinite(at)) return -Infinity;
	const day = new Date(at);
	return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

const usageScans = new Map<number, Promise<AgentUsageReport>>();

/**
 * Daily usage across every agent. With `since`, transcripts last written before
 * that day are not read, so days before it may be incomplete. A caller retrying
 * while the same window is still scanning joins that scan.
 */
export function getAgentUsage(params?: { since?: string } | void): Promise<AgentUsageReport> {
	const notBefore = windowStart(params ? params.since : undefined);
	let scan = usageScans.get(notBefore);
	if (!scan) {
		scan = scanAgentUsage(notBefore).finally(() => usageScans.delete(notBefore));
		usageScans.set(notBefore, scan);
	}
	return scan;
}

async function scanAgentUsage(notBefore: number): Promise<AgentUsageReport> {
	if (usageHistoryStamp() !== foldedHistoryStamp) foldedTranscripts.clear();
	const seen = new Map<string, string>();
	const claudeState = newUsageState();
	const claudeFiles: string[] = [];
	// A managed account's store is often a symlink onto the home one; read it once.
	for (const dir of uniqueRealDirs(claudeProjectRoots())) collectTranscriptFiles(dir, claudeFiles);
	const claudeToRead = transcriptsToRead(claudeFiles, notBefore, seen);
	await foldJsonlFiles(claudeToRead, claudeState, foldClaudeEntry);

	const codexState = newUsageState();
	const codexFiles: string[] = [];
	const codexStores = [...new Set([codexHome(), ...listCodexAccountDirs()])].flatMap((home) => [join(home, "sessions"), join(home, "archived_sessions")]);
	for (const store of uniqueRealDirs(codexStores)) collectTranscriptFiles(store, codexFiles, true);
	const codexToRead = transcriptsToRead(codexFiles, notBefore, seen);
	await foldJsonlFiles(codexToRead, codexState, foldCodexEntry, beginCodexRollout);
	const states = {
		claude: claudeState, codex: codexState,
		gemini: newUsageState(), cursor: newUsageState(), copilot: newUsageState(),
		opencode: newUsageState(), pi: newUsageState(), omp: newUsageState(),
	};
	const collectors = [
		() => collectGeminiUsage(states.gemini, homedir()),
		() => collectCursorUsage(states.cursor, DEV3_HOME),
		() => collectCopilotUsage(states.copilot, resolveCopilotHome()),
		() => collectOpenCodeUsage(states.opencode, openCodeDatabases(homedir()), queryReadonlySqlite,
			(db, error) => log.warn("OpenCode usage store unreadable (skipped)", { db, error: String(error) })),
		() => collectPiUsage(states.pi, "pi", piSessionRoots("pi", homedir(), listAgentDirAccountDirs("pi"))),
		() => collectPiUsage(states.omp, "omp", piSessionRoots("omp", homedir(), listAgentDirAccountDirs("omp"))),
	];
	for (const collect of collectors) {
		try { collect(); }
		catch (error) { log.warn("Agent usage source unavailable", { error: String(error) }); }
	}

	// A routed session's transcript names the catalog wire name, which the rate
	// table has never heard of; price it as the provider's own model instead.
	const catalog = loadModelCatalog();
	const pricingId = (model: string) => nativeModelIdForWireName(catalog, model) ?? model;
	for (const state of Object.values(states)) {
		for (const usage of state.records.values()) {
			const native = nativeModelIdForWireName(catalog, usage.model);
			if (native) usage.pricingModel = native;
		}
	}

	const retained = await retainUsageHistory(states);
	// Handed back unchanged when the history could not be read or written: nothing was kept, so nothing is cached.
	if (retained.claude !== claudeState && retained.codex !== codexState) {
		if (notBefore === -Infinity) foldedTranscripts.clear();
		for (const [file, stamp] of seen) foldedTranscripts.set(file, stamp);
		foldedHistoryStamp = usageHistoryStamp();
	}
	const resolveRate = await getPricingResolver();
	const reports = (Object.entries(retained) as [AgentUsageSource, UsageState][])
		.map(([source, state]) => finalizeUsage(state, source, pricingId, resolveRate));
	const days = reports.flatMap((report) => report.days).sort(
		(a, b) => a.startMs - b.startMs || a.source.localeCompare(b.source),
	);
	const hasUnpriced = reports.some((report) => report.hasUnpriced);
	log.info("getAgentUsage computed", {
		claudeFiles: claudeFiles.length,
		codexFiles: codexFiles.length,
		claudeRead: claudeToRead.length,
		codexRead: codexToRead.length,
		days: days.length,
		hasUnpriced,
	});
	const models = [...new Set(Object.values(retained).flatMap((state) => [...state.records.values()].map((r) => r.model)))].sort();
	return { days, generatedAt: new Date().toISOString(), hasUnpricedModels: hasUnpriced, models };
}

const SESSION_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ARCHIVE_SOURCES = new Set(["claude", "codex"]);

function sessionOf(path: string): string | undefined {
	return basename(path).match(SESSION_UUID)?.[0];
}

/** Separator-agnostic, so a Windows path is recognised too. */
export function isSubagentTranscript(path: string): boolean {
	return path.split(/[\\/]/).includes("subagents");
}

/** One entry per real directory: an account dir may be a symlink onto the home store. */
function uniqueRealDirs(dirs: string[]): string[] {
	const seen = new Map<string, string>();
	for (const dir of dirs) {
		let real: string;
		try { real = realpathSync(dir); } catch { continue; }
		if (!seen.has(real)) seen.set(real, dir);
	}
	return [...seen.values()];
}

/** A path as the agent recorded it: agents store the physical cwd, with forward slashes. */
function comparablePath(path: string): string {
	let resolved = path;
	try { resolved = realpathSync(path); } catch { /* removed worktree: the raw spelling it is */ }
	const posix = toPosixSeparators(resolved).replace(/\/+$/, "");
	return process.platform === "win32" ? posix.toLowerCase() : posix;
}

/** Both spellings a store may be keyed by: the stored path and its physical one. */
function workingDirSpellings(workingDir: string): string[] {
	let physical = workingDir;
	try { physical = realpathSync(workingDir); } catch { /* removed worktree */ }
	return [...new Set([workingDir, physical])];
}

function claudeProjectRoots(): string[] {
	return [claudeProjectsDir(), ...listClaudeAccountDirs().map((home) => join(home, "projects"))];
}

/** The task's Claude stores, from the same roots `getAgentUsage` reads. */
function taskClaudeFiles(workingDir: string): string[] {
	const dirs = claudeProjectRoots().flatMap((root) => workingDirSpellings(workingDir).map((dir) => claudeStoreDir(root, dir)));
	const files: string[] = [];
	for (const dir of uniqueRealDirs(dirs)) collectTranscriptFiles(dir, files);
	return files;
}

/** A rollout's header never changes, so its cwd is read once per app run. */
const rolloutCwdCache = new Map<string, string | null>();

function cachedRolloutCwd(file: string): string | null {
	if (!rolloutCwdCache.has(file)) {
		const cwd = codexRolloutCwd(file);
		rolloutCwdCache.set(file, cwd === null ? null : comparablePath(cwd));
	}
	return rolloutCwdCache.get(file) ?? null;
}

/** Every Codex rollout, from the same stores `getAgentUsage` reads. */
function allCodexRollouts(): string[] {
	const rollouts: string[] = [];
	for (const home of new Set([codexHome(), ...listCodexAccountDirs()])) {
		for (const store of ["sessions", "archived_sessions"]) collectTranscriptFiles(join(home, store), rollouts, true);
	}
	return rollouts;
}

/** Codex rollouts that ran in `workingDir`. Reads only each header. */
function taskCodexFiles(rollouts: string[], workingDir: string): string[] {
	const target = comparablePath(workingDir);
	return rollouts.filter((file) => cachedRolloutCwd(file) === target);
}

const PLAIN_SESSION_ID = new RegExp(`^${SESSION_UUID.source}$`, "i");

/** Session ids the task's panes recorded, including ones resumed from another folder. */
function paneSessionIds(task: Task): Set<string> {
	const ids = (task.sessionState?.panes ?? []).map((pane) => pane.sessionId);
	return new Set(ids.filter((id): id is string => !!id && PLAIN_SESSION_ID.test(id)));
}

/**
 * Transcripts of the task's panes that live outside its own stores: a conversation
 * resumed from another folder keeps appending to the file it began in.
 */
function resumedClaudeFiles(ids: Set<string>, own: Set<string>): string[] {
	const files: string[] = [];
	if (!ids.size) return files;
	for (const root of uniqueRealDirs(claudeProjectRoots())) {
		let stores: string[];
		try { stores = readdirSync(root); } catch { continue; }
		for (const store of stores) {
			for (const id of ids) {
				const main = join(root, store, `${id}.jsonl`);
				if (!existsSync(main)) continue;
				files.push(main);
				collectTranscriptFiles(join(root, store, id), files);
			}
		}
	}
	return files.filter((file) => !own.has(file));
}

function resumedCodexFiles(rollouts: string[], ids: Set<string>, own: Set<string>): string[] {
	return rollouts.filter((file) => !own.has(file) && ids.has(sessionOf(file)?.toLowerCase() ?? ""));
}

/**
 * Sessions dev3 archived at completion whose native transcript is gone (agent
 * retention). Their usage is not counted: the archive's totals sum every streaming
 * snapshot of a response, overstating tokens about twofold, so they are only reported.
 * Archived sessions of agents this report never reads are counted apart.
 */
function countArchivedSessions(project: Project, task: Task, liveFiles: string[]): { uncovered: number; unsupported: number } {
	let names: string[];
	try {
		names = readdirSync(conversationDumpDir(taskDir(project, task))).filter((name) => name.endsWith(".json"));
	} catch {
		return { uncovered: 0, unsupported: 0 };
	}
	const liveIds = new Set(liveFiles.map(sessionOf));
	let uncovered = 0;
	let unsupported = 0;
	for (const name of names) {
		if (!ARCHIVE_SOURCES.has(name.slice(0, name.indexOf("-")))) { unsupported++; continue; }
		const id = sessionOf(name);
		if (id ? !liveIds.has(id) : liveFiles.length === 0) uncovered++;
	}
	return { uncovered, unsupported };
}

/** When the task first left To Do; `createdAt` when it never sat there or that move was evicted. */
export function taskStartedAt(task: Task): number {
	const created = Date.parse(task.createdAt);
	const movements = task.movements ?? [];
	if (task.movementsDropped || movements.some((m) => m.kind === "created" && m.to !== "todo")) return created;
	const launch = movements.find((m) => m.from === "todo" && m.to !== "todo");
	const at = launch ? Date.parse(launch.at) : NaN;
	return Number.isFinite(at) ? at : created;
}

/**
 * An Operations task on a user-chosen folder shares it with whatever else ran
 * there, so only records inside the task's own lifetime count — from its launch,
 * not its creation, so days spent in To Do are not charged to it.
 */
function keepTaskLifetime(state: UsageState, task: Task): void {
	const start = taskStartedAt(task);
	const endedAt = TERMINAL_STATUSES.includes(task.status) ? Date.parse(task.statusEnteredAt ?? task.movedAt ?? "") : NaN;
	const end = Number.isFinite(endedAt) ? endedAt : Infinity;
	for (const [key, record] of state.records) {
		if (record.timestamp < start || record.timestamp > end) state.records.delete(key);
	}
}

/**
 * One task's usage: the Claude transcripts of its working directory (subagents
 * included) and the Codex rollouts that ran there, folded and priced exactly as
 * `getAgentUsage` folds and prices them. Transcripts are keyed by the path, so a
 * finished task whose worktree is gone still resolves.
 */
export async function getTaskAgentUsage(project: Project, task: Task): Promise<TaskUsageReport> {
	const workingDir = taskWorkingDir(project, task);
	const state = newUsageState();
	const ownClaude = taskClaudeFiles(workingDir);
	await foldJsonlFiles(ownClaude, state, foldClaudeEntry);
	const rollouts = allCodexRollouts();
	const ownCodex = taskCodexFiles(rollouts, workingDir);
	await foldJsonlFiles(ownCodex, state, foldCodexEntry, beginCodexRollout);
	const sharedWorkingDir = project.kind === "virtual" && !!task.opsWorkDir?.trim();
	if (sharedWorkingDir) keepTaskLifetime(state, task);

	// A resumed file also holds the conversation's earlier history, so only its records inside the task's lifetime count.
	const ids = paneSessionIds(task);
	const resumedClaude = resumedClaudeFiles(ids, new Set(ownClaude));
	const resumedCodex = resumedCodexFiles(rollouts, ids, new Set(ownCodex));
	const resumed = newUsageState();
	await foldJsonlFiles(resumedClaude, resumed, foldClaudeEntry);
	await foldJsonlFiles(resumedCodex, resumed, foldCodexEntry, beginCodexRollout);
	keepTaskLifetime(resumed, task);
	for (const [key, record] of resumed.records) if (!state.records.has(key)) state.records.set(key, record);
	const claudeFiles = [...ownClaude, ...resumedClaude];
	const codexFiles = [...ownCodex, ...resumedCodex];

	const catalog = loadModelCatalog();
	const pricingId = (model: string) => nativeModelIdForWireName(catalog, model) ?? model;
	const { totals, models, firstMs, lastMs } = summarizeUsageByModel(state, pricingId, await getPricingResolver());
	const sources: AgentUsageSource[] = [];
	if (claudeFiles.length) sources.push("claude");
	if (codexFiles.length) sources.push("codex");
	const archived = countArchivedSessions(project, task, [...claudeFiles, ...codexFiles]);
	return {
		taskId: task.id, projectId: project.id, seq: task.seq, title: task.title, status: task.status,
		workingDir, worktreeExists: existsSync(workingDir),
		totals, models,
		coverage: {
			transcriptFiles: claudeFiles.length + codexFiles.length,
			subagentTranscriptFiles: claudeFiles.filter(isSubagentTranscript).length,
			resumedTranscriptFiles: resumedClaude.length + resumedCodex.length,
			uncoveredArchivedSessions: archived.uncovered,
			unsupportedArchivedSessions: archived.unsupported,
			sharedWorkingDir,
			sources,
			firstAt: firstMs === null ? null : new Date(firstMs).toISOString(),
			lastAt: lastMs === null ? null : new Date(lastMs).toISOString(),
		},
	};
}

/** Current agent rate limits (local dumps/rollouts plus cached Codex monthly credits). */
async function getAgentRateLimits(): Promise<AgentRateLimitsReport> {
	return getAgentRateLimitsReport();
}

/**
 * Latest system-memory snapshot for the header widget's first render and the
 * launch-time banner. Null until the resource monitor's first tick completes;
 * live updates ride the `systemMemoryUpdated` push.
 */
async function getSystemMemory(): Promise<SystemMemorySnapshot | null> {
	return getSystemMemorySnapshot();
}

async function getSystemLoad(): Promise<SystemLoadSnapshot | null> {
	return getSystemLoadSnapshot();
}

/**
 * Leftover processes inside worktrees whose task is finished. Titles are resolved
 * here rather than in the reaper so the scanner stays free of data-layer imports.
 * A scan that cannot prove which tasks are busy reports nothing — never a list the
 * user might kill live work from.
 */
export async function scanWorktreeOrphans(): Promise<WorktreeOrphanGroup[]> {
	let groups: WorktreeOrphanGroup[];
	try {
		groups = await scanOrphans(await getBusyTaskShortIds());
	} catch {
		return [];
	}
	if (groups.length === 0) return [];
	const resolved = new Map(
		(await resolveTaskConsumers(groups.map((g) => ({ shortId: g.shortId, rss: g.rss }))))
			.map((task) => [task.shortId, task]),
	);
	return groups.map((group) => {
		const task = resolved.get(group.shortId);
		return task ? { ...group, taskId: task.taskId, title: task.title, projectId: task.projectId } : group;
	});
}

async function killWorktreeOrphans({ pids }: { pids: number[] }): Promise<{ killed: number; leftovers: number }> {
	const { killed, leftovers } = await killPids(pids);
	return { killed, leftovers: leftovers.length };
}

export const agentUsageHandlers = {
	getAgentUsage,
	getAgentRateLimits,
	getSystemMemory,
	getSystemLoad,
	scanWorktreeDiskUsage,
	scanWorktreeOrphans,
	killWorktreeOrphans,
};
