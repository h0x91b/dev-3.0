import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenCounts } from "../../shared/agent-pricing";
import { mergeUsageRecord, type UsageState } from "../rpc-handlers/agent-usage-parse";

/** pi and Oh My Pi share one session format but count different entries. */
export type PiFlavor = "pi" | "omp";

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | null {
	if (value === undefined) return 0;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** pi-ai already reports input without cache reads/writes; `cacheWrite1h` is a subset of `cacheWrite`. */
function tokenCounts(value: unknown): TokenCounts | null {
	const usage = object(value);
	const orchestration = object(usage?.orchestration);
	if (!usage) return null;
	const fields = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, orchestration?.input, orchestration?.output, orchestration?.cacheRead];
	const [input, output, cacheRead, cacheWrite, orchInput, orchOutput, orchCacheRead] = fields.map(count);
	const cacheWrite1h = usage.cacheWrite1h === undefined ? undefined : count(usage.cacheWrite1h);
	if ([input, output, cacheRead, cacheWrite, orchInput, orchOutput, orchCacheRead, cacheWrite1h].includes(null)) return null;
	const counts: TokenCounts = {
		inputTokens: input! + orchInput!,
		outputTokens: output! + orchOutput!,
		cacheReadInputTokens: cacheRead! + orchCacheRead!,
		cacheCreationInputTokens: cacheWrite!,
	};
	if (cacheWrite1h !== undefined) {
		counts.cacheCreation1hInputTokens = Math.min(cacheWrite!, cacheWrite1h!);
		counts.cacheCreation5mInputTokens = cacheWrite! - counts.cacheCreation1hInputTokens;
	}
	return counts.inputTokens + counts.outputTokens + counts.cacheReadInputTokens + counts.cacheCreationInputTokens > 0 ? counts : null;
}

function timestampOf(entry: Record<string, unknown>, message?: Record<string, unknown>): number | null {
	if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp) && message.timestamp > 0) return message.timestamp;
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function modelName(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** Which usage an entry carries, mirroring each harness's own session totals. */
function usageOf(flavor: PiFlavor, entry: Record<string, unknown>): { model: string; usage: unknown; message?: Record<string, unknown> } | null {
	const message = object(entry.message);
	if (entry.type === "message" && message?.role === "assistant") {
		const model = flavor === "pi" ? modelName(message.responseModel) ?? modelName(message.model) : modelName(message.model);
		return model || flavor === "pi" ? { model: model ?? "unknown", usage: message.usage, message } : null;
	}
	if (flavor === "omp") {
		return entry.type === "model_usage" && modelName(entry.model) ? { model: entry.model as string, usage: entry.usage } : null;
	}
	if (entry.type === "usage") return { model: modelName(entry.model) ?? "unknown", usage: entry.usage };
	// pi attributes nested tool work and summaries to no model; their cost stays visibly unpriced.
	if (entry.type === "message" && message?.role === "toolResult" && message.usage) return { model: "unknown", usage: message.usage, message };
	if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) return { model: "unknown", usage: entry.usage };
	return null;
}

/** Forks and branch extracts copy entries verbatim, so identity is the entry, not the file. */
export function foldPiEntry(state: UsageState, flavor: PiFlavor, value: unknown): void {
	const entry = object(value);
	if (!entry || typeof entry.id !== "string" || !entry.id) return;
	const found = usageOf(flavor, entry);
	if (!found) return;
	const counts = tokenCounts(found.usage);
	const timestamp = timestampOf(entry, found.message);
	if (!counts || timestamp === null) return;
	mergeUsageRecord(state, `${flavor}:${JSON.stringify([entry.id, timestamp])}`, { model: found.model, timestamp, counts });
}

function collectSessionFiles(state: UsageState, flavor: PiFlavor, dir: string): void {
	let entries: import("node:fs").Dirent[];
	try { entries = readdirSync(dir, { withFileTypes: true }); }
	catch { return; }
	for (const entry of entries) {
		const path = join(dir, entry.name);
		// omp nests subagent and advisor sessions below their parent session.
		if (entry.isDirectory()) collectSessionFiles(state, flavor, path);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			let text: string;
			try { text = readFileSync(path, "utf8"); }
			catch { continue; }
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try { foldPiEntry(state, flavor, JSON.parse(line)); }
				catch { /* A partially written final line must not hide earlier usage. */ }
			}
		}
	}
}

/** Read only the per-response usage of every listed agent dir's `sessions` store. */
export function collectPiUsage(state: UsageState, flavor: PiFlavor, sessionRoots: string[]): void {
	for (const root of new Set(sessionRoots)) collectSessionFiles(state, flavor, root);
}

/** Default, XDG and managed-account session stores; custom profiles and session-dir overrides are not read. */
export function piSessionRoots(flavor: PiFlavor, home: string, accountDirs: string[], env: Record<string, string | undefined> = process.env): string[] {
	const roots = [join(home, flavor === "pi" ? ".pi" : ".omp", "agent", "sessions")];
	// omp moves default-dir data under $XDG_DATA_HOME/omp once that directory exists.
	if (flavor === "omp" && env.XDG_DATA_HOME?.trim()) roots.push(join(env.XDG_DATA_HOME.trim(), "omp", "sessions"));
	return [...roots, ...accountDirs.map((dir) => join(dir, "sessions"))];
}
