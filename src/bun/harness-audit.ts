import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveModelRate } from "../shared/agent-pricing";
import { conversationEvents } from "../shared/conversation-model";
import { parseConversation } from "../shared/conversation-parsers";

type Source = "codex" | "claude";
type Role = "parent" | "subagent";
type JsonObject = Record<string, unknown>;
type Counts = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
type Cost = Counts & { total: number };
interface TranscriptSpec { source: Source; path: string; role: Role }
interface TaskSpec { id: string; completed: boolean; transcripts: TranscriptSpec[] }
interface UsageRecord {
	record: number;
	source: Source;
	role: Role;
	model: string;
	stream: "native-response" | "legacy-token-count" | "claude-message";
	identityAvailable: boolean;
	tokens: Counts;
	cached: boolean;
	costUsd: Cost | null;
	gaps: string[];
}
interface InternalRecord { key: string | null; record: UsageRecord }
interface ToolMetrics {
	parsedUserTurns: number;
	toolCalls: number;
	toolResults: number;
	explicitErrorResults: number;
	resultsWithoutErrorFlag: number;
	toolOutputCharacters: number;
	toolOutputBytes: number;
}
interface TranscriptResult {
	transcript: number;
	source: Source;
	role: Role;
	stream: UsageRecord["stream"] | "none";
	invalidLines: number;
	nonblankLines: number;
	usageRecords: number;
	ignoredLegacyRecords: number;
	duplicateUsageRecords: number;
	tools: ToolMetrics | null;
	gaps: string[];
}

function object(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function error(message: string): never { throw new Error(message); }

function validateManifest(value: unknown): TaskSpec[] {
	const tasks = object(value)?.tasks;
	if (!Array.isArray(tasks)) return error("Manifest must contain a tasks array.");
	const ids = new Set<string>();
	return tasks.map((raw, i) => {
		const task = object(raw);
		if (!task || typeof task.id !== "string" || !task.id.trim() || typeof task.completed !== "boolean" || !Array.isArray(task.transcripts)) {
			return error(`Task ${i + 1} needs id, completed, and transcripts.`);
		}
		if (ids.has(task.id)) return error(`Task ${i + 1} repeats a task id; each task must appear once.`);
		ids.add(task.id);
		const transcripts = task.transcripts.map((rawFile, j): TranscriptSpec => {
			const file = object(rawFile);
			if (!file || (file.source !== "codex" && file.source !== "claude") || (file.role !== "parent" && file.role !== "subagent") || typeof file.path !== "string" || !file.path.trim()) {
				return error(`Task ${i + 1}, transcript ${j + 1} needs source, path, and role.`);
			}
			return { source: file.source, path: file.path, role: file.role };
		});
		return { id: task.id, completed: task.completed, transcripts };
	});
}

function safeModel(value: unknown): string {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/:\[\]-]{0,119}$/.test(value) ? value : "unknown";
}

function normalizeUsage(source: Source, usage: JsonObject): { tokens: Counts; gaps: string[] } {
	const gaps: string[] = [];
	function count(key: string, required = false, from = usage): number {
		const value = from[key];
		if (value === undefined && !required) return 0;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			gaps.push(`Missing or invalid ${key}.`);
			return 0;
		}
		return value;
	}
	const input = count("input_tokens", true);
	const output = count("output_tokens", true);
	const cacheRead = count(source === "codex" ? "cached_input_tokens" : "cache_read_input_tokens");
	const cacheWrite = count(source === "codex" ? "cache_write_input_tokens" : "cache_creation_input_tokens");
	const split = object(usage.cache_creation) ?? {};
	const cache1h = source === "claude" ? count("ephemeral_1h_input_tokens", false, split) : 0;
	const cache5m = source === "claude" ? count("ephemeral_5m_input_tokens", false, split) : 0;
	if (cache1h + cache5m > cacheWrite) gaps.push("Cache-write split exceeds the recorded total.");
	if (source === "codex" && cacheRead + cacheWrite > input) gaps.push("Cached reads and writes exceed inclusive input.");
	return {
		tokens: {
			input: source === "codex" ? Math.max(0, input - cacheRead - cacheWrite) : input,
			output,
			cacheRead,
			cacheWrite5m: cache5m + Math.max(0, cacheWrite - cache5m - cache1h),
			cacheWrite1h: cache1h,
		},
		gaps,
	};
}

