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
 *  - Every message after the first is typed behind a blank line. An envelope ends
 *    without a newline, so a burst used to reach the receiver as
 *    `</dev3-ai-message><dev3-ai-message>` on one line, with no boundary between two
 *    senders' reports (issue #1608).
 *  - The newest registration wins the submit closure, because it carries the freshest
 *    pane pin; the ceiling deadline stays with the FIRST undelivered message.
 *  - A MESSAGE-driven hold keeps the ceiling; a HUMAN-driven one has none, and its quiet
 *    window is four times longer, because a pause to think is part of writing a line. A
 *    stream of senders cannot hold a receiver hostage, but the user's own typing
 *    outranks every deadline — his hold ends with his Enter or with a long silence.
 *  - The user's own plain Enter releases the hold at once: he submitted his line, so
 *    the input box is no longer his and he should watch the message arrive.
 *  - No Enter is sent when no text landed — an Enter into an unknown input box would
 *    submit whatever is sitting in it.
 *  - A pane the user scrolled up (tmux copy mode) DEFERS the hold instead of dropping
 *    it: whatever was refused stays held, retried every quiet window, and nothing
 *    forces the pane out of its mode. Only the pane going away ends such a hold.
 *  - A turn whose text landed but whose Enter could not follow is STRANDED: dev3 never
 *    presses Enter on it, because the user may have typed a draft behind it. Only the
 *    agent's own prompt-submit hook reporting a submission that contains every landed
 *    text releases it (a raw keystroke Enter does not: it may have hit copy mode, a
 *    picker, or another pane). Until then later messages wait behind it, the pane is
 *    probed each quiet window, and a gone pane drops it — both said out loud.
 *  - Putting anything back never overwrites a hold that started meanwhile; the
 *    leftovers go in front of it, so arrival order survives.
 *  - In-memory and deliberately not persisted. If the app dies inside the window the
 *    message is LOST, and nothing is left in the input box either. Accepted; see
 *    `decisions/2026/08/23/hold-the-agent-message-not-just-its-enter.md`.
 *
 * Only `dev3 message` (immediate and "Send later") is held. Button hand-offs — Create
 * PR, commit, rebase, bug-hunter prompts — type and submit at once.
 */

import { AGENT_MESSAGE_BURST_SEPARATOR } from "../shared/agent-message-envelope";
import { submissionMatchesTypedText } from "../shared/agent-terminal-prompt";
import { AGENT_MESSAGE_SPILL_THRESHOLD_BYTES } from "../shared/types";
import { utf8Length } from "../shared/pane-input";
import {
	AGENT_MESSAGE_HOLD_CEILING_MS,
	AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS,
	AGENT_MESSAGE_HOLD_IDLE_MS,
} from "../shared/agent-message-hold-timing";
import { createLogger } from "./logger";

const log = createLogger("agent-message-hold");

/**
 * What one typing step did: `landed`, `deferred` (the pane is only scrolled up, nothing
 * was sent, try again later) or `failed` (nothing to wait for).
 */
export type HeldDeliveryResult = "landed" | "deferred" | "failed";

/** What the hold tells whoever is watching the pane, so a stuck or lost message is never silent. */
export type HeldAgentMessageReport =
	| { kind: "stranded"; waiting: number }
	| { kind: "dropped"; messages: number; why: string };

