/**
 * How long an agent-initiated launch waits, after approval, for the launched
 * task's preparation to settle before answering the CLI. Past it the reply says
 * "still preparing" instead of claiming a start nobody has seen yet.
 */
export const LAUNCH_PREPARATION_REPORT_BUDGET_MS = 3 * 60 * 1000;

/** How a launched task's preparation ended, as reported back to the requesting CLI. */
export type LaunchPreparationOutcome =
	| { state: "started" }
	| { state: "failed"; error: string }
	| { state: "still-preparing" };
