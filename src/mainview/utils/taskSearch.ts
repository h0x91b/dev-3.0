import type { Task } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import { fuzzyScore } from "./fuzzyMatch";

/**
 * Token-DSL task search & filter engine.
 *
 * The search string is the SINGLE source of truth for both free-text search
 * and structured filtering. A query mixes recognized facet tokens
 * (`label:"Bug Fix" agent:Codex status:review is:attention has:port`) with
 * ordinary free text (`login`). The same parser drives the Kanban filter bar
 * and the Active Tasks sidebar so both surfaces behave identically.
 *
 * Combination semantics: AND across facets, OR within a facet, free text
 * ANDed with the facets. Facet VALUE matching is case-insensitive substring
 * against resolved per-task data (label/agent/status names). Checked/active
 * state (`isFacetTokenActive`) is a DIFFERENT comparison — an exact
 * (case-insensitive) presence check of that value's token in the string.
 *
 * The facet set is a data-driven registry so a new facet (e.g. `priority:`,
 * once the field exists) is one entry — see FACET_DEFS.
 */

/** Ordered set of recognized facet keys. Extend here to add a facet. */
export const FACET_KEYS = ["priority", "label", "agent", "status", "is", "has"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

/**
 * Resolved per-task facet data. Built by each surface from data it already
 * holds (see `taskFacets.ts`), keeping the matcher pure and unit-testable.
 */
export interface TaskQueryContext {
	/** Names of every label assigned to the task. */
	labelNames: string[];
	/** The task's resolved agent display name, or null when unassigned. */
	agentName: string | null;
	/**
	 * Every value a `status:` token may substring-match: the internal status id,
	 * the localized status label, and the custom-column name when the task is
	 * parked in one.
	 */
	statusValues: string[];
	/** True when the task currently has at least one allocated port. */
	hasPort: boolean;
	/** True when the task needs the user's attention (see `is:attention`). */
	isAttention: boolean;
	/** The task's effective priority level (e.g. "p2"), lowercased. */
	priorityValue: string;
	/** PR number for the task's branch, for free-text identifier matching. */
	prNumber?: number | null;
}

interface FacetDef {
	key: FacetKey;
	kind: "free" | "flag";
	/** For flag facets: the fixed set of accepted values (e.g. `["attention"]`). */
	flagValues?: readonly string[];
	/** Substring/predicate test of a lowercased value against the task context. */
	match: (ctx: TaskQueryContext, value: string) => boolean;
}

const FACET_DEFS: Record<FacetKey, FacetDef> = {
	priority: {
		key: "priority",
		kind: "free",
		match: (ctx, v) => ctx.priorityValue.includes(v),
	},
	label: {
		key: "label",
		kind: "free",
		match: (ctx, v) => ctx.labelNames.some((n) => n.toLowerCase().includes(v)),
	},
	agent: {
		key: "agent",
		kind: "free",
		match: (ctx, v) => ctx.agentName != null && ctx.agentName.toLowerCase().includes(v),
	},
	status: {
		key: "status",
		kind: "free",
		match: (ctx, v) => ctx.statusValues.some((s) => s.toLowerCase().includes(v)),
	},
	is: {
		key: "is",
		kind: "flag",
		flagValues: ["attention"],
		match: (ctx, v) => (v === "attention" ? ctx.isAttention : false),
	},
	has: {
		key: "has",
		kind: "flag",
		flagValues: ["port"],
		match: (ctx, v) => (v === "port" ? ctx.hasPort : false),
	},
};

export interface ParsedQuery {
	/** Lowercased facet values, keyed by facet, in encounter order. */
	facets: Record<FacetKey, string[]>;
	/** Everything that was not a recognized facet token, space-joined. */
	freeText: string;
}

/**
 * Tokenizer: matches a quoted facet token, a bare facet token, or a bare word.
 * Ordered alternation so `key:"…"`/`key:…` win over the catch-all bare word.
 * The quoted body accepts backslash escapes (`\"`, `\\`) so a value may contain
 * the delimiter itself — `label:"He said \"hi\""`.
 */
const TOKEN_RE = /(\w+):"((?:\\.|[^"\\])*)"|(\w+):(\S+)|(\S+)/g;

