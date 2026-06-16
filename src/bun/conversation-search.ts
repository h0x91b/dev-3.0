import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { TaskStatus } from "../shared/types";
import {
	bm25Score,
	claudeEncodePath,
	computeExclusionSet,
	countTermFrequencies,
	countWords,
	DEFAULT_SEARCH_STATUSES,
	idf,
	META_FIELD_BOOST,
	rankMatches,
	reconstructWorktreePath,
	recencyMultiplier,
	tokenizeQuery,
	type ConversationMatch,
} from "../shared/conversation-search-core";

/**
 * Filesystem engine for searching past task conversations.
 *
 * The searchable corpus is each agent's transcript store (NOT the worktree,
 * which is deleted when a task is completed/cancelled). Transcripts survive in
 * the agent's own data dir, keyed by the worktree cwd, so we reconstruct that
 * path from the project slug + task short id and map it back to a dev3 task.
 *
 * Only agents whose store is cwd-keyed (and thus mappable to a single task —
 * required for variant isolation) can be searched. Claude is implemented; other
 * agents register here as their layouts become mappable.
 */

const MAX_SNIPPETS_PER_TASK = 3;
const SNIPPET_WINDOW = 140;
/** Max bytes read to recover a session-header line (codex SessionMeta is the first line). */
const HEADER_READ_BYTES = 64 * 1024;

/** worktree cwd → transcript file paths, built once per search for non-path-keyed stores. */
type WorktreeIndex = Map<string, string[]>;

interface TranscriptLocator {
	kind: string;
	/**
	 * Optional one-time scan returning a worktree-path → files index. Used by
	 * stores that are NOT derivable from the worktree path (codex date-buckets,
	 * gemini aliased dirs). Returns null for path-keyed stores (claude).
	 */
	buildIndex?(home: string): WorktreeIndex | null;
	/** Transcript files for one worktree path (may use the prebuilt index). */
	filesForWorktree(worktreePath: string, home: string, index: WorktreeIndex | null): string[];
	/** Parse a transcript file into searchable message texts (one unit per message). */
	extractUnits(filePath: string): string[];
}

// ---- shared fs helpers ----

function jsonlFilesIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => `${dir}/${f}`);
	} catch {
		return [];
	}
}

