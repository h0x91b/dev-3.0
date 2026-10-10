/**
 * Per-task Claude session stats - pure parsing shared by the CLI (`dev3 statusline`
 * writes the raw payload per task), the bun monitor (parses and attaches task
 * identity) and the renderer (the usage panel's attention strip and the Sessions screen).
 */

export interface ClaudeSessionCacheStats {
	warm: boolean;
	/** Cache TTL as reported by Claude Code, e.g. "5m" or "1h". */
	ttl: string | null;
	/** When a warm cache expires (epoch ms). */
	expiresAt: number | null;
	/** Claude Code's `prompt_cache.hit_ratio`, 0-1. A token share, not a request share:
	 *  a live payload had 22 requests, 0 misses and a 0.96 ratio. */
	hitRatio: number | null;
	misses: number | null;
}

export interface ClaudeSessionStats {
	taskId: string;
	/** Filled in by the bun monitor from the board; null when the task is unknown. */
	taskTitle: string | null;
	taskSeq: number | null;
	projectName: string | null;
	projectId?: string | null;
	/** The task waits on the user (questions or user review), so an expiring cache is theirs to save. */
	awaitingUser?: boolean;
	capturedAt: number;
	model: string | null;
	effort: string | null;
	/** Claude Code's session name (`/rename`), when set. */
	sessionName: string | null;
	thinking: boolean | null;
	contextPercent: number | null;
	contextWindowSize: number | null;
	/** Current context size: input plus output tokens. */
	totalTokens: number | null;
	/** Last request's tokens read from / written to the prompt cache. */
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	/** Fresh (uncached) input and output tokens of the last request. */
	turnInputTokens: number | null;
	turnOutputTokens: number | null;
	cache: ClaudeSessionCacheStats | null;
	costUsd: number | null;
	durationMs: number | null;
	apiDurationMs: number | null;
	linesAdded: number | null;
	linesRemoved: number | null;
}

/** Sessions older than this drop out - a prompt cache lives at most an hour. */
export const SESSION_STATS_RECENT_MS = 6 * 60 * 60 * 1000;
/** The usage panel's attention strip never grows past this, however many tasks run. */
export const MAX_ATTENTION_SESSIONS = 3;
/** Context at or above this share needs attention: auto-compact is close. */
export const CONTEXT_ATTENTION_PERCENT = 85;
/** A warm cache expiring within this window, while the task waits on the user, needs attention. */
export const CACHE_EXPIRY_ATTENTION_MS = 5 * 60 * 1000;

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v : null;
}

/** Parse a Claude Code statusLine payload into session stats. Null when it carries
 *  nothing session-shaped (no model and no context window). */
export function parseClaudeSessionStats(payload: unknown, taskId: string, capturedAt: number): ClaudeSessionStats | null {
	const root = asRecord(payload);
	if (!root) return null;
	const model = asRecord(root.model);
	const ctx = asRecord(root.context_window);
	if (!model && !ctx) return null;
	const usage = asRecord(ctx?.current_usage);
	const cost = asRecord(root.cost);
	const pc = asRecord(root.prompt_cache);
	const inTok = num(ctx?.total_input_tokens);
	const outTok = num(ctx?.total_output_tokens);
	const expiresSec = num(pc?.expires_at);
	const thinkingEnabled = asRecord(root.thinking)?.enabled;
	return {
		taskId,
		taskTitle: null,
		taskSeq: null,
		projectName: null,
		capturedAt,
		model: str(model?.display_name) ?? str(model?.id),
		effort: str(asRecord(root.effort)?.level),
		sessionName: str(root.session_name),
		thinking: typeof thinkingEnabled === "boolean" ? thinkingEnabled : null,
		contextPercent: num(ctx?.used_percentage),
		contextWindowSize: num(ctx?.context_window_size),
		totalTokens: inTok == null && outTok == null ? null : (inTok ?? 0) + (outTok ?? 0),
		cacheReadTokens: num(usage?.cache_read_input_tokens),
		cacheWriteTokens: num(usage?.cache_creation_input_tokens),
		turnInputTokens: num(usage?.input_tokens),
		turnOutputTokens: num(usage?.output_tokens),
		cache:
			pc && typeof pc.warm === "boolean"
				? {
						warm: pc.warm,
						ttl: str(pc.ttl),
						expiresAt: expiresSec != null ? expiresSec * 1000 : null,
						hitRatio: num(pc.hit_ratio),
						misses: num(pc.misses),
					}
				: null,
		costUsd: num(cost?.total_cost_usd),
		durationMs: num(cost?.total_duration_ms),
		apiDurationMs: num(cost?.total_api_duration_ms),
		linesAdded: num(cost?.total_lines_added),
		linesRemoved: num(cost?.total_lines_removed),
	};
}

