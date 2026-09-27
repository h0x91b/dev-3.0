import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
	AGENT_MESSAGE_HOLD_CEILING_MS,
	AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS,
	AGENT_MESSAGE_HOLD_IDLE_MS,
} from "../../shared/agent-message-hold-timing";
import {
	AGENT_MESSAGE_BATCH_MAX_BYTES,
	AGENT_MESSAGE_BATCH_MAX_MESSAGES,
	agentMessageHoldKey,
	deferHeldAgentMessagesForTask,
	flushHeldAgentMessagesForTask,
	holdAgentMessage as holdAgentMessageWithText,
	pendingAgentMessageHoldCount,
	releaseStrandedAgentMessagesOnSubmission,
	resetAgentMessageHolds,
	type HeldAgentMessage,
	type HeldAgentMessageReport,
	type HeldDeliveryResult,
	type HeldMessageBatch,
} from "../agent-message-hold";

/** Most cases here are about timing, not matching, so their messages carry no text. */
function holdAgentMessage(key: string, message: Omit<HeldAgentMessage, "text"> & { text?: string }, context: Record<string, string>) {
	return holdAgentMessageWithText(key, { text: "", ...message }, context);
}

const KEY = agentMessageHoldKey("tmux", "task-1", "%1");
const OTHER = agentMessageHoldKey("tmux", "task-1", "%2");

/** A message whose text lands and whose Enter is recorded, both as spies. */
function message() {
	return { deliver: vi.fn<() => HeldDeliveryResult>(() => "landed"), bytes: 0, submit: vi.fn<() => HeldDeliveryResult>(() => "landed") };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	resetAgentMessageHolds();
	vi.useRealTimers();
});

