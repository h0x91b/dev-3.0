import type { TaskStatus } from "./task-status";

// ---- Column Agents ----

export interface ColumnAgentConfig {
	agentId: string; // e.g. "builtin-claude"
	configId: string; // e.g. "claude-auto-opus5-xhigh"
	prompt: string; // prompt sent to the agent
}

/** Agent + preset the "AI Review" column runs when a project never configured one. */
export const DEFAULT_REVIEW_AGENT_ID = "builtin-claude";
export const DEFAULT_REVIEW_CONFIG_ID = "claude-auto-opus5-xhigh";

export function getPrimaryStopTarget(autoReviewEnabled?: boolean): TaskStatus {
	return autoReviewEnabled ? "review-by-ai" : "review-by-user";
}

/**
 * A column-agent launch failure the app recognises and can explain in the user's
 * own language. Carried as a stable code so the renderer never has to read the
 * English `error` string; anything unrecognised has no reason and falls back to
 * showing that string as diagnostics.
 */
export type ColumnAgentFailureReason = "terminal-not-running";

/**
 * Which column's agent this is, in a form the UI can name in the user's language.
 * A built-in column travels as its status (the renderer localizes it); only a
 * custom column, whose name the user typed, travels as a literal string.
 */
export type ColumnAgentIdentity =
	| { kind: "builtin"; status: TaskStatus }
	| { kind: "custom"; name: string };