/** Escape a value for embedding between double quotes in the DSL. */
function escapeDslValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Reverse `escapeDslValue`: turn `\x` back into `x` (so `\"`→`"`, `\\`→`\`). */
function unescapeDslValue(inner: string): string {
	return inner.replace(/\\(.)/g, "$1");
}

function emptyFacets(): Record<FacetKey, string[]> {
	return { priority: [], label: [], agent: [], status: [], is: [], has: [] };
}

/**
 * Classify a `key:value` pair. Returns the facet + normalized value when the
 * token is recognized, or null when it should fall through to free text
 * (unknown key, or an unknown value for a flag facet).
 */
function classifyToken(rawKey: string, rawValue: string): { facet: FacetKey; value: string } | null {
	const key = rawKey.toLowerCase();
	if (!(FACET_KEYS as readonly string[]).includes(key)) return null;
	const def = FACET_DEFS[key as FacetKey];
	const value = rawValue.trim().toLowerCase();
	if (value === "") return null;
	if (def.kind === "flag") {
		return def.flagValues?.includes(value) ? { facet: def.key, value } : null;
	}
	return { facet: def.key, value };
}

// Single-entry parse cache: the filter loop parses the same query once per
// task, so memoizing the last (query → ParsedQuery) avoids re-tokenizing N
// times per render for a list of N tasks.
let cacheKey: string | null = null;
let cacheValue: ParsedQuery | null = null;

export function parseTaskQuery(query: string): ParsedQuery {
	if (cacheKey === query && cacheValue) return cacheValue;

	const facets = emptyFacets();
	const freeTextParts: string[] = [];
	TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN_RE.exec(query)) !== null) {
		if (m[1] !== undefined) {
			// key:"quoted value" — m[2] is the escaped body.
			const classified = classifyToken(m[1], unescapeDslValue(m[2]));
			if (classified) facets[classified.facet].push(classified.value);
			else freeTextParts.push(m[0]);
		} else if (m[3] !== undefined) {
			// key:bareword
			const classified = classifyToken(m[3], m[4]);
			if (classified) facets[classified.facet].push(classified.value);
			else freeTextParts.push(m[0]);
		} else {
			// bare word
			freeTextParts.push(m[5]);
		}
	}

	const parsed: ParsedQuery = { facets, freeText: freeTextParts.join(" ") };
	cacheKey = query;
	cacheValue = parsed;
	return parsed;
}

/**
 * Free-text matcher (title/description fuzzy + seq/UUID/PR prefix). This is the
 * previous `matchesSearchQuery` behavior, now the internal free-text step of
 * `matchesTaskQuery`. All comparisons are case-insensitive.
 */
function matchesFreeText(task: Task, freeText: string, prNumber?: number | null): boolean {
	const q = freeText.trim().toLowerCase();
	if (q === "") return true;

	const qNormalized = q.startsWith("#") ? q.slice(1) : q;

	if (fuzzyScore(q, getTaskTitle(task)).matched) return true;
	if (fuzzyScore(q, task.description).matched) return true;

	const seqStr = String(task.seq);
	if (seqStr.startsWith(qNormalized)) return true;

	if (task.id.toLowerCase().startsWith(q)) return true;

	if (prNumber != null) {
		const prStr = String(prNumber);
		if (prStr.startsWith(qNormalized)) return true;
		const qLower = q.replace(/^pr\s*/i, "");
		if (qLower && prStr.startsWith(qLower)) return true;
	}

	return false;
}

/**
 * Does a task match a token-DSL query? Applies facet AND (with within-facet
 * OR), then delegates the remaining free text to the fuzzy/identifier matcher.
 * A recognized facet whose value matches nothing correctly yields no results.
 */
export function matchesTaskQuery(task: Task, query: string, context: TaskQueryContext): boolean {
	const parsed = parseTaskQuery(query);

	for (const facet of FACET_KEYS) {
		const values = parsed.facets[facet];
		if (values.length === 0) continue;
		const def = FACET_DEFS[facet];
		if (!values.some((v) => def.match(context, v))) return false;
	}

	return matchesFreeText(task, parsed.freeText, context.prNumber);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonical token string for a facet value: bare, or double-quoted when the
 * value contains whitespace or a DSL metacharacter (`"`/`\`). Embedded quotes
 * and backslashes are escaped so the token always round-trips through the
 * parser (the funnel quotes/escapes for the user automatically).
 */
export function facetToken(facet: FacetKey, value: string): string {
	const quoted = /[\s"\\]/.test(value);
	return `${facet}:${quoted ? `"${escapeDslValue(value)}"` : value}`;
}

/**
 * Matches a specific facet token in the query in either bare or quoted form,
 * case-insensitively. Used for both the checked-state check and removal.
 */
function tokenMatcher(facet: FacetKey, value: string, global: boolean): RegExp {
	// Bare alternative matches a user-typed unquoted token; the quoted
	// alternative matches the canonical (DSL-escaped) serialization.
	const bare = escapeRegExp(value);
	const quoted = escapeRegExp(escapeDslValue(value));
	return new RegExp(`(^|\\s)${facet}:(?:"${quoted}"|${bare})(?=\\s|$)`, global ? "gi" : "i");
}

/**
 * Exact (case-insensitive) presence of a value's token in the query — the
 * checkbox/chip "checked" comparison. Deliberately NOT the substring filter
 * comparison: `label:"Bug Fix"` is checked, `label:bug` is not, even though
 * both would filter.
 */
export function isFacetTokenActive(query: string, facet: FacetKey, value: string): boolean {
	return tokenMatcher(facet, value, false).test(query);
}

/** Number of recognized facet tokens present — drives the funnel count badge. */
export function countActiveFacetTokens(query: string): number {
	const parsed = parseTaskQuery(query);
	return FACET_KEYS.reduce((sum, facet) => sum + parsed.facets[facet].length, 0);
}

/**
 * Toggle a facet token in the query string: append (auto-quoted) when absent,
 * remove every occurrence when present. Returns the new query string.
 */
export function toggleFacetToken(query: string, facet: FacetKey, value: string): string {
	if (isFacetTokenActive(query, facet, value)) {
		return query
			.replace(tokenMatcher(facet, value, true), " ")
			.replace(/\s+/g, " ")
			.trim();
	}
	const trimmed = query.trim();
	const token = facetToken(facet, value);
	return trimmed ? `${trimmed} ${token}` : token;
}
