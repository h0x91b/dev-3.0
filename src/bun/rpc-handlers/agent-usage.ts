import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentUsageReport } from "../../shared/types";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import { getAgentRateLimitsReport } from "../rate-limit-monitor";
import { finalizeUsage, foldClaudeEntry, newUsageState } from "./agent-usage-parse";
import { log } from "./shared";

/**
 * Agent usage (tokens + API-equivalent cost) reconstructed from LOCAL on-disk
 * agent state — no API calls. v1 covers Claude Code by parsing its transcript
 * JSONL files (`~/.claude/projects/<slug>/<uuid>.jsonl`), the same source the
 * `ccusage` tool uses. Pure aggregation lives in `agent-usage-parse.ts`; this
 * file only walks the filesystem. Codex (rollouts) is a planned follow-up.
 */

/** Root of Claude Code's projects dir, honouring CLAUDE_CONFIG_DIR (used by the account switcher). */
function claudeProjectsDir(): string {
	const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return join(base, "projects");
}

/** Recursively collect every *.jsonl transcript under the projects dir. Never throws. */
function collectTranscriptFiles(dir: string, out: string[]): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // missing / unreadable dir → graceful absence
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectTranscriptFiles(full, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
	}
}

export async function getAgentUsage(): Promise<AgentUsageReport> {
	const state = newUsageState();
	const files: string[] = [];
	collectTranscriptFiles(claudeProjectsDir(), files);

	for (const file of files) {
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
				foldClaudeEntry(state, JSON.parse(trimmed));
			} catch {
				// tolerate a truncated / partially-written last line
			}
		}
	}

	const { days, hasUnpriced } = finalizeUsage(state, "claude");
	log.info("getAgentUsage computed", { files: files.length, days: days.length, hasUnpriced });
	return { days, generatedAt: new Date().toISOString(), hasUnpricedModels: hasUnpriced };
}

/** Current agent rate-limit windows (Claude statusLine dump / Codex rollouts). */
async function getAgentRateLimits(): Promise<AgentRateLimitsReport> {
	return getAgentRateLimitsReport();
}

export const agentUsageHandlers = {
	getAgentUsage,
	getAgentRateLimits,
};