function price(model: string, tokens: Counts): Cost | null {
	const rate = resolveModelRate(model);
	if (!rate) return null;
	const parts = {
		input: tokens.input * rate.input / 1_000_000,
		output: tokens.output * rate.output / 1_000_000,
		cacheRead: tokens.cacheRead * rate.cacheRead / 1_000_000,
		cacheWrite5m: tokens.cacheWrite5m * rate.cacheWrite5m / 1_000_000,
		cacheWrite1h: tokens.cacheWrite1h * rate.cacheWrite1h / 1_000_000,
	};
	return { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

function cumulativeSignature(usage: JsonObject | null): string | null {
	if (!usage) return null;
	const values = [usage.input_tokens, usage.output_tokens, usage.cached_input_tokens ?? 0, usage.cache_write_input_tokens ?? 0];
	return values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		? values.join(":") : null;
}

function toolMetrics(source: Source, body: string): ToolMetrics | null {
	try {
		const parsed = parseConversation(source, body, "");
		const events = conversationEvents(parsed);
		const results = events.filter((event) => event.kind === "tool-result");
		return {
			parsedUserTurns: parsed.turns.filter((turn) => turn.trigger === "user").length,
			toolCalls: events.filter((event) => event.kind === "tool-call").length,
			toolResults: results.length,
			explicitErrorResults: results.filter((event) => event.tool?.isError === true).length,
			resultsWithoutErrorFlag: results.filter((event) => event.tool?.isError === undefined).length,
			toolOutputCharacters: results.reduce((sum, event) => sum + (event.tool?.output?.length ?? 0), 0),
			toolOutputBytes: results.reduce((sum, event) => sum + Buffer.byteLength(event.tool?.output ?? "", "utf8"), 0),
		};
	} catch { return null; }
}

function parseTranscript(body: string, spec: TranscriptSpec, index: number): { info: TranscriptResult; records: InternalRecord[] } {
	const entries: JsonObject[] = [];
	let invalidLines = 0;
	let nonblankLines = 0;
	for (const line of body.split(/\r?\n/)) {
		if (!line.trim()) continue;
		nonblankLines++;
		try {
			const parsed = object(JSON.parse(line));
			if (parsed) entries.push(parsed);
			else invalidLines++;
		} catch { invalidLines++; }
	}
	const native = spec.source === "codex" && entries.some((entry) => entry.type === "token_usage_record");
	const records = new Map<string, InternalRecord>();
	const cumulativeSeen = new Set<string>();
	const nativeCumulative = new Set<string>();
	const ignoredLegacyCumulative: (string | null)[] = [];
	const nativeTotals = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0 };
	let model = "unknown";
	let ignoredLegacyRecords = 0;
	let duplicateUsageRecords = 0;
	const gaps: string[] = [];
	for (const [lineIndex, entry] of entries.entries()) {
		const payload = object(entry.payload);
		if (spec.source === "codex" && entry.type === "turn_context") model = safeModel(payload?.model);
		let usage: JsonObject | null = null;
		let key: string | null = null;
		let stream: UsageRecord["stream"];
		if (spec.source === "claude") {
			if (entry.type !== "assistant") continue;
			const message = object(entry.message);
			usage = object(message?.usage);
			model = safeModel(message?.model);
			if (typeof message?.id === "string" && typeof entry.requestId === "string") key = `claude:${JSON.stringify([message.id, entry.requestId])}`;
			stream = "claude-message";
		} else if (entry.type === "token_usage_record") {
			usage = object(payload?.usage);
			if (typeof payload?.response_id === "string" && payload.response_id) key = `codex:${payload.response_id}`;
			stream = "native-response";
		} else if (entry.type === "event_msg" && payload?.type === "token_count") {
			const info = object(payload.info);
			if (native) {
				ignoredLegacyRecords++;
				if (object(info?.last_token_usage)) ignoredLegacyCumulative.push(cumulativeSignature(object(info?.total_token_usage)));
				continue;
			}
			usage = object(info?.last_token_usage);
			const total = object(info?.total_token_usage);
			if (total && Object.keys(total).length > 0) {
				const fingerprint = JSON.stringify(Object.entries(total).sort(([a], [b]) => a.localeCompare(b)));
				if (cumulativeSeen.has(fingerprint)) { duplicateUsageRecords++; continue; }
				if (usage) cumulativeSeen.add(fingerprint);
			}
			stream = "legacy-token-count";
		} else continue;
		if (!usage) { gaps.push("A usage record has no readable usage object."); continue; }
		const normalized = normalizeUsage(spec.source, usage);
		if (!key && stream !== "legacy-token-count") normalized.gaps.push("Request identity is absent; deduplication is unavailable.");
		const costUsd = price(model, normalized.tokens);
		if (!costUsd) normalized.gaps.push("Model is absent or unpriced by the local rate table.");
		const record: UsageRecord = {
			record: 0, source: spec.source, role: spec.role, model, stream, identityAvailable: key !== null,
			tokens: normalized.tokens, cached: normalized.tokens.cacheRead > 0, costUsd, gaps: normalized.gaps,
		};
		const mapKey = key ?? `anonymous:${index}:${lineIndex}`;
		const previous = records.get(mapKey);
		if (previous) duplicateUsageRecords++;
		records.set(mapKey, { key, record });
		if (native) {
			for (const [snapshot, direction] of [[previous?.record, -1], [record, 1]] as const) {
				if (!snapshot) continue;
				const t = snapshot.tokens;
				nativeTotals.input_tokens += direction * (t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h);
				nativeTotals.output_tokens += direction * t.output;
				nativeTotals.cached_input_tokens += direction * t.cacheRead;
				nativeTotals.cache_write_input_tokens += direction * (t.cacheWrite5m + t.cacheWrite1h);
			}
			nativeCumulative.add(cumulativeSignature(nativeTotals)!);
		}
	}
	if (ignoredLegacyCumulative.some((signature) => signature === null || !nativeCumulative.has(signature))) {
		gaps.push("Native records do not establish coverage of all legacy cumulative usage; historical spend may be missing.");
	}
	const tools = toolMetrics(spec.source, body);
	if (!tools) gaps.push("Conversation parser could not derive tool metrics.");
	if (invalidLines) gaps.push("Invalid JSONL lines may hide usage.");
	if (records.size === 0) gaps.push(nonblankLines ? "No usable usage records." : "Empty transcript.");
	if (spec.source === "codex" && !native && records.size) gaps.push("Legacy token-count deltas are not verified API request records.");
	return {
		info: {
			transcript: index, source: spec.source, role: spec.role,
			stream: records.size ? (spec.source === "claude" ? "claude-message" : native ? "native-response" : "legacy-token-count") : "none",
			invalidLines, nonblankLines, usageRecords: records.size, ignoredLegacyRecords, duplicateUsageRecords, tools, gaps: [...new Set(gaps)],
		},
		records: [...records.values()],
	};
}

function sumCosts(records: UsageRecord[]): Cost {
	const total: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: 0 };
	for (const record of records) {
		if (!record.costUsd) continue;
		for (const key of Object.keys(total) as (keyof Cost)[]) total[key] += record.costUsd[key];
	}
	return total;
}

