import type { TaskStatus } from "./task-status";
import type { TaskMovement } from "./task-notes";

// ---- Productivity stats ----

/**
 * One per-task record returned by `getProductivityStats`. The renderer buckets
 * and aggregates these client-side per the selected time range (so range
 * switching needs no round-trip). All timestamps are ISO 8601.
 */
export interface ProductivityStatEvent {
	taskId: string;
	/** Per-project sequential id, as `dev3 task show <seq>` takes it. */
	seq: number;
	projectId: string;
	projectName: string;
	projectKind: "git" | "virtual";
	title: string;
	status: TaskStatus;
	/** Task creation time. */
	createdAt: string;
	/**
	 * Time the task last changed status. For terminal statuses (completed /
	 * cancelled) this equals the completion/cancellation time — the field the
	 * dashboard uses to bucket "tasks completed over time". Null when unknown.
	 */
	movedAt: string | null;
	/**
	 * ISO timestamp of the current delivery cycle's first `in-progress` move.
	 * Null for tasks that completed before lifetime tracking existed.
	 */
	lifecycleStartedAt: string | null;
	insertions: number;
	deletions: number;
	files: number;
	/** True when LOC was computed live from an active worktree (not the captured snapshot). */
	liveStats: boolean;
	agentId: string | null;
	groupId: string | null;
	variantIndex: number | null;
	/** ISO time the task entered its current status ({@link Task.statusEnteredAt}); null on legacy tasks. */
	statusEnteredAt: string | null;
	/** Idle-gated real UI attention time in ms ({@link Task.focusMs}); 0 when untracked. */
	focusMs: number;
	/** {@link Task.focusByHour}; `{}` before per-hour focus was recorded. */
	focusByHour: Record<string, number>;
	/** {@link Task.movements} slimmed to what period accounting needs; `[]` on legacy tasks. */
	movements: Array<Pick<TaskMovement, "at" | "to">>;
	/** {@link Task.movementsDropped} — older moves evicted by the cap, so history before the first kept one is unknown. */
	movementsDropped: number;
	/** {@link Task.hibernated} — the agent is gone though the card may sit in an agent column. */
	hibernated: boolean;
	/** Launch preset id used by the task's agent, or null when no preset was recorded. */
	configId: string | null;
}

export interface ProductivityStats {
	events: ProductivityStatEvent[];
	/** ISO time the stats were generated (server clock). */
	generatedAt: string;
}

// ---- Agent usage (tokens & cost) ----

/** Which coding agent a usage row was parsed from. */
export type AgentUsageSource = "claude" | "codex" | "gemini" | "cursor" | "copilot" | "opencode" | "pi" | "omp";

/**
 * One agent's token usage for a single local calendar day, as reconstructed from
 * on-disk agent state or content-free usage hooks.
 * The renderer buckets these client-side per the selected dashboard range.
 */
export interface AgentUsageDay {
	/** Local calendar day, YYYY-MM-DD. */
	date: string;
	/** Local-midnight epoch ms for `date` — lets the renderer filter by the dashboard period window. */
	startMs: number;
	source: AgentUsageSource;
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
	/** API-equivalent cost in USD (what per-token API billing *would* cost; subscription-subsidised in reality). */
	costUsd: number;
	/** True if every model seen on this day had a known price; false means costUsd under-counts. */
	fullyPriced: boolean;
}

export interface AgentUsageReport {
	days: AgentUsageDay[];
	/** ISO time the report was generated (server clock). */
	generatedAt: string;
	/** True if some parsed usage referenced a model with no known price (costUsd is a lower bound). */
	hasUnpricedModels: boolean;
	/** Every raw model id seen in the retained usage, distinct and sorted. */
	models: string[];
}