function readFileSafe(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

/** Read just the first line of a (possibly large) file without loading it whole. */
function readFirstLine(path: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(HEADER_READ_BYTES);
		const bytes = readSync(fd, buf, 0, HEADER_READ_BYTES, 0);
		const text = buf.toString("utf-8", 0, bytes);
		const nl = text.indexOf("\n");
		return nl === -1 ? text : text.slice(0, nl);
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

function textFromBlocks(content: unknown, wanted: (type: string) => boolean): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		const type = typeof b.type === "string" ? b.type : "text";
		if (wanted(type) && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

// ---- claude: path-keyed under ~/.claude/projects/<encoded-cwd> ----

const claudeLocator: TranscriptLocator = {
	kind: "claude",
	filesForWorktree(worktreePath, home) {
		return jsonlFilesIn(`${home}/.claude/projects/${claudeEncodePath(worktreePath)}`);
	},
	extractUnits(filePath) {
		const content = readFileSafe(filePath);
		if (!content) return [];
		const units: string[] = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (obj.type !== "user" && obj.type !== "assistant") continue;
			const message = obj.message as Record<string, unknown> | undefined;
			if (!message) continue;
			const text = textFromBlocks(message.content, (t) => t === "text" || t === "thinking");
			if (text.trim()) units.push(text);
		}
		return units;
	},
};

// ---- codex: date-bucketed rollouts; cwd lives in the SessionMeta header line ----

const codexLocator: TranscriptLocator = {
	kind: "codex",
	buildIndex(home) {
		const root = `${home}/.codex/sessions`;
		if (!existsSync(root)) return null;
		const index: WorktreeIndex = new Map();
		let entries: string[];
		try {
			entries = readdirSync(root, { recursive: true }) as string[];
		} catch {
			return null;
		}
		for (const rel of entries) {
			if (!rel.endsWith(".jsonl")) continue;
			const file = `${root}/${rel}`;
			const header = readFirstLine(file);
			if (!header) continue;
			let cwd: unknown;
			try {
				const payload = (JSON.parse(header) as Record<string, unknown>).payload as Record<string, unknown> | undefined;
				cwd = payload?.cwd;
			} catch {
				continue;
			}
			if (typeof cwd !== "string") continue;
			const list = index.get(cwd);
			if (list) list.push(file);
			else index.set(cwd, [file]);
		}
		return index;
	},
	filesForWorktree(worktreePath, _home, index) {
		return index?.get(worktreePath) ?? [];
	},
	extractUnits(filePath) {
		const content = readFileSafe(filePath);
		if (!content) return [];
		const units: string[] = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let payload: Record<string, unknown> | undefined;
			try {
				payload = (JSON.parse(line) as Record<string, unknown>).payload as Record<string, unknown> | undefined;
			} catch {
				continue;
			}
			if (!payload || payload.type !== "message") continue;
			const role = payload.role;
			if (role !== "user" && role !== "assistant") continue; // skip "developer" (injected boilerplate)
			const text = textFromBlocks(payload.content, (t) => t === "input_text" || t === "output_text" || t === "text");
			if (text.trim()) units.push(text);
		}
		return units;
	},
};

// ---- gemini: aliased dirs under ~/.gemini/tmp/<alias>; real cwd in .project_root ----

const geminiLocator: TranscriptLocator = {
	kind: "gemini",
	buildIndex(home) {
		const root = `${home}/.gemini/tmp`;
		if (!existsSync(root)) return null;
		const index: WorktreeIndex = new Map();
		let aliases: string[];
		try {
			aliases = readdirSync(root);
		} catch {
			return null;
		}
		for (const alias of aliases) {
			const projectRoot = readFileSafe(`${root}/${alias}/.project_root`)?.trim();
			if (!projectRoot) continue;
			const chatsDir = `${root}/${alias}/chats`;
			if (!existsSync(chatsDir)) continue;
			let files: string[];
			try {
				files = readdirSync(chatsDir).filter((f) => f.endsWith(".json")).map((f) => `${chatsDir}/${f}`);
			} catch {
				continue;
			}
			if (files.length === 0) continue;
			const list = index.get(projectRoot);
			if (list) list.push(...files);
			else index.set(projectRoot, files);
		}
		return index;
	},
	filesForWorktree(worktreePath, _home, index) {
		return index?.get(worktreePath) ?? [];
	},
	extractUnits(filePath) {
		const content = readFileSafe(filePath);
		if (!content) return [];
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(content) as Record<string, unknown>;
		} catch {
			return [];
		}
		const messages = parsed.messages;
		if (!Array.isArray(messages)) return [];
		const units: string[] = [];
		for (const msg of messages) {
			if (!msg || typeof msg !== "object") continue;
			const m = msg as Record<string, unknown>;
			const type = m.type;
			if (type !== "user" && type !== "gemini" && type !== "model" && type !== "assistant") continue;
			const text = textFromBlocks(m.content, () => true);
			if (text.trim()) units.push(text);
		}
		return units;
	},
};

/** Registered locators — every agent whose store maps to a single task (variant isolation). */
const LOCATORS: TranscriptLocator[] = [claudeLocator, codexLocator, geminiLocator];

export interface EngineTask {
	id: string;
	title?: string | null;
	description?: string | null;
	/** Agent-written overview (sticky-note summary). */
	overview?: string | null;
	/** User-edited overview override. */
	userOverview?: string | null;
	/** Note contents — curated, survive worktree destruction. */
	notes?: string[];
	/** Historical title/overview snapshots (flattened), so renamed tasks stay findable. */
	historyTexts?: string[];
	status: TaskStatus;
	groupId: string | null;
	agentId: string | null;
}

export interface SearchConversationsParams {
	query: string;
	/** All tasks of the project being searched (used for ranking + exclusion). */
	tasks: EngineTask[];
	/** Project slug (frozen algorithm) used to reconstruct worktree paths. */
	projectSlug: string;
	/** Current task id — always excluded from results. */
	currentTaskId: string | null;
	/** Current task's groupId — all siblings sharing it are excluded. */
	currentGroupId: string | null;
	/** Statuses to search; defaults to terminal (completed + cancelled). */
	statuses?: TaskStatus[];
	limit?: number;
	home?: string;
	dev3Home?: string;
	nowMs?: number;
}

