// ---- Keep alive (auto-revive watchdog) ----

/** Watchdog runtime status for a kept-alive task; drives the card marker tone. */
export type KeepAliveRuntimeStatus = "watching" | "reviving" | "gave-up";

/** Why the watchdog last acted on a task; shown in the marker tooltip. */
export type KeepAliveVerdict =
	| "healthy"
	| "revived"
	| "rate-limited"
	| "unresumable"
	| "history-unreadable"
	| "error"
	| "gave-up";

/**
 * Per-task "keep alive" state — the user's opt-in to have dev3 auto-revive this
 * task's agent conversation when it dies (process exited, usage/rate limit hit,
 * or a network/proxy error killed it). A property of the task, in the same class
 * as {@link Task.draft} / {@link Task.hibernated}: it is **never a column, a kind,
 * or an action**, and it is inert on its own — only the bun watchdog scheduler
 * reads it, and only for a task whose agent should be running. Absent/null on
 * every pre-existing task, so older app versions reading the same `tasks.json`
 * simply ignore it.
 *
 * Only {@link enabled} is the durable user choice; the rest is watchdog
 * bookkeeping, refreshed each tick and safe to lose on restart.
 */
export interface KeepAliveState {
	/** The user opted this task into auto-revive. */
	enabled: boolean;
	/** Watchdog runtime status. Absent means "watching" (freshly enabled). */
	status?: KeepAliveRuntimeStatus;
	/** Consecutive revive attempts since the task was last seen healthy; reset to 0 on a healthy tick. */
	attempts?: number;
	/** ISO timestamp of the last revive attempt. */
	lastAttemptAt?: string | null;
	/** Epoch ms before which the watchdog will not attempt again (backoff, or a known rate-limit reset). */
	nextAttemptAt?: number | null;
	/** Why the watchdog last acted. */
	lastVerdict?: KeepAliveVerdict | null;
	/** One-line human reason the watchdog gave up, for the attention badge / marker tooltip. */
	gaveUpReason?: string | null;
}
