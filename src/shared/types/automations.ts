// ---- Automations (scheduled agent runs) ----

export type AutomationRunStatus = "created" | "failed" | "missed";

/** One record in an automation's bounded run history (newest first). */
export interface AutomationRun {
	id: string;
	/** ISO time of the RRULE occurrence this run satisfies (or the manual-run click time). */
	scheduledFor: string;
	/** ISO time the run actually fired; null for `missed` entries. */
	firedAt: string | null;
	status: AutomationRunStatus;
	/** The created task, when status is `created`. */
	taskId?: string | null;
	/** Failure detail, when status is `failed`. */
	error?: string | null;
	/** True when the run was triggered manually ("Run now" / `dev3 automations run`). */
	manual?: boolean;
}

/** What to do with occurrences that were missed while the app was offline. */
export type AutomationCatchUpPolicy = "skip" | "runOnce";

/**
 * A per-project scheduled agent run: an RFC 5545 RRULE subset + IANA timezone +
 * a stored prompt + an agent choice. Each fire creates an ORDINARY task
 * (worktree + tmux + agent, prompt = task description) on the board. Persisted
 * in `~/.dev3.0/data/<slug>/automations.json` (additive parallel file — older
 * app versions never read it).
 */
export interface Automation {
	id: string;
	projectId: string;
	name: string;
	/** The task description the created task gets — i.e. the agent's initial prompt. */
	prompt: string;
	/** RRULE subset string, e.g. `FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0`. See shared/rrule.ts. */
	rrule: string;
	/** IANA timezone the RRULE wall-clock times are evaluated in. */
	timezone: string;
	agentId: string | null;
	configId: string | null;
	enabled: boolean;
	catchUp: AutomationCatchUpPolicy;
	createdAt: string;
	updatedAt: string;
	/**
	 * Next occurrence (ISO, UTC) this automation should fire at — computed from
	 * the RRULE and persisted so an app restart can tell scheduled-from-missed
	 * apart. Null when disabled or the rule yields nothing.
	 */
	nextRunAt: string | null;
	/** Bounded run history, newest first. Capped at {@link MAX_AUTOMATION_RUNS_KEPT}. */
	runs: AutomationRun[];
}

/** Run-history retention per automation (newest kept). */
export const MAX_AUTOMATION_RUNS_KEPT = 20;

/** Fields accepted by the createAutomation / updateAutomation RPCs. */
export interface AutomationDraft {
	name: string;
	prompt: string;
	rrule: string;
	timezone: string;
	agentId?: string | null;
	configId?: string | null;
	enabled?: boolean;
	catchUp?: AutomationCatchUpPolicy;
}