describe("holdAgentMessage — the idle window", () => {
	it("types nothing on arrival and lands once the pane has been quiet", async () => {
		const one = message();
		expect(holdAgentMessage(KEY, one, {})).toBe(AGENT_MESSAGE_HOLD_IDLE_MS);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS - 1);
		expect(one.deliver).not.toHaveBeenCalled();
		expect(one.submit).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(one.deliver).toHaveBeenCalledTimes(1);
		expect(one.submit).toHaveBeenCalledTimes(1);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	it("collapses a burst into every text in arrival order and ONE Enter", async () => {
		const order: string[] = [];
		const held = ["one", "two", "three"].map((text) => ({
			deliver: vi.fn<() => HeldDeliveryResult>(() => {
				order.push(text);
				return "landed";
			}),
			bytes: 0,
			submit: vi.fn<() => HeldDeliveryResult>(() => (order.push(`submit:${text}`), "landed")),
		}));
		for (const item of held) {
			holdAgentMessage(KEY, item, {});
			await vi.advanceTimersByTimeAsync(4_000);
		}
		expect(order).toEqual([]);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		// Three texts, one Enter — and the newest registration owns it, because it
		// carries the freshest pane pin.
		expect(order).toEqual(["one", "two", "three", "submit:three"]);
		expect(held[0]?.submit).not.toHaveBeenCalled();
		expect(held[1]?.submit).not.toHaveBeenCalled();
	});

	it("keeps each pane's window separate", async () => {
		const mine = message();
		const other = message();
		holdAgentMessage(KEY, mine, {});
		holdAgentMessage(OTHER, other, {});
		expect(pendingAgentMessageHoldCount()).toBe(2);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(mine.submit).toHaveBeenCalledTimes(1);
		expect(other.submit).toHaveBeenCalledTimes(1);
	});

	it("starts a fresh window after a hold has released", async () => {
		holdAgentMessage(KEY, message(), {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		const later = message();
		expect(holdAgentMessage(KEY, later, {})).toBe(AGENT_MESSAGE_HOLD_IDLE_MS);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(later.submit).toHaveBeenCalledTimes(1);
	});
});

describe("holdAgentMessage — the ceiling on message-driven holds", () => {
	it("lands at the ceiling even while messages keep arriving", async () => {
		// A steady stream every 5s never lets the idle window close. Without the
		// ceiling the receiving agent would never read a word.
		const submits: ReturnType<typeof message>["submit"][] = [];
		let elapsed = 0;
		while (elapsed < AGENT_MESSAGE_HOLD_CEILING_MS) {
			const item = message();
			submits.push(item.submit);
			holdAgentMessage(KEY, item, {});
			await vi.advanceTimersByTimeAsync(5_000);
			elapsed += 5_000;
		}
		expect(submits.filter((s) => s.mock.calls.length > 0)).toHaveLength(1);
	});

	it("reports a shrinking delay as the ceiling approaches", async () => {
		holdAgentMessage(KEY, message(), {});
		let elapsed = 0;
		while (elapsed < AGENT_MESSAGE_HOLD_CEILING_MS - 5_000) {
			await vi.advanceTimersByTimeAsync(5_000);
			elapsed += 5_000;
			holdAgentMessage(KEY, message(), {});
		}
		await vi.advanceTimersByTimeAsync(1_000);
		// 4s of headroom left, so the promised delay is 4s and not the full window.
		expect(holdAgentMessage(KEY, message(), {})).toBe(4_000);
	});
});

describe("deferHeldAgentMessagesForTask — the user is typing", () => {
	it("pushes the hold back a full HUMAN window on every keystroke", async () => {
		const item = message();
		holdAgentMessage(KEY, item, {});

		for (let i = 0; i < 3; i += 1) {
			await vi.advanceTimersByTimeAsync(5_000);
			expect(item.deliver).not.toHaveBeenCalled();
			expect(deferHeldAgentMessagesForTask("task-1")).toBe(1);
		}
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS);
		expect(item.submit).toHaveBeenCalledTimes(1);
	});

	it("survives a pause to think: the message window alone does not release his hold", async () => {
		// 15s without a keystroke is an ordinary pause while writing one line, so the
		// message must not land behind it — only the far longer human window does.
		const item = message();
		holdAgentMessage(KEY, item, {});
		deferHeldAgentMessagesForTask("task-1");

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(item.deliver).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS - AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(item.submit).toHaveBeenCalledTimes(1);
	});

	it("has NO ceiling: typing without pause holds the message indefinitely", async () => {
		// The user's half-written line outranks every deadline. Twice the ceiling of
		// continuous typing must still not paste a peer's text into it.
		const item = message();
		holdAgentMessage(KEY, item, {});
		let elapsed = 0;
		while (elapsed < AGENT_MESSAGE_HOLD_CEILING_MS * 2) {
			await vi.advanceTimersByTimeAsync(1_000);
			elapsed += 1_000;
			deferHeldAgentMessagesForTask("task-1");
		}
		expect(item.deliver).not.toHaveBeenCalled();

		// It is a hold, not a leak: a long enough silence still releases it.
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS);
		expect(item.submit).toHaveBeenCalledTimes(1);
	});

	it("keeps the ceiling off once he has typed, even while messages keep arriving", async () => {
		const first = message();
		holdAgentMessage(KEY, first, {});
		deferHeldAgentMessagesForTask("task-1");
		let elapsed = 0;
		while (elapsed < AGENT_MESSAGE_HOLD_CEILING_MS * 2) {
			await vi.advanceTimersByTimeAsync(5_000);
			elapsed += 5_000;
			holdAgentMessage(KEY, message(), {});
			deferHeldAgentMessagesForTask("task-1");
		}
		expect(first.deliver).not.toHaveBeenCalled();
	});

	it("pushes back every pane of that task, and no other task's", async () => {
		const mine = message();
		const sibling = message();
		const stranger = message();
		holdAgentMessage(KEY, mine, {});
		holdAgentMessage(OTHER, sibling, {});
		holdAgentMessage(agentMessageHoldKey("tmux", "task-2", "%1"), stranger, {});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS - 1_000);
		expect(deferHeldAgentMessagesForTask("task-1")).toBe(2);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(stranger.submit).toHaveBeenCalledTimes(1);
		expect(mine.deliver).not.toHaveBeenCalled();
		expect(sibling.deliver).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS);
		expect(mine.submit).toHaveBeenCalledTimes(1);
		expect(sibling.submit).toHaveBeenCalledTimes(1);
	});

	it("is a no-op when that task holds nothing", () => {
		expect(deferHeldAgentMessagesForTask("task-1")).toBe(0);
		holdAgentMessage(KEY, message(), {});
		expect(deferHeldAgentMessagesForTask("task-2")).toBe(0);
	});
});

