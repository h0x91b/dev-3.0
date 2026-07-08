import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentUsageReport } from "../../shared/types";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import { getAgentRateLimitsReport } from "../rate-limit-monitor";
import { beginCodexRollout, finalizeUsage, foldClaudeEntry, foldCodexEntry, newUsageState, type UsageState } from "./agent-usage-parse";
import { log } from "./shared";

/**
 * Agent usage (tokens + API-equivalent cost) reconstructed from LOCAL on-disk
 * agent state — no API calls. Covers Claude Code transcripts and Codex rollout
 * JSONL files, the same local sources the `ccusage` tool uses. Pure aggregation
 * lives in `agent-usage-parse.ts`; this file only walks the filesystem.
 */

/** Root of Claude Code's projects dir, honouring CLAUDE_CONFIG_DIR (used by the account switcher). */
function claudeProjectsDir(): string {
	const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return join(base, "projects");
}

/** Root of Codex rollout sessions, honouring CODEX_HOME. */
function codexSessionsDir(): string {
	const base = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
	return join(base, "sessions");
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
	collectTranscriptFiles(claudeProjectsDir(), claudeFiles);
	foldJsonlFiles(claudeFiles, claudeState, foldClaudeEntry);

	const codexState = newUsageState();
	const codexFiles: string[] = [];
	collectTranscriptFiles(codexSessionsDir(), codexFiles, true);
	foldJsonlFiles(codexFiles, codexState, foldCodexEntry, beginCodexRollout);

	const claude = finalizeUsage(claudeState, "claude");
	const codex = finalizeUsage(codexState, "codex");
	const days = [...claude.days, ...codex.days].sort(
		(a, b) => a.startMs - b.startMs || a.source.localeCompare(b.source),
	);
	const hasUnpriced = claude.hasUnpriced || codex.hasUnpriced;
	log.info("getAgentUsage computed", {
		claudeFiles: claudeFiles.length,
		codexFiles: codexFiles.length,
		days: days.length,
		hasUnpriced,
	});
	return { days, generatedAt: new Date().toISOString(), hasUnpricedModels: hasUnpriced };
}

/** Current agent rate limits (local dumps/rollouts plus cached Codex monthly credits). */
async function getAgentRateLimits(): Promise<AgentRateLimitsReport> {
	return getAgentRateLimitsReport();
}

export const agentUsageHandlers = {
	getAgentUsage,
	getAgentRateLimits,
};
