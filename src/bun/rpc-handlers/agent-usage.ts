import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentUsageReport, AgentUsageSource, SystemLoadSnapshot, SystemMemorySnapshot, WorktreeOrphanGroup } from "../../shared/types";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import { getAgentRateLimitsReport } from "../rate-limit-monitor";
import { getBusyTaskShortIds, getSystemLoadSnapshot, getSystemMemorySnapshot, resolveTaskConsumers } from "../resource-monitor";
import { scanWorktreeDiskUsage } from "../worktree-disk-usage";
import { killPids, scanWorktreeOrphans as scanOrphans } from "../worktree-reaper";
import { nativeModelIdForWireName } from "../../shared/model-catalog";
import { loadModelCatalog } from "../model-catalog-store";
import { listAgentDirAccountDirs, listClaudeAccountDirs, listCodexAccountDirs } from "../agent-accounts";
import { retainUsageHistory } from "../agent-usage-history";
import { getPricingResolver } from "../agent-pricing-refresh";
import { DEV3_HOME } from "../paths";
import { resolveCopilotHome } from "../copilot-config";
import { collectGeminiUsage } from "../usage-collectors/gemini";
import { collectCursorUsage } from "../usage-collectors/cursor";
import { collectCopilotUsage } from "../usage-collectors/copilot";
import { collectOpenCodeUsage, openCodeDatabases } from "../usage-collectors/opencode";
import { collectPiUsage, piSessionRoots } from "../usage-collectors/pi";
import { queryReadonlySqlite } from "../sqlite-readonly";
import { beginCodexRollout, finalizeUsage, foldClaudeEntry, foldCodexEntry, newUsageState, type UsageState } from "./agent-usage-parse";
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

function foldJsonlFiles(
	files: string[],
	state: UsageState,
	fold: (state: UsageState, entry: unknown) => void,
	beforeFile?: (state: UsageState) => void,
): void {
	for (const file of files) {
		beforeFile?.(state);
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (err) {
			log.warn("getAgentUsage: read failed (skipped)", { file, error: String(err) });
			continue;
		}
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				fold(state, JSON.parse(trimmed));
			} catch {
				// tolerate a truncated / partially-written last line
			}
		}
	}
}

export async function getAgentUsage(): Promise<AgentUsageReport> {
	const claudeState = newUsageState();
	const claudeFiles: string[] = [];
	for (const dir of new Set([claudeProjectsDir(), ...listClaudeAccountDirs().map((home) => join(home, "projects"))])) {
		collectTranscriptFiles(dir, claudeFiles);
	}
	foldJsonlFiles(claudeFiles, claudeState, foldClaudeEntry);

	const codexState = newUsageState();
	const codexFiles: string[] = [];
	for (const home of new Set([codexHome(), ...listCodexAccountDirs()])) {
		for (const store of ["sessions", "archived_sessions"]) {
			collectTranscriptFiles(join(home, store), codexFiles, true);
		}
	}
	foldJsonlFiles(codexFiles, codexState, foldCodexEntry, beginCodexRollout);
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
		days: days.length,
		hasUnpriced,
	});
	const models = [...new Set(Object.values(retained).flatMap((state) => [...state.records.values()].map((r) => r.model)))].sort();
	return { days, generatedAt: new Date().toISOString(), hasUnpricedModels: hasUnpriced, models };
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
