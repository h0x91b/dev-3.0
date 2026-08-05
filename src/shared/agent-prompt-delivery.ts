/**
 * What a caller learns after handing a prompt to a task's agent. Three answers, never
 * two: collapsing "cannot prove" into either neighbour is the defect the pane-input
 * seam exists to remove (decision 201).
 */

import type { PaneInputOutcome } from "./pane-input";

/**
 * - `delivered` — the backend accepted every step. Only tmux can say this; the native
 *   host cannot acknowledge input yet, so it never does (decision 201).
 * - `unconfirmed` — input may or may not have landed. NOT a failure: re-sending is a
 *   double submit into a live agent, which is worse than either answer alone.
 * - `not-delivered` — nothing was sent, proven. Safe to report as a failure and safe
 *   to send again.
 */
export type AgentPromptDeliveryStatus = "delivered" | "unconfirmed" | "not-delivered";

export interface AgentPromptDelivery {
	readonly status: AgentPromptDeliveryStatus;
	/**
	 * The pane-input reason behind the status, where one exists. Carried verbatim so
	 * `pane-absent` and `pane-dead` stay distinguishable in logs even though both are
	 * `not-delivered` to every caller today.
	 */
	readonly reason?: string;
	readonly detail?: string;
}

/**
 * Map one pane-input verdict onto the caller vocabulary.
 *
 * `partial` joins `indeterminate` rather than `not-delivered`: a clean stop after the
 * text stage leaves that text sitting in the agent's input box, so a caller that
 * re-sent would submit it twice.
 */
export function agentPromptDeliveryFromPaneInput(outcome: PaneInputOutcome): AgentPromptDelivery {
	if (outcome.status === "delivered") return { status: "delivered" };
	const detail = outcome.detail;
	return {
		status: outcome.status === "not-started" ? "not-delivered" : "unconfirmed",
		reason: outcome.reason,
		...(detail === undefined ? {} : { detail }),
	};
}

/** Whether input may have reached the agent — the test a caller must use before re-sending. */
export function agentPromptMayHaveLanded(delivery: AgentPromptDelivery): boolean {
	return delivery.status !== "not-delivered";
}
