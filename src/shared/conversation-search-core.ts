import type { TaskStatus } from "./types";

/**
 * Pure (I/O-free) core for conversation search across past task transcripts.
 *
 * Lives in `src/shared` so it is importable by the CLI, the bun engine, and
 * tests without dragging in `node:fs`. Anything touching the filesystem or
 * spawning processes belongs in `src/bun/conversation-search.ts`.
 */

/** Default statuses searched when the caller does not override them. */
export const DEFAULT_SEARCH_STATUSES: TaskStatus[] = ["completed", "cancelled"];

/** BM25 term-frequency saturation. */
export const BM25_K1 = 1.5;
/** BM25 length-normalization strength (0 = none, 1 = full). */
export const BM25_B = 0.75;
/**
 * Curated "meta" text (title, description, overview, notes) is the distilled,
 * human/agent-curated signal that survives worktree destruction. We treat a meta
 * occurrence as this many body occurrences (BM25F-lite field boost).
 */
export const META_FIELD_BOOST = 3;

/** Recency multiplier bounds — relevance leads, recency only breaks ties. */
export const RECENCY_MIN_MULTIPLIER = 0.5;
export const RECENCY_MAX_MULTIPLIER = 1.5;
/** Age (days) at which the recency multiplier reaches its midpoint (1.0). */
export const RECENCY_HALFLIFE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Claude Code stores transcripts under `~/.claude/projects/<encoded-cwd>/`,
 * where the cwd is encoded by replacing every `/` and `.` with `-`.
 *
 * This is reverse-engineered from on-disk layout (see decision record). It is
 * the ONLY place this algorithm lives; keep it in lockstep with reality.
 */
export function claudeEncodePath(absolutePath: string): string {
	return absolutePath.replace(/[/.]/g, "-");
}

/**
 * Reconstruct a task's worktree path deterministically from project slug and
 * the task's short id. dev3 nulls `task.worktreePath` once a task is completed
 * or cancelled (see task-lifecycle moveTask), so the stored field cannot be
 * relied on — but the path is always
 * `<dev3Home>/worktrees/<projectSlug>/<shortId>/worktree`.
 */
export function reconstructWorktreePath(dev3Home: string, projectSlug: string, taskId: string): string {
	const shortId = taskId.slice(0, 8);
	return `${dev3Home}/worktrees/${projectSlug}/${shortId}/worktree`;
}

/**
 * Mirror of the frozen `projectSlug()` algorithm (see git.ts / context.ts):
 * strip a leading slash, then replace every `/` with `-`. Dots are preserved.
 */
export function projectSlug(projectPath: string): string {
	return projectPath.replace(/^\//, "").replaceAll("/", "-");
}

/** Split a free-text query into lowercased search tokens (length >= 2, deduped). */
export function tokenizeQuery(query: string): string[] {
	const seen = new Set<string>();
	const tokens: string[] = [];
	for (const raw of query.toLowerCase().split(/[^a-z0-9_]+/i)) {
		const t = raw.trim();
		if (t.length < 2 || seen.has(t)) continue;
		seen.add(t);
		tokens.push(t);
	}
	return tokens;
}

/**
 * Per-token whole-word occurrence counts in `text` (case-insensitive), aligned
 * to `tokens`. Word-boundary matching avoids false hits like the token "tip"
 * matching "tooltip". Tokens are restricted to [a-z0-9_] by tokenizeQuery, so
 * they are regex-safe.
 */
export function countTermFrequencies(text: string, tokens: string[]): number[] {
	if (!text) return tokens.map(() => 0);
	return tokens.map((token) => {
		const matches = text.match(new RegExp(`\\b${token}\\b`, "gi"));
		return matches ? matches.length : 0;
	});
}

/** Total whole-word occurrences of every token in `text` (sum of per-term counts). */
export function countOccurrences(text: string, tokens: string[]): number {
	if (!text || tokens.length === 0) return 0;
	return countTermFrequencies(text, tokens).reduce((a, b) => a + b, 0);
}

/** Approximate document length in word tokens (no large allocation). */
export function countWords(text: string): number {
	if (!text) return 0;
	const re = /\w+/g;
	let n = 0;
	while (re.exec(text) !== null) n++;
	return n;
}

/**
 * Tasks that must NEVER appear in results for the given current task:
 *  - the current task itself, and
 *  - every sibling variant sharing the same non-null groupId (live competitors
 *    AND already-finished siblings) — so parallel variants can't peek at each
 *    other and converge.
 */
export function computeExclusionSet(
	currentTaskId: string | null,
	currentGroupId: string | null,
	tasks: ReadonlyArray<{ id: string; groupId: string | null }>,
): Set<string> {
	const excluded = new Set<string>();
	if (currentTaskId) excluded.add(currentTaskId);
	if (currentGroupId) {
		for (const t of tasks) {
			if (t.groupId === currentGroupId) excluded.add(t.id);
		}
	}
	return excluded;
}

/** Map a transcript's age to a bounded recency multiplier (newer → higher). */
export function recencyMultiplier(ageMs: number, nowMs: number): number {
	const ageDays = Math.max(0, ageMs) / MS_PER_DAY;
	// Smoothly decays from MAX (age 0) toward MIN as age grows, crossing 1.0
	// around RECENCY_HALFLIFE_DAYS.
	const span = RECENCY_MAX_MULTIPLIER - RECENCY_MIN_MULTIPLIER;
	const factor = RECENCY_HALFLIFE_DAYS / (RECENCY_HALFLIFE_DAYS + ageDays);
	void nowMs;
	return RECENCY_MIN_MULTIPLIER + span * factor;
}

/**
 * BM25 inverse document frequency. Rare query terms score high; terms present in
 * most documents (common words, injected skill/CLI boilerplate) decay toward
 * zero automatically — no stopword list needed. The +1 keeps it non-negative.
 */
export function idf(docFreq: number, totalDocs: number): number {
	return Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
}

/**
 * BM25 relevance of one document. `termFreqs`/`idfs` are aligned to the query
 * tokens. TF saturation (k1) caps repeated-term gains; length normalization (b)
 * stops long transcripts from dominating. Returns 0 when nothing matched.
 */
export function bm25Score(
	termFreqs: number[],
	idfs: number[],
	docLength: number,
	avgDocLength: number,
	k1: number = BM25_K1,
	b: number = BM25_B,
): number {
	if (avgDocLength <= 0) return 0;
	let score = 0;
	for (let i = 0; i < termFreqs.length; i++) {
		const tf = termFreqs[i];
		if (tf <= 0) continue;
		const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
		score += idfs[i] * norm;
	}
	return score;
}

export interface ConversationMatch {
	taskId: string;
	title: string;
	status: TaskStatus;
	agentId: string | null;
	score: number;
	bodyMatches: number;
	metaMatches: number;
	snippets: string[];
	transcriptPaths: string[];
	lastActivityMs: number | null;
}

/** Sort matches by score desc, then recency desc, then id for stability; take top N. */
export function rankMatches(matches: ConversationMatch[], limit: number): ConversationMatch[] {
	return [...matches]
		.filter((m) => m.score > 0)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const ar = a.lastActivityMs ?? 0;
			const br = b.lastActivityMs ?? 0;
			if (br !== ar) return br - ar;
			return a.taskId.localeCompare(b.taskId);
		})
		.slice(0, Math.max(0, limit));
}