describe("flushHeldAgentMessagesForTask — the user submitted his own line", () => {
	it("lands everything at once, without waiting for the window", async () => {
		const one = message();
		const two = message();
		holdAgentMessage(KEY, one, {});
		holdAgentMessage(OTHER, two, {});
		deferHeldAgentMessagesForTask("task-1");

		expect(flushHeldAgentMessagesForTask("task-1")).toBe(2);
		await vi.advanceTimersByTimeAsync(0);
		expect(one.submit).toHaveBeenCalledTimes(1);
		expect(two.submit).toHaveBeenCalledTimes(1);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	it("delivers each held message exactly once — the window cannot fire it again", async () => {
		const item = message();
		holdAgentMessage(KEY, item, {});
		flushHeldAgentMessagesForTask("task-1");
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(item.deliver).toHaveBeenCalledTimes(1);
		expect(item.submit).toHaveBeenCalledTimes(1);
	});

	it("leaves another task's holds alone", async () => {
		const stranger = message();
		holdAgentMessage(agentMessageHoldKey("tmux", "task-2", "%1"), stranger, {});
		expect(flushHeldAgentMessagesForTask("task-1")).toBe(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(stranger.deliver).not.toHaveBeenCalled();
	});
});

describe("holdAgentMessage — failures", () => {
	it("sends no Enter when no text landed", async () => {
		const submit = vi.fn();
		holdAgentMessage(KEY, { deliver: (): HeldDeliveryResult => "failed", bytes: 0, submit }, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(submit).not.toHaveBeenCalled();
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	it("still submits the burst when one text of it failed", async () => {
		const submit = vi.fn();
		holdAgentMessage(KEY, { deliver: () => Promise.reject(new Error("pane died")), bytes: 0, submit: vi.fn() }, {});
		holdAgentMessage(KEY, { deliver: (): HeldDeliveryResult => "landed", bytes: 0, submit }, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("survives a submit that throws and clears the pane", async () => {
		holdAgentMessage(
			KEY,
			{
				deliver: (): HeldDeliveryResult => "landed",
				bytes: 0,
				submit: () => {
					throw new Error("pane died");
				},
			},
			{},
		);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	it("survives a submit that rejects", async () => {
		holdAgentMessage(KEY, { deliver: (): HeldDeliveryResult => "landed", bytes: 0, submit: () => Promise.reject(new Error("pane died")) }, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});
});

// The receiving CLI chunks what ONE pty read hands it, not what one paste contained,
// so three envelopes released together are one stream to it and its FIRST chunk is the
// piece that gets dropped (issue #1608). Per-message spilling cannot see that; the
// release has to. Remove the sum check in `burstFitCount` and every case here fails.
describe("a burst stays inside one terminal read", () => {
	/** A message of `bytes` typed bytes, recording the order of its delivery and Enter. */
	function sized(name: string, bytes: number, order: string[]) {
		return {
			deliver: vi.fn<(separator: string) => HeldDeliveryResult>(() => {
				order.push(name);
				return "landed";
			}),
			bytes,
			submit: vi.fn<() => HeldDeliveryResult>(() => (order.push(`enter:${name}`), "landed")),
		};
	}

	it("splits three 600-byte messages into three turns, in arrival order", async () => {
		const order: string[] = [];
		for (const item of [sized("a", 600, order), sized("b", 600, order), sized("c", 600, order)]) {
			holdAgentMessage(KEY, item, {});
		}

		await vi.runAllTimersAsync();

		// Never two messages in one turn: 600 + 600 is already past the 1 000-byte cap.
		expect(order).toEqual(["a", "enter:c", "b", "enter:c", "c", "enter:c"]);
	});

	it("keeps a burst that fits in ONE turn with a single Enter", async () => {
		const order: string[] = [];
		for (const item of [sized("a", 300, order), sized("b", 300, order), sized("c", 300, order)]) {
			holdAgentMessage(KEY, item, {});
		}

		await vi.runAllTimersAsync();

		// 300 + 2 + 300 + 2 + 300 = 904 bytes, so the whole burst is one agent turn.
		expect(order).toEqual(["a", "b", "c", "enter:c"]);
	});

	it("still sends a message that alone fills the read, rather than holding it forever", async () => {
		const order: string[] = [];
		holdAgentMessage(KEY, sized("huge", 5_000, order), {});

		await vi.runAllTimersAsync();

		expect(order).toEqual(["huge", "enter:huge"]);
	});

	it("offers the trailer only what is left of the read after the messages", async () => {
		const order: string[] = [];
		const budgets: number[] = [];
		const first = sized("a", 400, order);
		holdAgentMessage(KEY, { ...first, epilogue: (budget) => { budgets.push(budget); return true; } }, {});

		await vi.runAllTimersAsync();

		// 1 000 − 400 typed − 2 for the blank line before the board.
		expect(budgets).toEqual([598]);
	});
});

// A pane the user scrolled up (tmux copy mode) refuses keys but is still the same pane.
// The hold used to be deleted on that refusal, so the message vanished (C5).
describe("a scrolled-up pane defers the hold instead of dropping it", () => {
	/** Answers with `results` in order, then keeps answering with the last one. */
	function scripted(name: string, results: HeldDeliveryResult[], order: string[]) {
		let call = 0;
		return (separator: string): HeldDeliveryResult => {
			const result = results[Math.min(call++, results.length - 1)] ?? "landed";
			order.push(`${result}:${JSON.stringify(separator)}${name}`);
			return result;
		};
	}

	it("keeps the message, retries each quiet window, and delivers it once", async () => {
		const order: string[] = [];
		const submit = vi.fn<() => HeldDeliveryResult>(() => "landed");
		holdAgentMessage(KEY, { deliver: scripted("a", ["deferred", "deferred", "landed"], order), bytes: 0, submit }, {});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pendingAgentMessageHoldCount()).toBe(1);
		expect(submit).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 2);
		expect(order).toEqual(['deferred:""a', 'deferred:""a', 'landed:""a']);
		expect(submit).toHaveBeenCalledTimes(1);
		expect(pendingAgentMessageHoldCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 4);
		expect(order).toHaveLength(3);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("retries on the quiet window even after the ceiling, never in a tight loop", async () => {
		const order: string[] = [];
		holdAgentMessage(KEY, { deliver: scripted("a", ["deferred"], order), bytes: 0, submit: vi.fn(() => "landed" as const) }, {});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_CEILING_MS * 2);
		expect(order).toHaveLength((AGENT_MESSAGE_HOLD_CEILING_MS * 2) / AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});

	it("drops the hold once the pane is really gone", async () => {
		const order: string[] = [];
		const submit = vi.fn<() => HeldDeliveryResult>(() => "landed");
		holdAgentMessage(KEY, { deliver: scripted("a", ["deferred", "failed"], order), bytes: 0, submit }, {});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 4);
		expect(order).toEqual(['deferred:""a', 'failed:""a']);
		expect(submit).not.toHaveBeenCalled();
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

});

// Putting leftovers back used to `holds.set` over a hold that started while the release
// was typing, so that newer message was never typed (C6). The same seam re-queues a
// scrolled-up pane's messages, so both paths are covered here.
describe("leftovers never overwrite a hold that started during the release", () => {
	it("a split burst keeps a message that arrived while its first turn was typing", async () => {
		const order: string[] = [];
		const submit = vi.fn<() => HeldDeliveryResult>(() => (order.push("enter"), "landed"));
		const late = { deliver: vi.fn<() => HeldDeliveryResult>(() => (order.push("late"), "landed")), bytes: 10, submit };
		holdAgentMessage(KEY, {
			deliver: () => {
				order.push("a");
				holdAgentMessage(KEY, late, {});
				return "landed";
			},
			bytes: 600,
			submit,
		}, {});
		holdAgentMessage(KEY, { deliver: () => (order.push("b"), "landed"), bytes: 600, submit }, {});

		await vi.runAllTimersAsync();
		expect(order).toEqual(["a", "enter", "b", "late", "enter"]);
		expect(late.deliver).toHaveBeenCalledTimes(1);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	it("a deferred message goes in front of one that arrived meanwhile, each typed once", async () => {
		const order: string[] = [];
		const submit = vi.fn<() => HeldDeliveryResult>(() => (order.push("enter"), "landed"));
		const late = { deliver: vi.fn<() => HeldDeliveryResult>(() => (order.push("late"), "landed")), bytes: 10, submit };
		let refused = false;
		holdAgentMessage(KEY, {
			deliver: () => {
				if (!refused) {
					refused = true;
					holdAgentMessage(KEY, late, {});
					order.push("early:deferred");
					return "deferred";
				}
				order.push("early");
				return "landed";
			},
			bytes: 10,
			submit,
		}, {});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(order).toEqual(["early:deferred", "early", "late", "enter"]);
		expect(late.deliver).toHaveBeenCalledTimes(1);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});
});

// A turn whose text landed but whose Enter was refused leaves agent text in the box,
// and the user may type a draft behind it. Any Enter dev3 sends would submit that draft,
// so the turn is stranded: only a prompt-submit hook containing the landed text frees it.
describe("a stranded turn is never submitted by dev3", () => {
	const A = "<dev3-ai-message>first peer report, long enough to match</dev3-ai-message>";
	const B = "<dev3-ai-message>second peer report, long enough to match</dev3-ai-message>";
	const C = "<dev3-ai-message>third peer report, long enough to match</dev3-ai-message>";

	/** A message whose delivery answers `results` in order (then the last one), with its text recorded. */
	function scriptedMessage(text: string, results: HeldDeliveryResult[], order: string[], extra: Partial<HeldAgentMessage> = {}) {
		let call = 0;
		return {
			text,
			bytes: 10,
			deliver: (separator: string): HeldDeliveryResult => {
				const result = results[Math.min(call++, results.length - 1)] ?? "landed";
				order.push(`${result}:${JSON.stringify(separator)}${text.slice(17).split(" ")[0]}`);
				return result;
			},
			submit: (): HeldDeliveryResult => (order.push("enter"), "landed"),
			...extra,
		};
	}

	/** Text lands, then the Enter is refused (the user scrolled up in the gap). */
	function strandOneTurn(order: string[], extra: Partial<HeldAgentMessage> = {}) {
		const reports: unknown[] = [];
		const submit = vi.fn<() => HeldDeliveryResult>()
			.mockImplementationOnce(() => (order.push("enter:deferred"), "deferred"))
			.mockImplementation(() => (order.push("enter"), "landed"));
		holdAgentMessageWithText(KEY, { ...scriptedMessage(A, ["landed"], order), submit, report: (e) => reports.push(e), ...extra }, {});
		return { submit, reports };
	}

	it("sends no Enter through every window, the ceiling, the user's typing and a raw Enter", async () => {
		const order: string[] = [];
		const { submit, reports } = strandOneTurn(order);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(order).toEqual(['landed:""first', "enter:deferred"]);
		expect(reports).toEqual([{ kind: "stranded", waiting: 0 }]);

		deferHeldAgentMessagesForTask("task-1");
		// A keystroke Enter may have gone to copy mode, a picker or another pane.
		expect(flushHeldAgentMessagesForTask("task-1")).toBe(0);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_CEILING_MS + AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS * 3);
		expect(submit).toHaveBeenCalledTimes(1);
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});

	it("stays held when a hook's text does not contain the landed message", async () => {
		const order: string[] = [];
		strandOneTurn(order);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(releaseStrandedAgentMessagesOnSubmission("task-1", "")).toBe(0);
		expect(releaseStrandedAgentMessagesOnSubmission("task-1", "just the user's own prompt")).toBe(0);
		// A collapsed paste names no text at all, so it proves nothing.
		expect(releaseStrandedAgentMessagesOnSubmission("task-1", "[Pasted text #1 +3 lines] my draft")).toBe(0);
		expect(releaseStrandedAgentMessagesOnSubmission("task-2", `${A}my draft`)).toBe(0);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS * 2);
		expect(order).toEqual(['landed:""first', "enter:deferred"]);
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});

	it("waits with no deadline when no hook ever arrives, while the pane lives", async () => {
		const order: string[] = [];
		const alive = vi.fn(() => true);
		strandOneTurn(order, { alive });
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(order).toEqual(['landed:""first', "enter:deferred"]);
		expect(alive.mock.calls.length).toBeGreaterThan(100);
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});

	it("keeps later messages behind it untyped, then sends them once, in order, after a matching submission", async () => {
		const order: string[] = [];
		strandOneTurn(order);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		holdAgentMessageWithText(KEY, scriptedMessage(B, ["landed"], order), {});
		holdAgentMessageWithText(KEY, scriptedMessage(C, ["landed"], order), {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 4);
		expect(order).toEqual(['landed:""first', "enter:deferred"]);

		// Whoever pressed Enter, the agent received the box: the stranded text plus a draft.
		expect(releaseStrandedAgentMessagesOnSubmission("task-1", `${A}\nmy own draft`)).toBe(1);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + 1);
		expect(order).toEqual(['landed:""first', "enter:deferred", 'landed:""second', 'landed:"\\n\\n"third', "enter"]);
		expect(pendingAgentMessageHoldCount()).toBe(0);
		// A redelivered hook finds nothing left to release.
		expect(releaseStrandedAgentMessagesOnSubmission("task-1", `${A}\nmy own draft`)).toBe(0);
	});

	it("needs EVERY landed text: a submission that holds only part of the box releases nothing", async () => {
		const order: string[] = [];
		const reports: unknown[] = [];
		holdAgentMessageWithText(KEY, scriptedMessage(A, ["landed"], order), {});
		holdAgentMessageWithText(KEY, scriptedMessage(B, ["landed"], order), {});
		// The newest registration owns the reporter, exactly as it owns `submit`.
		holdAgentMessageWithText(KEY, { ...scriptedMessage(C, ["deferred", "landed"], order), report: (e) => reports.push(e) }, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(order).toEqual(['landed:""first', 'landed:"\\n\\n"second', 'deferred:"\\n\\n"third']);
		expect(reports).toEqual([{ kind: "stranded", waiting: 1 }]);

		expect(releaseStrandedAgentMessagesOnSubmission("task-1", A)).toBe(0);
		expect(releaseStrandedAgentMessagesOnSubmission("task-1", `${A}\n\n${B}`)).toBe(1);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS + 1);
		// The refused message opens its own fresh turn: no separator, one Enter.
		expect(order.slice(3)).toEqual(['landed:""third', "enter"]);
	});

	it("drops the turn and says so once the pane is gone", async () => {
		const order: string[] = [];
		let alive = true;
		const { reports, submit } = strandOneTurn(order, { alive: () => alive });
		holdAgentMessageWithText(KEY, { ...scriptedMessage(B, ["landed"], order), submit, alive: () => alive, report: (e) => reports.push(e) }, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pendingAgentMessageHoldCount()).toBe(1);

		alive = false;
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pendingAgentMessageHoldCount()).toBe(0);
		expect(reports[reports.length - 1]).toEqual({ kind: "dropped", messages: 2, why: "the agent pane is gone" });
	});

	it("keeps the turn when the pane probe itself fails", async () => {
		const order: string[] = [];
		strandOneTurn(order, { alive: () => Promise.reject(new Error("tmux timed out")) });
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 5);
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});
});

describe("a backlog past one read goes out as ONE batch turn", () => {
	/** A held message with a real text, recording whether it was ever typed on its own. */
	function envelope(n: number, bytes = 650, typed: string[] = []) {
		return {
			text: `message ${n}`,
			bytes,
			deliver: vi.fn<(separator: string) => HeldDeliveryResult>(() => (typed.push(`message ${n}`), "landed")),
			submit: vi.fn<() => HeldDeliveryResult>(() => "landed"),
		};
	}

	/** An adapter batch that records every call and types a pointer naming how many it carries. */
	function batcher(result: (texts: string[]) => HeldDeliveryResult = () => "landed") {
		const calls: string[][] = [];
		const typed: string[] = [];
		const batch = vi.fn(async (texts: string[]): Promise<HeldMessageBatch> => {
			calls.push(texts);
			const text = `pointer to ${texts.length} (${calls.length})`;
			return { text, bytes: 250, path: `/task/messages/burst-${calls.length}.md`, deliver: () => {
				const outcome = result(texts);
				if (outcome === "landed") typed.push(text);
				return outcome;
			} };
		});
		return { batch, calls, typed };
	}

	it("sends 33 held messages as one pointer and one Enter, one human window after the keystroke", async () => {
		// The Seq 22 incident: 33 envelopes of ~650 bytes behind one keystroke took ~33 min.
		const { batch, calls, typed } = batcher();
		const singles: string[] = [];
		const items = Array.from({ length: 33 }, (_, i) => ({ ...envelope(i + 1, 650, singles), batch }));
		for (const item of items) holdAgentMessage(KEY, item, {});
		deferHeldAgentMessagesForTask("task-1");

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS);

		expect(calls).toEqual([items.map((item) => item.text)]);
		expect(typed).toEqual(["pointer to 33 (1)"]);
		expect(singles).toEqual([]);
		expect(items.reduce((n, item) => n + item.submit.mock.calls.length, 0)).toBe(1);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	it("types a burst that fits one read exactly as before, never as a batch", async () => {
		const { batch } = batcher();
		const typed: string[] = [];
		for (const n of [1, 2, 3]) holdAgentMessage(KEY, { ...envelope(n, 300, typed), batch }, {});

		await vi.runAllTimersAsync();

		expect(batch).not.toHaveBeenCalled();
		expect(typed).toEqual(["message 1", "message 2", "message 3"]);
	});

	it("caps one batch at the message bound and sends the rest as the next turn", async () => {
		const { batch, calls } = batcher();
		const total = AGENT_MESSAGE_BATCH_MAX_MESSAGES + 10;
		for (let n = 1; n <= total; n += 1) holdAgentMessage(KEY, { ...envelope(n), batch }, {});

		await vi.runAllTimersAsync();

		expect(calls.map((texts) => texts.length)).toEqual([AGENT_MESSAGE_BATCH_MAX_MESSAGES, 10]);
		expect(calls[1]?.[0]).toBe(`message ${AGENT_MESSAGE_BATCH_MAX_MESSAGES + 1}`);
	});

	it("caps one batch at the byte bound", async () => {
		const { batch, calls } = batcher();
		const typed: string[] = [];
		const big = AGENT_MESSAGE_BATCH_MAX_BYTES / 2 - 1;
		for (const n of [1, 2, 3]) holdAgentMessage(KEY, { ...envelope(n, big, typed), batch }, {});

		await vi.runAllTimersAsync();

		// Two fit under the bound; the third goes out on its own as it always did.
		expect(calls).toEqual([["message 1", "message 2"]]);
		expect(typed).toEqual(["message 3"]);
	});

	it("falls back to one turn per read when the batch cannot be written, losing nothing", async () => {
		const typed: string[] = [];
		const batch = vi.fn(async () => null);
		for (const n of [1, 2, 3]) holdAgentMessage(KEY, { ...envelope(n, 600, typed), batch }, {});

		await vi.runAllTimersAsync();

		expect(typed).toEqual(["message 1", "message 2", "message 3"]);
	});

	it("falls back the same way when the batch throws", async () => {
		const typed: string[] = [];
		const batch = vi.fn(async (): Promise<HeldMessageBatch> => {
			throw new Error("disk full");
		});
		for (const n of [1, 2]) holdAgentMessage(KEY, { ...envelope(n, 600, typed), batch }, {});

		await vi.runAllTimersAsync();

		expect(typed).toEqual(["message 1", "message 2"]);
	});

	it("puts the ORIGINAL messages back when the pane refused the pointer, and batches them again", async () => {
		let mode = true;
		const { batch, calls, typed } = batcher(() => (mode ? "deferred" : "landed"));
		const singles: string[] = [];
		const items = [1, 2, 3].map((n) => ({ ...envelope(n, 600, singles), batch }));
		for (const item of items) holdAgentMessage(KEY, item, {});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pendingAgentMessageHoldCount()).toBe(1);
		mode = false;
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);

		expect(calls).toEqual([items.map((i) => i.text), items.map((i) => i.text)]);
		expect(typed).toEqual(["pointer to 3 (2)"]);
		expect(singles).toEqual([]);
		expect(items[2]?.submit).toHaveBeenCalledTimes(1);
	});

	it("strands on the POINTER: only a submission containing the pointer releases the turn", async () => {
		const { batch } = batcher();
		const items = [1, 2, 3].map((n) => ({ ...envelope(n, 600), batch, submit: vi.fn<() => HeldDeliveryResult>(() => "deferred") }));
		for (const item of items) holdAgentMessage(KEY, item, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		const later = { ...envelope(4, 100), batch };
		holdAgentMessage(KEY, later, {});

		expect(releaseStrandedAgentMessagesOnSubmission("task-1", "message 2")).toBe(0);
		expect(releaseStrandedAgentMessagesOnSubmission("task-1", "pointer to 3 (1)")).toBe(1);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(later.deliver).toHaveBeenCalledTimes(1);
	});

	it("names the batch file when a stranded batch's pane is gone", async () => {
		const { batch } = batcher();
		const reports: HeldAgentMessageReport[] = [];
		const items = [1, 2, 3].map((n) => ({
			...envelope(n, 600),
			batch,
			submit: vi.fn<() => HeldDeliveryResult>(() => "deferred"),
			alive: () => false,
			report: (event: HeldAgentMessageReport) => void reports.push(event),
		}));
		for (const item of items) holdAgentMessage(KEY, item, {});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 2);

		expect(reports[reports.length - 1]).toEqual({ kind: "dropped", messages: 3, why: "the agent pane is gone", paths: ["/task/messages/burst-1.md"] });
	});

	it("names the batch file when the pointer landed nowhere", async () => {
		const { batch } = batcher(() => "failed");
		const reports: HeldAgentMessageReport[] = [];
		for (const n of [1, 2, 3]) {
			holdAgentMessage(KEY, { ...envelope(n, 600), batch, report: (event) => void reports.push(event) }, {});
		}

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);

		expect(reports).toEqual([
			{ kind: "dropped", messages: 3, why: "no text reached the agent pane", paths: ["/task/messages/burst-1.md"] },
		]);
	});
});

describe("a pane left in copy mode leaves no trail of batch files", () => {
	it("undoes every refused batch across 10 minutes, then delivers one", async () => {
		let mode = true;
		const written = new Set<string>();
		let seq = 0;
		const discards: string[] = [];
		const batch = vi.fn(async (): Promise<HeldMessageBatch> => {
			const path = `/task/messages/burst-${(seq += 1)}.md`;
			written.add(path);
			return {
				text: `pointer ${seq}`,
				bytes: 250,
				path,
				deliver: () => (mode ? "deferred" : "landed"),
				discard: () => {
					written.delete(path);
					discards.push(path);
				},
			};
		});
		const items = [1, 2, 3, 4, 5].map((n) => ({
			text: `message ${n}`,
			bytes: 650,
			deliver: vi.fn<() => HeldDeliveryResult>(() => "landed"),
			submit: vi.fn<() => HeldDeliveryResult>(() => "landed"),
			batch,
		}));
		for (const item of items) holdAgentMessage(KEY, item, {});

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(batch.mock.calls.length).toBeGreaterThan(30);
		expect(written.size).toBe(0);
		expect(discards).toHaveLength(batch.mock.calls.length);

		mode = false;
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		// Exactly one file survives: the one whose pointer was typed.
		expect(written.size).toBe(1);
		expect(items.reduce((n, item) => n + item.submit.mock.calls.length, 0)).toBe(1);
		for (const item of items) expect(item.deliver).not.toHaveBeenCalled();
	});

	it("keeps the file when the pointer failed rather than being refused, so its path can be reported", async () => {
		const discard = vi.fn();
		const batch = vi.fn(async (): Promise<HeldMessageBatch> => ({
			text: "pointer",
			bytes: 250,
			path: "/task/messages/burst-1.md",
			deliver: () => "failed",
			discard,
		}));
		for (const n of [1, 2, 3]) holdAgentMessage(KEY, { text: `m${n}`, bytes: 600, deliver: () => "landed", submit: () => "landed", batch }, {});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);

		expect(discard).not.toHaveBeenCalled();
	});
});

describe("the user's typing is one clock per task, not a flag a hold carries", () => {
	/** A 600-byte message: two never share a turn, so each release leaves a continuation. */
	function turn(name: string, order: string[], onDeliver?: () => void) {
		return {
			deliver: vi.fn<(separator: string) => HeldDeliveryResult>(() => {
				order.push(`${name}@${Date.now()}`);
				onDeliver?.();
				return "landed";
			}),
			bytes: 600,
			submit: vi.fn<() => HeldDeliveryResult>(() => "landed"),
		};
	}

	it("one old keystroke no longer stretches every later turn to the human window", async () => {
		// The sticky flag made each of 33 turns wait 60 s; only the first may.
		const order: string[] = [];
		const start = Date.now();
		for (const name of ["a", "b", "c"]) holdAgentMessage(KEY, turn(name, order), {});
		deferHeldAgentMessagesForTask("task-1");

		await vi.runAllTimersAsync();

		const at = order.map((entry) => Number(entry.split("@")[1]) - start);
		expect(at).toEqual([
			AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS,
			AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS + AGENT_MESSAGE_HOLD_IDLE_MS,
			AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS + AGENT_MESSAGE_HOLD_IDLE_MS * 2,
		]);
	});

	it("a keystroke that lands WHILE a release is typing still holds back what it leaves", async () => {
		// The release has taken its hold out of the map, so no hold exists to flag.
		const order: string[] = [];
		const start = Date.now();
		holdAgentMessage(KEY, turn("a", order, () => deferHeldAgentMessagesForTask("task-1")), {});
		holdAgentMessage(KEY, turn("b", order), {});

		await vi.runAllTimersAsync();

		expect(order.map((entry) => Number(entry.split("@")[1]) - start)).toEqual([
			AGENT_MESSAGE_HOLD_IDLE_MS,
			AGENT_MESSAGE_HOLD_IDLE_MS + AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS,
		]);
	});

	it("the user's own Enter ends his window: what is left goes back to the quiet window", async () => {
		const order: string[] = [];
		for (const name of ["a", "b"]) holdAgentMessage(KEY, turn(name, order), {});
		deferHeldAgentMessagesForTask("task-1");
		await vi.advanceTimersByTimeAsync(5_000);
		const flushedAt = Date.now();
		flushHeldAgentMessagesForTask("task-1");

		await vi.runAllTimersAsync();

		expect(order.map((entry) => Number(entry.split("@")[1]) - flushedAt)).toEqual([0, AGENT_MESSAGE_HOLD_IDLE_MS]);
	});

	it("a message arriving mid-window waits only what is left of it, not a fresh full one", async () => {
		const first = message();
		holdAgentMessage(KEY, first, {});
		deferHeldAgentMessagesForTask("task-1");
		await vi.advanceTimersByTimeAsync(30_000);

		expect(holdAgentMessage(KEY, message(), {})).toBe(AGENT_MESSAGE_HOLD_HUMAN_IDLE_MS - 30_000);
	});

	it("keeps each task's clock to itself", async () => {
		const stranger = message();
		deferHeldAgentMessagesForTask("task-1");
		holdAgentMessage(agentMessageHoldKey("tmux", "task-2", "%1"), stranger, {});

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(stranger.submit).toHaveBeenCalledTimes(1);
	});
});
