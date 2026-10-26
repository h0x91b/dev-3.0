import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDev3Home } from "../../shared/dev3-home";
import { mergeUsageRecord, type UsageRecord, type UsageState } from "../rpc-handlers/agent-usage-parse";

export interface CursorUsageSnapshot {
	conversationId: string;
	generationId: string;
	usage: UsageRecord;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function tokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identity(snapshot: CursorUsageSnapshot): string {
	return `cursor:${JSON.stringify([snapshot.conversationId, snapshot.generationId])}`;
}

/** Cursor's interactive hooks report uncached input; the transcript itself has no usage. */
export function parseCursorHookUsage(payload: unknown, timestamp: number): CursorUsageSnapshot | null {
	const entry = object(payload);
	if (!entry || typeof entry.hook_event_name !== "string" || !["afterAgentResponse", "stop"].includes(entry.hook_event_name) ||
		!Number.isFinite(timestamp) || timestamp <= 0) return null;
	const { conversation_id, generation_id, model, input_tokens, output_tokens } = entry;
	const cacheRead = entry.cache_read_tokens ?? 0;
	const cacheWrite = entry.cache_write_tokens ?? 0;
	if (typeof conversation_id !== "string" || !conversation_id || conversation_id.length > 256 ||
		typeof generation_id !== "string" || !generation_id || generation_id.length > 256 ||
		typeof model !== "string" || !model.trim() || model.length > 256 || !tokenCount(input_tokens) || !tokenCount(output_tokens) ||
		!tokenCount(cacheRead) || !tokenCount(cacheWrite)) return null;
	if (input_tokens + output_tokens + cacheRead + cacheWrite === 0) return null;
	return {
		conversationId: conversation_id,
		generationId: generation_id,
		usage: {
			model, timestamp,
			counts: {
				inputTokens: input_tokens, outputTokens: output_tokens,
				cacheCreationInputTokens: cacheWrite, cacheReadInputTokens: cacheRead,
			},
		},
	};
}

export function foldCursorHookUsage(state: UsageState, payload: unknown, timestamp: number): boolean {
	const snapshot = parseCursorHookUsage(payload, timestamp);
	if (!snapshot) return false;
	const key = identity(snapshot);
	const previous = state.records.get(key);
	mergeUsageRecord(state, key, {
		...snapshot.usage,
		timestamp: Math.min(previous?.timestamp ?? timestamp, timestamp),
	});
	return true;
}

/** Persist an allowlisted snapshot before the hook process exits. */
export function recordCursorHookUsage(payload: unknown, timestamp = Date.now(), storeRoot = resolveDev3Home()): boolean {
	const snapshot = parseCursorHookUsage(payload, timestamp);
	if (!snapshot) return false;
	try {
		const path = join(storeRoot, "usage", "cursor.jsonl");
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ key: identity(snapshot), record: snapshot.usage })}\n`, { mode: 0o600 });
		return true;
	} catch { return false; }
}

/** Read only the content-free hook ledger, never infer tokens from conversation text. */
export function collectCursorUsage(state: UsageState, storeRoot: string): void {
	try {
		for (const line of readFileSync(join(storeRoot, "usage", "cursor.jsonl"), "utf8").split("\n")) {
			try {
				const entry = JSON.parse(line);
				if (typeof entry.key !== "string" || !entry.key.startsWith("cursor:")) continue;
				const ids = JSON.parse(entry.key.slice("cursor:".length));
				if (!Array.isArray(ids) || ids.length !== 2) continue;
				const record = object(entry.record);
				const counts = object(record?.counts);
				foldCursorHookUsage(state, {
					hook_event_name: "afterAgentResponse", conversation_id: ids[0], generation_id: ids[1],
					model: record?.model, input_tokens: counts?.inputTokens, output_tokens: counts?.outputTokens,
					cache_read_tokens: counts?.cacheReadInputTokens, cache_write_tokens: counts?.cacheCreationInputTokens,
				}, typeof record?.timestamp === "number" ? record.timestamp : NaN);
			} catch { /* Ignore incomplete writes and malformed individual records. */ }
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
