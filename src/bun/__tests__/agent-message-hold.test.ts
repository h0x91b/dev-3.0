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
	agentMessageHoldKey,
	deferHeldAgentMessagesForTask,
	flushHeldAgentMessagesForTask,
	holdAgentMessage,
	pendingAgentMessageHoldCount,
	resetAgentMessageHolds,
} from "../agent-message-hold";

const KEY = agentMessageHoldKey("tmux", "task-1", "%1");
const OTHER = agentMessageHoldKey("tmux", "task-1", "%2");

/** A message whose text lands and whose Enter is recorded, both as spies. */
function message() {
	return { deliver: vi.fn<() => boolean>(() => true), submit: vi.fn<() => void>() };
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
			deliver: vi.fn<() => boolean>(() => {
				order.push(text);
				return true;
			}),
			submit: vi.fn<() => void>(() => void order.push(`submit:${text}`)),
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
		holdAgentMessage(KEY, { deliver: () => false, submit }, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(submit).not.toHaveBeenCalled();
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	it("still submits the burst when one text of it failed", async () => {
		const submit = vi.fn();
		holdAgentMessage(KEY, { deliver: () => Promise.reject(new Error("pane died")), submit: vi.fn() }, {});
		holdAgentMessage(KEY, { deliver: () => true, submit }, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("survives a submit that throws and clears the pane", async () => {
		holdAgentMessage(
			KEY,
			{
				deliver: () => true,
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
		holdAgentMessage(KEY, { deliver: () => true, submit: () => Promise.reject(new Error("pane died")) }, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});
});