/** One message waiting for a pane: how to type it, how big it is, and how to submit the burst. */
export interface HeldAgentMessage {
	/** The message's own text, without separator — what a submission must contain to release a stranded turn. */
	text: string;
	/**
	 * Types this message's text, prefixed by `separator`. The hold passes the empty
	 * string to the message that opens a burst and
	 * {@link AGENT_MESSAGE_BURST_SEPARATOR} to every one after it: position in the
	 * burst is knowable here and nowhere else.
	 */
	deliver: (separator: string) => HeldDeliveryResult | Promise<HeldDeliveryResult>;
	/**
	 * UTF-8 bytes this message types. The receiving CLI chunks what ONE pty read hands
	 * it, not what one paste contained, so three messages released together are one
	 * stream to it — and the cap that keeps a single message inside one read means
	 * nothing unless the burst obeys it too. See {@link release}.
	 */
	bytes: number;
	/**
	 * Optional trailer typed ONCE after the whole burst, just before the Enter —
	 * the coordinator's board snapshot. It belongs here rather than on each
	 * message for both reasons that matter: a burst is one agent turn and must
	 * carry one snapshot, and the text is built at release time, so a message
	 * that waited a full minute still ends on a board that is seconds old.
	 *
	 * `budgetBytes` is what is left of one pty read after the messages. A trailer
	 * that does not fit is dropped by the adapter: a stale board costs a snapshot,
	 * a split stream can cost the messages themselves.
	 */
	epilogue?: (budgetBytes: number) => boolean | Promise<boolean>;
	/** The single Enter that ends the whole burst. */
	submit: () => HeldDeliveryResult | Promise<HeldDeliveryResult>;
	/** Whether the pane still exists; probed while a turn is stranded. Absent means "assume yes". */
	alive?: () => boolean | Promise<boolean>;
	/** Where stranding and drops are reported; the newest registration wins, like `submit`. */
	report?: (event: HeldAgentMessageReport) => void;
}

interface Hold {
	timer: ReturnType<typeof setTimeout> | null;
	/** When the first still-undelivered message landed — the ceiling is measured from it. */
	firstAt: number;
	/** Set by the first human keystroke that pushed this hold back; the ceiling then stops applying. */
	humanHeld: boolean;
	/** Every message waiting for this pane, in arrival order, with the bytes each types. */
	deliveries: Pick<HeldAgentMessage, "deliver" | "bytes" | "text">[];
	/** Typed once after them all; the newest registration wins, like `submit`. */
	epilogue: HeldAgentMessage["epilogue"];
	submit: HeldAgentMessage["submit"];
	alive: HeldAgentMessage["alive"];
	report: HeldAgentMessage["report"];
	context: Record<string, string>;
	/**
	 * Texts that landed in the pane with no Enter after them. Non-null means the turn is
	 * stranded: nothing is typed and nothing is submitted until a matching submission.
	 */
	stranded: string[] | null;
	/** The last release found the pane in copy mode; retry on the quiet window, not the ceiling. */
	modeDeferred: boolean;
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
	// A human at the keyboard gets his own, much longer window every time, with no
	// deadline behind it — see both constants' own comments.
	if (hold.humanHeld) return AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS;
	// A spent ceiling would turn a scrolled-up pane into a zero-delay retry loop.
	if (hold.modeDeferred) return AGENT_MESSAGE_HOLD_IDLE_MS;
	return Math.max(0, Math.min(AGENT_MESSAGE_HOLD_IDLE_MS, hold.firstAt + AGENT_MESSAGE_HOLD_CEILING_MS - now));
}

function rearm(key: string, hold: Hold, now: number): number {
	if (hold.timer) clearTimeout(hold.timer);
	if (hold.stranded) {
		hold.timer = setTimeout(() => void probe(key, hold), AGENT_MESSAGE_HOLD_IDLE_MS);
		return AGENT_MESSAGE_HOLD_IDLE_MS;
	}
	const delay = delayFor(hold, now);
	hold.timer = setTimeout(() => void release(key, hold), delay);
	return delay;
}

function report(hold: Hold, event: HeldAgentMessageReport): void {
	try {
		hold.report?.(event);
	} catch (err) {
		log.warn("held agent message report failed", { ...hold.context, error: String(err) });
	}
}

