/**
 * The held `dev3 message`: the WHOLE message — its text and its Enter — waits for the
 * pane to go quiet, so nothing an agent sends is typed into the middle of the line the
 * user is writing (issue #1495).
 *
 * Rules, all load-bearing:
 *  - Nothing reaches the pane before the hold releases. The text used to go in the
 *    moment it arrived and only the Enter was held, which is exactly how a peer's
 *    message got mixed into a half-written prompt.
 *  - ONE hold per pane, never a queue of Enters. Several messages stack their TEXTS
 *    in arrival order and end in exactly one Enter; two Enters for two stacked
 *    messages would split the burst again, which is the original defect.
 *  - The newest registration wins the submit closure, because it carries the freshest
 *    pane pin; the ceiling deadline stays with the FIRST undelivered message.
 *  - A MESSAGE-driven hold keeps the ceiling; a HUMAN-driven one has none. A stream of
 *    senders cannot hold a receiver hostage, but the user's own typing outranks every
 *    deadline — his hold ends with his Enter or with his silence, never with a clock.
 *  - The user's own plain Enter releases the hold at once: he submitted his line, so
 *    the input box is no longer his and he should watch the message arrive.
 *  - No Enter is sent when no text landed — an Enter into an unknown input box would
 *    submit whatever is sitting in it.
 *  - In-memory and deliberately not persisted. If the app dies inside the window the
 *    message is LOST, and nothing is left in the input box either. Accepted; see
 *    `decisions/2026/08/23/hold-the-agent-message-not-just-its-enter.md`.
 *
 * Only `dev3 message` (immediate and "Send later") is held. Button hand-offs — Create
 * PR, commit, rebase, bug-hunter prompts — type and submit at once.
 */

import { AGENT_MESSAGE_HOLD_CEILING_MS, AGENT_MESSAGE_HOLD_IDLE_MS } from "../shared/agent-message-hold-timing";
import { createLogger } from "./logger";

const log = createLogger("agent-message-hold");

/** One message waiting for a pane: how to type it, and how to submit the burst. */
export interface HeldAgentMessage {
	/** Types this message's text. True when it provably landed. */
	deliver: () => boolean | Promise<boolean>;
	/** The single Enter that ends the whole burst. */
	submit: () => void | Promise<void>;
}

interface Hold {
	timer: ReturnType<typeof setTimeout> | null;
	/** When the first still-undelivered message landed — the ceiling is measured from it. */
	firstAt: number;
	/** Set by the first human keystroke that pushed this hold back; the ceiling then stops applying. */
	humanHeld: boolean;
	/** Every message waiting for this pane, in arrival order. */
	deliveries: HeldAgentMessage["deliver"][];
	submit: HeldAgentMessage["submit"];
	context: Record<string, string>;
}

const holds = new Map<string, Hold>();

/** The pane a message is held for. Two backends can name the same pane id. */
export function agentMessageHoldKey(backend: "tmux" | "native", taskId: string, paneId: string): string {
	return `${backend}:${taskId}:${paneId}`;
}

function taskOfKey(key: string): string | undefined {
	return key.split(":")[1];
}

function delayFor(hold: Hold, now: number): number {
	// A human at the keyboard gets the full window every time, with no deadline
	// behind it — see the ceiling constant's own comment.
	if (hold.humanHeld) return AGENT_MESSAGE_HOLD_IDLE_MS;
	return Math.max(0, Math.min(AGENT_MESSAGE_HOLD_IDLE_MS, hold.firstAt + AGENT_MESSAGE_HOLD_CEILING_MS - now));
}

function rearm(key: string, hold: Hold, now: number): number {
	if (hold.timer) clearTimeout(hold.timer);
	const delay = delayFor(hold, now);
	hold.timer = setTimeout(() => void release(key, hold), delay);
	return delay;
}

/**
 * Hold `message` for this pane until the traffic into it goes quiet, and report how
 * long that will be. Joins the hold already waiting for the same pane, so a burst of
 * messages lands as one paste sequence ended by exactly one Enter.
 */
export function holdAgentMessage(key: string, message: HeldAgentMessage, context: Record<string, string>): number {
	const now = Date.now();
	const existing = holds.get(key);
	const hold: Hold = existing ?? {
		timer: null,
		firstAt: now,
		humanHeld: false,
		deliveries: [],
		submit: message.submit,
		context,
	};
	hold.deliveries.push(message.deliver);
	hold.submit = message.submit;
	hold.context = context;
	holds.set(key, hold);
	const delay = rearm(key, hold, now);
	log.info("agent message held", {
		...context,
		delayMs: String(delay),
		heldForMs: String(now - hold.firstAt),
		waiting: String(hold.deliveries.length),
		humanHeld: String(hold.humanHeld),
	});
	return delay;
}

/**
 * A human typed into one of this task's terminals — push every message held for that
 * task back by a full idle window, and drop the ceiling for it.
 *
 * Task-wide, not per-pane, on purpose: a tmux client types into whichever pane is
 * active, so the keystrokes carry no pane of their own.
 *
 * Returns how many holds were pushed back.
 */
export function deferHeldAgentMessagesForTask(taskId: string): number {
	if (holds.size === 0) return 0;
	const now = Date.now();
	let deferred = 0;
	for (const [key, hold] of holds) {
		if (taskOfKey(key) !== taskId) continue;
		hold.humanHeld = true;
		const delay = rearm(key, hold, now);
		deferred += 1;
		log.info("agent message deferred by human typing", {
			...hold.context,
			delayMs: String(delay),
			heldForMs: String(now - hold.firstAt),
		});
	}
	return deferred;
}

/**
 * The user submitted his own line — deliver everything held for this task NOW, so he
 * sees the message arrive instead of wondering where it went. Returns how many holds
 * were released.
 */
export function flushHeldAgentMessagesForTask(taskId: string): number {
	if (holds.size === 0) return 0;
	let flushed = 0;
	for (const [key, hold] of [...holds]) {
		if (taskOfKey(key) !== taskId) continue;
		log.info("agent message released by the user's own submit", hold.context);
		void release(key, hold);
		flushed += 1;
	}
	return flushed;
}

/**
 * Type every message this hold gathered, in arrival order, then submit them as one
 * turn. A message that arrives while this is running starts a fresh hold — the pane is
 * mid-delivery, so joining it could interleave two pastes.
 */
async function release(key: string, hold: Hold): Promise<void> {
	// A newer hold may already own this pane; only the current one may release.
	if (holds.get(key) !== hold) return;
	holds.delete(key);
	if (hold.timer) clearTimeout(hold.timer);

	let landed = false;
	for (const deliver of hold.deliveries) {
		try {
			if (await deliver()) landed = true;
		} catch (err) {
			log.warn("held agent message text failed", { ...hold.context, error: String(err) });
		}
	}
	if (!landed) {
		log.warn("held agent message landed nowhere; sending no Enter", hold.context);
		return;
	}
	try {
		await hold.submit();
	} catch (err) {
		log.warn("held agent message submit failed", { ...hold.context, error: String(err) });
	}
}

/** How many panes are holding a message right now (tests and diagnostics). */
export function pendingAgentMessageHoldCount(): number {
	return holds.size;
}

/** Drop every held message without delivering it (tests). */
export function resetAgentMessageHolds(): void {
	for (const hold of holds.values()) if (hold.timer) clearTimeout(hold.timer);
	holds.clear();
}
