/**
 * What a caller learns after handing a prompt to a task's agent. Four answers, never
 * fewer: collapsing "cannot prove" into either neighbour is the defect the pane-input
 * seam exists to remove (decision 201), and collapsing "not typed yet, on purpose"
 * into "sent" would tell a sender its message is being read while it still sits in
 * dev3's memory.
 */

import type { PaneInputOutcome } from "./pane-input";

/**
 * - `delivered` — the backend accepted every step. Only tmux can say this; the native
 *   host cannot acknowledge input yet, so it never does (decision 201).
 * - `held` — accepted by dev3 and NOTHING was typed: a `dev3 message` waits for the
 *   pane to go quiet before it lands (`src/bun/agent-message-hold.ts`). Not a failure
 *   and never re-send it — it is queued, and a second copy would arrive as well.
 * - `unconfirmed` — input may or may not have landed. NOT a failure: re-sending is a
 *   double submit into a live agent, which is worse than either answer alone.
 * - `not-delivered` — nothing was sent, proven. Safe to report as a failure and safe
 *   to send again.
 */
export type AgentPromptDeliveryStatus = "delivered" | "held" | "unconfirmed" | "not-delivered";

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

/**
 * The verdict of a message dev3 accepted but has not typed yet: it lands when the pane
 * goes quiet. `delayMs` is the wait promised at that moment, so the prose quotes the
 * clock the hold is actually running rather than a restated constant.
 */
export function agentPromptHeld(delayMs: number): AgentPromptDelivery {
	return {
		status: "held",
		detail: `held until the pane goes quiet (about ${Math.round(delayMs / 1000)}s, longer while the user types)`,
	};
}

/**
 * Whether the input may reach the agent without another send — the test a caller must
 * use before re-sending. `held` counts: it has not landed YET, but it will, and a
 * second copy would arrive too.
 */
export function agentPromptMayHaveLanded(delivery: AgentPromptDelivery): boolean {
	return delivery.status !== "not-delivered";
}