/** A stranded turn is never retried; it only checks that its pane still exists. */
async function probe(key: string, hold: Hold): Promise<void> {
	if (holds.get(key) !== hold || !hold.stranded) return;
	let alive = true;
	try {
		alive = hold.alive ? await hold.alive() : true;
	} catch (err) {
		// Not knowing is not "gone": dropping on a failed probe would lose the messages.
		log.warn("held agent message pane probe failed", { ...hold.context, error: String(err) });
	}
	if (holds.get(key) !== hold || !hold.stranded) return;
	if (alive) {
		rearm(key, hold, Date.now());
		return;
	}
	holds.delete(key);
	log.warn("stranded agent message dropped: the pane is gone", {
		...hold.context,
		waiting: String(hold.deliveries.length),
	});
	report(hold, { kind: "dropped", messages: hold.stranded.length + hold.deliveries.length, why: "the agent pane is gone" });
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
		epilogue: message.epilogue,
		submit: message.submit,
		alive: message.alive,
		report: message.report,
		context,
		stranded: null,
		modeDeferred: false,
	};
	hold.deliveries.push({ deliver: message.deliver, bytes: message.bytes, text: message.text });
	hold.epilogue = message.epilogue;
	hold.submit = message.submit;
	hold.alive = message.alive;
	hold.report = message.report;
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
		if (taskOfKey(key) !== taskId || hold.stranded) continue;
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
		// A keystroke Enter proves nothing about a stranded box — see the module rules.
		if (taskOfKey(key) !== taskId || hold.stranded) continue;
		log.info("agent message released by the user's own submit", hold.context);
		void release(key, hold);
		flushed += 1;
	}
	return flushed;
}

/**
 * The agent's prompt-submit hook reported `submitted` for this task. Every stranded
 * turn whose landed texts are ALL inside it was submitted — by whoever pressed Enter —
 * so the messages behind it may now go out as their own fresh turn. Anything that does
 * not contain them all (edited away, another pane, a different prompt) changes nothing.
 * Returns how many stranded turns this released.
 */
export function releaseStrandedAgentMessagesOnSubmission(taskId: string, submitted: string): number {
	if (holds.size === 0) return 0;
	let released = 0;
	for (const [key, hold] of holds) {
		if (taskOfKey(key) !== taskId || !hold.stranded) continue;
		if (!hold.stranded.every((text) => submissionMatchesTypedText(submitted, text))) continue;
		released += 1;
		log.info("stranded agent message turn released by a matching submission", {
			...hold.context,
			waiting: String(hold.deliveries.length),
		});
		hold.stranded = null;
		hold.modeDeferred = false;
		hold.humanHeld = false;
		hold.firstAt = Date.now();
		if (hold.deliveries.length === 0) {
			if (hold.timer) clearTimeout(hold.timer);
			holds.delete(key);
			continue;
		}
		rearm(key, hold, Date.now());
	}
	return released;
}

/** Bytes the boundary between two messages costs, counted like the messages themselves. */
const SEPARATOR_BYTES = utf8Length(AGENT_MESSAGE_BURST_SEPARATOR);

/**
 * How many of `deliveries` may be typed in one turn: as many as fit one pty read, and
 * never fewer than one — a message already sized to the cap must still go out.
 *
 * The cap is per RELEASE, not per message, because the receiving CLI splits what one
 * read hands it: three 600-byte envelopes released together are 1 800 bytes of one
 * stream, and its first chunk is exactly the piece that gets dropped (issue #1608).
 */
function burstFitCount(deliveries: Hold["deliveries"]): number {
	let typed = 0;
	for (const [index, delivery] of deliveries.entries()) {
		const cost = delivery.bytes + (index === 0 ? 0 : SEPARATOR_BYTES);
		if (index > 0 && typed + cost > AGENT_MESSAGE_SPILL_THRESHOLD_BYTES) return index;
		typed += cost;
	}
	return deliveries.length;
}

/**
 * Put `deliveries` (and an unsubmitted turn, if any) back for `key` after a release.
 * A message that arrived while the release was typing already started a fresh hold;
 * the leftovers are OLDER, so they go in front of it rather than replacing it.
 */
function requeue(
	key: string,
	from: Hold,
	deliveries: Hold["deliveries"],
	carry: Pick<Hold, "stranded" | "modeDeferred">,
): void {
	const now = Date.now();
	const fresh = holds.get(key);
	if (fresh) {
		fresh.deliveries.unshift(...deliveries);
		fresh.humanHeld ||= from.humanHeld;
		fresh.stranded = carry.stranded;
		fresh.modeDeferred ||= carry.modeDeferred;
		rearm(key, fresh, now);
		return;
	}
	const next: Hold = { ...from, timer: null, firstAt: now, deliveries, ...carry };
	holds.set(key, next);
	rearm(key, next, now);
}