function summarize(records: UsageRecord[], complete: boolean) {
	const tokens: Counts = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
	for (const record of records) for (const key of Object.keys(tokens) as (keyof Counts)[]) tokens[key] += record.tokens[key];
	const knownCostUsd = sumCosts(records);
	const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
	const identified = records.filter((record) => record.identityAvailable);
	return {
		usageRecords: records.length,
		identifiedRequestRecords: identified.length,
		legacyUsageRecords: records.filter((record) => record.stream === "legacy-token-count").length,
		unpricedRecords: records.filter((record) => record.costUsd === null).length,
		incompleteRecords: records.filter((record) => record.gaps.length > 0).length,
		tokens,
		knownCostUsd,
		totalCostUsd: complete ? knownCostUsd.total : null,
		cacheTokenShare: promptTokens > 0 ? tokens.cacheRead / promptTokens : null,
		requestCacheHitShare: identified.length ? identified.filter((record) => record.cached).length / identified.length : null,
		usageRecordCacheHitShare: records.length ? records.filter((record) => record.cached).length / records.length : null,
		costByRole: { parent: sumCosts(records.filter((record) => record.role === "parent")), subagent: sumCosts(records.filter((record) => record.role === "subagent")) },
	};
}

/** Read only explicitly listed local files; never emit their contents, paths, or native identifiers. */
export function auditHarnessManifest(manifest: unknown, baseDirectory: string = process.cwd()) {
	const specs = validateManifest(manifest);
	const fileOwners = new Map<string, number>();
	const bodyOwners = new Map<string, number>();
	const requestOwners = new Map<string, number>();
	const tasks = specs.map((task, taskIndex) => {
		const taskNumber = taskIndex + 1;
		const records = new Map<string, UsageRecord>();
		const transcripts: TranscriptResult[] = [];
		let duplicateUsageRecords = 0;
		for (const [fileIndex, spec] of task.transcripts.entries()) {
			let file: string;
			let body: string;
			try {
				file = realpathSync(resolve(baseDirectory, spec.path));
				body = readFileSync(file, "utf8");
			} catch { return error(`Cannot read task ${taskNumber}, transcript ${fileIndex + 1}; check the manifest path and permissions.`); }
			if (fileOwners.has(file)) return error(`Task ${taskNumber}, transcript ${fileIndex + 1} repeats a file already assigned to task ${fileOwners.get(file)}.`);
			fileOwners.set(file, taskNumber);
			if (body.trim()) {
				const digest = createHash("sha256").update(body).digest("hex");
				if (bodyOwners.has(digest)) return error(`Task ${taskNumber}, transcript ${fileIndex + 1} duplicates transcript content assigned to task ${bodyOwners.get(digest)}.`);
				bodyOwners.set(digest, taskNumber);
			}
			const parsed = parseTranscript(body, spec, fileIndex + 1);
			transcripts.push(parsed.info);
			for (const item of parsed.records) {
				if (item.key) {
					const owner = requestOwners.get(item.key);
					if (owner !== undefined && owner !== taskNumber) return error(`Task ${taskNumber} shares a usage request with task ${owner}; fix transcript attribution.`);
					requestOwners.set(item.key, taskNumber);
				}
				const key = item.key ?? `file:${fileIndex}:record:${records.size}`;
				const previous = records.get(key);
				if (previous && previous.role !== item.record.role) return error(`Task ${taskNumber} attributes one usage request to both parent and subagent.`);
				if (previous) duplicateUsageRecords++;
				records.set(key, item.record);
			}
		}
		const requests = [...records.values()].map((record, i) => ({ ...record, record: i + 1 }));
		const suppliedUsageAccounted = requests.length > 0 && requests.every((record) => record.gaps.length === 0 && record.stream !== "legacy-token-count") && transcripts.every((file) => file.gaps.length === 0);
		return { task: taskNumber, completed: task.completed, suppliedUsageAccounted, duplicateUsageRecords, ...summarize(requests, suppliedUsageAccounted), transcripts, requests };
	});
	const all = tasks.flatMap((task) => task.requests);
	const completedTasks = specs.filter((task) => task.completed).length;
	const suppliedUsageAccounted = tasks.length > 0 && tasks.every((task) => task.suppliedUsageAccounted);
	const summary = summarize(all, suppliedUsageAccounted);
	return {
		schemaVersion: 1,
		assumptions: [
			"Offline API-equivalent estimate using the current local rate table, not an invoice or subscription bill.",
			"Standard short-context rates only; no historical, batch, priority, regional, long-context, or custom-provider pricing.",
			"Codex input includes cache reads and writes; Claude input excludes them. Absent optional cache counters mean zero.",
			"Unsplit cache writes use the table's 5-minute write rate. Partial Claude splits price the remainder at that rate.",
			"Native Codex response records replace legacy token counts within a file; unmatched legacy cumulative totals mark coverage incomplete. Latest identified snapshots replace earlier ones in manifest/file order.",
			"Identified request records group Codex response_id or Claude message.id + requestId; they are distinct from user turns and may not equal provider invoice requests.",
			"Legacy records are less reliable usage deltas; repeated cumulative totals are suppressed. Cross-file legacy overlap cannot be reliably detected.",
			"Task completion and parent/subagent attribution come only from the manifest. Include every attempt and child transcript; omitted files are not discovered.",
			"Cache token share uses all prompt tokens; request hit share uses identified request records only. Legacy hit share is reported separately as a usage-record proxy.",
			"Tool metrics use parsed local conversation events; parsed user turns may include setup-message boundaries; missing error flags are unknown outcomes, and output bytes are not tokens or billing-source attribution.",
			"Tool events and user turns may repeat across resumed files; retries, context sources, compaction costs, and failed requests without usage are not inferred.",
			"Only model identifiers are retained. Task, request, session, and tool identifiers, paths, content, and timestamps are omitted.",
		],
		suppliedUsageAccounted,
		...summary,
		taskCount: tasks.length,
		completedTasks,
		apiEquivalentCostPerCompletedTaskUsd: completedTasks > 0 && suppliedUsageAccounted ? summary.knownCostUsd.total / completedTasks : null,
		knownCostPerCompletedTaskUsd: completedTasks > 0 ? summary.knownCostUsd.total / completedTasks : null,
		tasks,
	};
}