function buildSnippet(text: string, tokens: string[]): string | null {
	const lower = text.toLowerCase();
	let idx = -1;
	for (const token of tokens) {
		const found = lower.indexOf(token);
		if (found !== -1 && (idx === -1 || found < idx)) idx = found;
	}
	if (idx === -1) return null;
	const start = Math.max(0, idx - Math.floor(SNIPPET_WINDOW / 3));
	const end = Math.min(text.length, start + SNIPPET_WINDOW);
	let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
	if (start > 0) snippet = `…${snippet}`;
	if (end < text.length) snippet = `${snippet}…`;
	return snippet;
}

/** Stable key for a matched line, used to detect boilerplate recurring across tasks. */
function lineKey(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

interface MatchedLine {
	hits: number;
	snippet: string;
}

interface TaskAggregate {
	task: EngineTask;
	/** Effective per-token frequency (body + meta*boost), aligned to query tokens. */
	termFreqs: number[];
	/** Document length in word tokens (body + meta), for BM25 normalization. */
	docLength: number;
	/** Raw (unboosted) occurrence counts, for informational output. */
	bodyMatches: number;
	metaMatches: number;
	metaSnippet: string | null;
	lastActivityMs: number | null;
	transcriptPaths: string[];
	/** Distinct matched body lines (deduped within the task), keyed by normalized text. */
	lines: Map<string, MatchedLine>;
}

/** Concatenate the curated, durable text for a task (survives worktree deletion). */
function metaTextFor(task: EngineTask): string {
	const parts = [
		task.title,
		task.description,
		task.overview,
		task.userOverview,
		...(task.notes ?? []),
		...(task.historyTexts ?? []),
	].filter((s): s is string => typeof s === "string" && s.length > 0);
	// Dedupe — history snapshots often repeat the current title/overview verbatim.
	return [...new Set(parts)].join("\n");
}

export function searchConversations(params: SearchConversationsParams): ConversationMatch[] {
	const tokens = tokenizeQuery(params.query);
	if (tokens.length === 0) return [];

	const home = params.home ?? homedir();
	const dev3Home = params.dev3Home ?? `${home}/.dev3.0`;
	const nowMs = params.nowMs ?? Date.now();
	const statuses = new Set<TaskStatus>(params.statuses ?? DEFAULT_SEARCH_STATUSES);
	const limit = params.limit ?? 5;

	const exclusion = computeExclusionSet(params.currentTaskId, params.currentGroupId, params.tasks);

	// Build each non-path-keyed locator's worktree→files index once per search.
	const locatorIndices = LOCATORS.map((loc) => (loc.buildIndex ? loc.buildIndex(home) : null));

	// Pass 1 — build one BM25 "document" per candidate task: per-term frequencies
	// (body + meta*boost), document length, and matched lines for snippets. The
	// corpus is every candidate (even non-matching ones) so IDF and average length
	// reflect the real distribution — this is what makes common terms decay.
	const aggregates: TaskAggregate[] = [];
	for (const task of params.tasks) {
		if (exclusion.has(task.id)) continue;
		if (!statuses.has(task.status)) continue;

		const metaText = metaTextFor(task);
		const metaTfs = countTermFrequencies(metaText, tokens);
		const metaLen = countWords(metaText);
		const metaHasMatch = metaTfs.some((c) => c > 0);
		const metaSnippet = metaHasMatch ? buildSnippet(metaText, tokens) : null;

		const worktreePath = reconstructWorktreePath(dev3Home, params.projectSlug, task.id);
		const bodyTfs = new Array(tokens.length).fill(0);
		let bodyLen = 0;
		const lines = new Map<string, MatchedLine>();
		let lastActivityMs: number | null = null;
		const transcriptPaths: string[] = [];

		for (let li = 0; li < LOCATORS.length; li++) {
			const locator = LOCATORS[li];
			for (const file of locator.filesForWorktree(worktreePath, home, locatorIndices[li])) {
				let mtimeMs = 0;
				try {
					mtimeMs = statSync(file).mtimeMs;
				} catch {
					continue;
				}
				let fileMatched = false;
				for (const text of locator.extractUnits(file)) {
					bodyLen += countWords(text);
					const lineTfs = countTermFrequencies(text, tokens);
					let lineHits = 0;
					for (let i = 0; i < tokens.length; i++) {
						bodyTfs[i] += lineTfs[i];
						lineHits += lineTfs[i];
					}
					if (lineHits === 0) continue;
					fileMatched = true;
					const key = lineKey(text);
					const existing = lines.get(key);
					if (existing) {
						existing.hits += lineHits;
					} else {
						lines.set(key, { hits: lineHits, snippet: buildSnippet(text, tokens) ?? text.slice(0, SNIPPET_WINDOW) });
					}
				}
				if (fileMatched) {
					transcriptPaths.push(file);
					lastActivityMs = lastActivityMs == null ? mtimeMs : Math.max(lastActivityMs, mtimeMs);
				}
			}
		}

		const docLength = bodyLen + metaLen;
		if (docLength === 0) continue;

		const termFreqs = tokens.map((_, i) => bodyTfs[i] + metaTfs[i] * META_FIELD_BOOST);
		const bodyMatches = bodyTfs.reduce((a: number, b: number) => a + b, 0);
		const metaMatches = metaTfs.reduce((a, b) => a + b, 0);
		aggregates.push({ task, termFreqs, docLength, bodyMatches, metaMatches, metaSnippet, lastActivityMs, transcriptPaths, lines });
	}

	if (aggregates.length === 0) return [];

	// Corpus statistics for BM25.
	const totalDocs = aggregates.length;
	const docFreq = tokens.map((_, i) => aggregates.reduce((n, agg) => n + (agg.termFreqs[i] > 0 ? 1 : 0), 0));
	const idfs = docFreq.map((df) => idf(df, totalDocs));
	const avgDocLength = aggregates.reduce((sum, agg) => sum + agg.docLength, 0) / totalDocs;

	// Boilerplate for snippet display only: a matched line recurring across tasks
	// (injected skill/CLI text). BM25 IDF already handles its weight in scoring.
	const taskCountByKey = new Map<string, number>();
	for (const agg of aggregates) {
		for (const key of agg.lines.keys()) {
			taskCountByKey.set(key, (taskCountByKey.get(key) ?? 0) + 1);
		}
	}
	const isBoilerplate = (key: string): boolean => (taskCountByKey.get(key) ?? 0) > 1;

	// Pass 2 — BM25 score × recency tie-breaker; pick densest non-boilerplate snippets.
	const matches: ConversationMatch[] = [];
	for (const agg of aggregates) {
		const relevance = bm25Score(agg.termFreqs, idfs, agg.docLength, avgDocLength);
		if (relevance <= 0) continue;
		const recency = agg.lastActivityMs == null ? 1 : recencyMultiplier(nowMs - agg.lastActivityMs, nowMs);
		const score = relevance * recency;

		const bodySnippets = [...agg.lines.entries()]
			.filter(([key]) => !isBoilerplate(key))
			.map(([, line]) => line)
			.sort((a, b) => b.hits - a.hits)
			.slice(0, MAX_SNIPPETS_PER_TASK)
			.map((l) => l.snippet);
		// Lead with the curated meta snippet (notes/overview) when present — it
		// explains the match even for tasks whose transcript is gone.
		const snippets = agg.metaSnippet
			? [agg.metaSnippet, ...bodySnippets].slice(0, MAX_SNIPPETS_PER_TASK)
			: bodySnippets;

		matches.push({
			taskId: agg.task.id,
			title: agg.task.title ?? "",
			status: agg.task.status,
			agentId: agg.task.agentId,
			score,
			bodyMatches: agg.bodyMatches,
			metaMatches: agg.metaMatches,
			snippets,
			transcriptPaths: agg.transcriptPaths,
			lastActivityMs: agg.lastActivityMs,
		});
	}

	return rankMatches(matches, limit);
}
