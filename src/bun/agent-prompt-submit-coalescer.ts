/**
 * The held submit behind `dev3 message`: one pending Enter per agent pane, pushed
 * back by every further message typed into that same pane.
 *
 * Rules, all load-bearing:
 *  - ONE pending submit per pane, never a queue. Two Enters for two stacked
 *    messages would split the burst again, which is the whole defect.
 *  - The newest registration wins the closure, because it carries the freshest
 *    pane pin; the ceiling deadline stays with the FIRST unsubmitted text.
 *  - In-memory and deliberately not persisted. If the app dies inside the window
 *    the text sits unsubmitted in the agent's input box — the same place a partial
 *    delivery has always left it, and visible to the user.
 *
 * Only `dev3 message` (immediate and "Send later") coalesces. Button hand-offs —
 * Create PR, commit, rebase, bug-hunter prompts — keep their instant submit.
 */

import {
	AGENT_MESSAGE_SUBMIT_CEILING_MS,
	AGENT_MESSAGE_SUBMIT_IDLE_MS,
} from "../shared/agent-message-coalescing";
import { createLogger } from "./logger";

const log = createLogger("agent-prompt-submit-coalescer");

interface PendingSubmit {
	timer: ReturnType<typeof setTimeout>;
	/** When the first still-unsubmitted text landed — the ceiling is measured from it. */
	firstAt: number;
	submit: () => void | Promise<void>;
	context: Record<string, string>;
}

const pending = new Map<string, PendingSubmit>();

/** The pane a submit is held for. Two backends can name the same pane id. */
export function agentPromptSubmitKey(backend: "tmux" | "native", taskId: string, paneId: string): string {
	return `${backend}:${taskId}:${paneId}`;
}

/**
 * Hold `submit` for this pane until the traffic into it goes quiet, and report how
 * long that will be. Replaces any submit already pending for the same pane, so a
 * burst of messages ends in exactly one Enter.
 */
export function coalesceAgentPromptSubmit(
	key: string,
	submit: () => void | Promise<void>,
	context: Record<string, string>,
): number {
	const now = Date.now();
	const existing = pending.get(key);
	if (existing) clearTimeout(existing.timer);
	const firstAt = existing?.firstAt ?? now;
	// Clamped to the ceiling, never past it: a stream of senders may keep pushing the
	// idle timer, but it cannot push the deadline the first text started.
	const delay = Math.max(0, Math.min(AGENT_MESSAGE_SUBMIT_IDLE_MS, firstAt + AGENT_MESSAGE_SUBMIT_CEILING_MS - now));
	const entry: PendingSubmit = {
		firstAt,
		submit,
		context,
		timer: setTimeout(() => fire(key, entry, context), delay),
	};
	pending.set(key, entry);
	log.info("agent prompt submit held", { ...context, delayMs: String(delay), heldForMs: String(now - firstAt) });
	return delay;
}

/**
 * A human typed into one of this task's terminals — push every submit held for that
 * task back by a full idle window, so the Enter never lands mid-word.
 *
 * Task-wide, not per-pane, on purpose: a tmux client types into whichever pane is
 * active, so the keystrokes carry no pane of their own. The ceiling is untouched —
 * someone typing without pause still cannot hold a message hostage past it.
 *
 * Returns how many held submits were pushed back.
 */
export function deferAgentPromptSubmitsForTask(taskId: string): number {
	if (pending.size === 0) return 0;
	const now = Date.now();
	let deferred = 0;
	for (const [key, entry] of pending) {
		if (key.split(":")[1] !== taskId) continue;
		clearTimeout(entry.timer);
		const delay = Math.max(
			0,
			Math.min(AGENT_MESSAGE_SUBMIT_IDLE_MS, entry.firstAt + AGENT_MESSAGE_SUBMIT_CEILING_MS - now),
		);
		entry.timer = setTimeout(() => fire(key, entry, entry.context), delay);
		deferred += 1;
		log.info("agent prompt submit deferred by human typing", {
			...entry.context,
			delayMs: String(delay),
			heldForMs: String(now - entry.firstAt),
		});
	}
	return deferred;
}

function fire(key: string, entry: PendingSubmit, context: Record<string, string>): void {
	// A newer registration may already own this pane; only the current entry may fire.
	if (pending.get(key) !== entry) return;
	pending.delete(key);
	try {
		void Promise.resolve(entry.submit()).catch((err) =>
			log.warn("held agent prompt submit failed", { ...context, error: String(err) }),
		);
	} catch (err) {
		log.warn("held agent prompt submit threw", { ...context, error: String(err) });
	}
}

/** How many panes are holding a submit right now (tests and diagnostics). */
export function pendingAgentPromptSubmitCount(): number {
	return pending.size;
}

/** Drop every pending submit without firing it (tests). */
export function resetAgentPromptSubmits(): void {
	for (const entry of pending.values()) clearTimeout(entry.timer);
	pending.clear();
}