/**
 * Type the messages this hold gathered that fit one pty read, in arrival order, then
 * submit them as one turn. Whatever did not fit stays held and lands in the next quiet
 * window as its own turn. A message that arrives while this is running starts a fresh
 * hold — the pane is mid-delivery, so joining it could interleave two pastes.
 */
async function release(key: string, hold: Hold): Promise<void> {
	// A newer hold may already own this pane; only the current one may release.
	if (holds.get(key) !== hold || hold.stranded) return;
	holds.delete(key);
	if (hold.timer) clearTimeout(hold.timer);

	const fits = burstFitCount(hold.deliveries);
	const going = hold.deliveries.slice(0, fits);
	const waiting = hold.deliveries.slice(fits);
	let typed = 0;
	const landedTexts: string[] = [];
	let deferredAt = -1;
	for (const [index, delivery] of going.entries()) {
		// The first message opens the turn; every later one needs a visible boundary,
		// because an envelope ends without a newline and would weld onto its predecessor.
		try {
			const result = await delivery.deliver(index === 0 ? "" : AGENT_MESSAGE_BURST_SEPARATOR);
			if (result === "deferred") {
				deferredAt = index;
				break;
			}
			if (result === "landed") landedTexts.push(delivery.text);
		} catch (err) {
			log.warn("held agent message text failed", { ...hold.context, error: String(err) });
		}
		typed += delivery.bytes + (index === 0 ? 0 : SEPARATOR_BYTES);
	}
	const landed = landedTexts.length > 0;

	if (deferredAt >= 0) {
		const rest = [...going.slice(deferredAt), ...waiting];
		if (landed) {
			strand(key, hold, landedTexts, rest, "the pane went into copy mode mid-turn");
			return;
		}
		// Nothing is in the box yet, so the whole turn simply waits for the pane.
		if (!hold.modeDeferred) log.info("held agent message deferred: the pane is in copy mode", hold.context);
		requeue(key, hold, rest, { stranded: null, modeDeferred: true });
		return;
	}
	if (!landed) {
		log.warn("held agent message landed nowhere; sending no Enter", hold.context);
		report(hold, { kind: "dropped", messages: going.length, why: "no text reached the agent pane" });
		if (waiting.length > 0) requeue(key, hold, waiting, { stranded: null, modeDeferred: false });
		return;
	}
	// After the messages, before the Enter — so the burst is one turn that ends on
	// the board. A trailer that fails costs the snapshot, never the messages, and one
	// that would push the turn past a single read is dropped by the adapter.
	if (hold.epilogue) {
		try {
			await hold.epilogue(Math.max(0, AGENT_MESSAGE_SPILL_THRESHOLD_BYTES - typed - SEPARATOR_BYTES));
		} catch (err) {
			log.warn("held agent message epilogue failed", { ...hold.context, error: String(err) });
		}
	}
	let submitted: HeldDeliveryResult = "failed";
	try {
		submitted = await hold.submit();
	} catch (err) {
		log.warn("held agent message submit failed", { ...hold.context, error: String(err) });
	}
	if (submitted === "deferred") {
		strand(key, hold, landedTexts, waiting, "the pane went into copy mode before the Enter");
		return;
	}
	if (waiting.length > 0) {
		log.info("held agent message burst split to stay inside one terminal read", {
			...hold.context,
			typedBytes: String(typed),
			sent: String(going.length),
			waiting: String(waiting.length),
		});
		// Its own turn, its own Enter, after another quiet window: the same closures the
		// newest registration left, so the next release still types against a fresh pin.
		requeue(key, hold, waiting, { stranded: null, modeDeferred: false });
	}
}

/** Text is in the box and dev3 may not press Enter on it: park the turn and say so. */
function strand(key: string, hold: Hold, landedTexts: string[], rest: Hold["deliveries"], why: string): void {
	log.warn("held agent message turn stranded: text landed, dev3 will not press Enter", {
		...hold.context,
		why,
		waiting: String(rest.length),
	});
	requeue(key, hold, rest, { stranded: landedTexts, modeDeferred: true });
	report(hold, { kind: "stranded", waiting: rest.length });
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
