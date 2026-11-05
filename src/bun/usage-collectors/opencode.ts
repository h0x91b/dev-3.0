import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mergeUsageRecord, type UsageState } from "../rpc-handlers/agent-usage-parse";
import type { ReadonlySqliteQuery } from "../sqlite-readonly";

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | null {
	if (value === undefined) return 0;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parse(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "string") return undefined;
	try { return object(JSON.parse(value)); }
	catch { return undefined; }
}

// One row per model call. A message's own `tokens` holds only its LAST step, so it is never read.
const STEP_SQL = `SELECT p.id AS id, p.time_created AS created, p.data AS part, m.data AS message
FROM part p JOIN message m ON m.id = p.message_id
WHERE p.data LIKE '%"step-finish"%'`;

/** OpenCode reports input without cache reads/writes and reasoning apart from output. */
export function foldOpenCodeStep(state: UsageState, row: Record<string, unknown>): void {
	const part = parse(row.part);
	const message = parse(row.message);
	if (typeof row.id !== "string" || !row.id || part?.type !== "step-finish" || message?.role !== "assistant") return;
	const tokens = object(part.tokens);
	const cache = object(tokens?.cache);
	const [input, output, reasoning, cacheRead, cacheWrite] = [tokens?.input, tokens?.output, tokens?.reasoning, cache?.read, cache?.write].map(count);
	if (!tokens || input === null || output === null || reasoning === null || cacheRead === null || cacheWrite === null) return;
	if (input + output + reasoning + cacheRead + cacheWrite === 0) return;
	const created = typeof row.created === "number" && Number.isFinite(row.created) && row.created > 0
		? row.created : object(message.time)?.created;
	if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) return;
	mergeUsageRecord(state, `opencode:${JSON.stringify([row.id])}`, {
		model: typeof message.modelID === "string" && message.modelID.trim() ? message.modelID : "unknown",
		timestamp: created,
		counts: { inputTokens: input, outputTokens: output + reasoning, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite },
	});
}

/** `opencode.db` plus per-channel `opencode-<channel>.db` stores, and an `OPENCODE_DB` override. */
export function openCodeDatabases(home: string, env: Record<string, string | undefined> = process.env): string[] {
	const dataDir = join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "opencode");
	const files = new Set<string>();
	try {
		for (const name of readdirSync(dataDir)) {
			if (/^opencode(-[A-Za-z0-9._-]+)?\.db$/.test(name)) files.add(join(dataDir, name));
		}
	} catch { /* No OpenCode data directory is a graceful absence. */ }
	const override = env.OPENCODE_DB?.trim();
	if (override && override !== ":memory:") files.add(isAbsolute(override) ? override : join(dataDir, override));
	return [...files];
}

/** Read step accounting only; message text, tool output and prompts stay unread. */
export function collectOpenCodeUsage(state: UsageState, databases: string[], query: ReadonlySqliteQuery, warn: (db: string, error: unknown) => void = () => {}): void {
	for (const db of databases) {
		let rows: Record<string, unknown>[];
		try { rows = query(db, STEP_SQL); }
		catch (error) { warn(db, error); continue; }
		for (const row of rows) foldOpenCodeStep(state, row);
	}
}