/** A warm cache whose expiry has passed is cold, whatever the last refresh said. */
export function isSessionCacheWarm(cache: ClaudeSessionCacheStats, nowMs: number): boolean {
	return cache.warm && (cache.expiresAt == null || cache.expiresAt > nowMs);
}

/** Compact token count: 950, 12.3k, 1.2M. */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(Math.round(n));
}

/** Session cost like the statusline: more decimals while it is still small. */
export function formatCostUsd(usd: number): string {
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 1) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

/** Compact duration: 45s, 12m, 2h5m. */
export function formatDurationMs(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

export type SessionAttentionReason = "cacheExpiring" | "context";

/**
 * Why a session needs the user now, or null. A warm 5m cache is always "under 5
 * minutes from expiry", so expiry counts only while the task waits on the user -
 * a working agent refreshes its own cache.
 */
export function sessionAttention(session: ClaudeSessionStats, nowMs: number): SessionAttentionReason | null {
	const cache = session.cache;
	if (
		session.awaitingUser &&
		cache?.expiresAt != null &&
		isSessionCacheWarm(cache, nowMs) &&
		cache.expiresAt - nowMs <= CACHE_EXPIRY_ATTENTION_MS
	) {
		return "cacheExpiring";
	}
	if (session.contextPercent != null && session.contextPercent >= CONTEXT_ATTENTION_PERCENT) return "context";
	return null;
}

/** The attention strip: soonest cache expiry first, then fullest context, capped. */
export function attentionSessions(sessions: readonly ClaudeSessionStats[], nowMs: number): ClaudeSessionStats[] {
	const flagged = sessions.filter((s) => sessionAttention(s, nowMs) != null);
	return sortSessions(flagged, "attention", "asc", nowMs).slice(0, MAX_ATTENTION_SESSIONS);
}

export interface SessionsSummary {
	count: number;
	warm: number;
	/** Null when no session reported a cost. */
	costUsd: number | null;
}

export function summarizeSessions(sessions: readonly ClaudeSessionStats[], nowMs: number): SessionsSummary {
	let warm = 0;
	let costUsd: number | null = null;
	for (const s of sessions) {
		if (s.cache && isSessionCacheWarm(s.cache, nowMs)) warm++;
		if (s.costUsd != null) costUsd = (costUsd ?? 0) + s.costUsd;
	}
	return { count: sessions.length, warm, costUsd };
}

export const SESSION_SORT_KEYS = ["attention", "task", "project", "context", "cache", "cost", "model", "updated"] as const;
export type SessionSortKey = (typeof SESSION_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

/** The direction a column sorts in on its first click: the "worst" or newest on top. */
export function defaultSortDirection(key: SessionSortKey): SortDirection {
	return key === "task" || key === "project" || key === "model" || key === "cache" || key === "attention" ? "asc" : "desc";
}

/** Attention order as one number: expiring caches by expiry, then high context
 *  fullest first, then everything else. Epoch ms stays far below the offsets. */
function attentionValue(session: ClaudeSessionStats, nowMs: number): number {
	const reason = sessionAttention(session, nowMs);
	if (reason === "cacheExpiring") return session.cache!.expiresAt!;
	if (reason === "context") return 1e14 - (session.contextPercent ?? 0);
	return 2e14;
}

/** Seconds until a warm cache expires; cold or unknown sorts last. */
function cacheSortValue(session: ClaudeSessionStats, nowMs: number): number {
	const cache = session.cache;
	if (!cache || !isSessionCacheWarm(cache, nowMs)) return Number.POSITIVE_INFINITY;
	return cache.expiresAt ?? Number.MAX_SAFE_INTEGER;
}

/** Sort a copy. Missing values sort last in either direction; ties fall back to newest first. */
export function sortSessions(
	sessions: readonly ClaudeSessionStats[],
	key: SessionSortKey,
	direction: SortDirection,
	nowMs: number,
): ClaudeSessionStats[] {
	const value = (s: ClaudeSessionStats): string | number | null => {
		switch (key) {
			case "attention":
				return attentionValue(s, nowMs);
			case "task":
				return s.taskTitle?.toLocaleLowerCase() ?? null;
			case "project":
				return s.projectName?.toLocaleLowerCase() ?? null;
			case "context":
				return s.contextPercent;
			case "cache": {
				const v = cacheSortValue(s, nowMs);
				return Number.isFinite(v) ? v : null;
			}
			case "cost":
				return s.costUsd;
			case "model":
				return s.model?.toLocaleLowerCase() ?? null;
			case "updated":
				return s.capturedAt;
		}
	};
	const sign = direction === "asc" ? 1 : -1;
	return [...sessions].sort((a, b) => {
		const va = value(a);
		const vb = value(b);
		if (va == null || vb == null) {
			if (va != null) return -1;
			if (vb != null) return 1;
		} else if (va !== vb) {
			return (va < vb ? -1 : 1) * sign;
		}
		return b.capturedAt - a.capturedAt;
	});
}
