/**
 * The board trailer's one hard rule: a burst of messages is ONE agent turn, so
 * it carries ONE trailer, typed after every message and before the single Enter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const {
	holdAgentMessage,
	agentMessageHoldKey,
	resetAgentMessageHolds,
	flushHeldAgentMessagesForTask,
} = await import("../agent-message-hold");

const KEY = agentMessageHoldKey("tmux", "task-1", "%1");

beforeEach(() => {
	vi.useFakeTimers();
	resetAgentMessageHolds();
});

afterEach(() => {
	resetAgentMessageHolds();
	vi.useRealTimers();
});

/** Records the exact order the hold ran things in. */
function recorder() {
	const order: string[] = [];
	const message = (name: string, epilogue?: string) => ({
		deliver: () => { order.push(name); return true; },
		...(epilogue ? { epilogue: () => { order.push(epilogue); return true; } } : {}),
		submit: () => { order.push("enter"); },
	});
	return { order, message };
}

describe("held message epilogue", () => {
	it("types the trailer after the message and before the Enter", async () => {
		const { order, message } = recorder();
		holdAgentMessage(KEY, message("msg", "board"), {});

		await vi.runAllTimersAsync();

		expect(order).toEqual(["msg", "board", "enter"]);
	});

	// Three peers reporting at once is one turn for the receiver. Three boards in
	// it would be three copies of the same table.
	it("types ONE trailer for a burst of three messages", async () => {
		const { order, message } = recorder();
		holdAgentMessage(KEY, message("a", "board"), {});
		holdAgentMessage(KEY, message("b", "board"), {});
		holdAgentMessage(KEY, message("c", "board"), {});

		await vi.runAllTimersAsync();

		expect(order).toEqual(["a", "b", "c", "board", "enter"]);
		expect(order.filter((s) => s === "board")).toHaveLength(1);
	});

	// The newest registration carries the freshest pane pin, exactly as `submit` does.
	it("uses the newest registration's trailer", async () => {
		const { order, message } = recorder();
		holdAgentMessage(KEY, message("a", "old-board"), {});
		holdAgentMessage(KEY, message("b", "new-board"), {});

		await vi.runAllTimersAsync();

		expect(order).toEqual(["a", "b", "new-board", "enter"]);
	});

	it("still sends the Enter when the trailer throws", async () => {
		const order: string[] = [];
		holdAgentMessage(KEY, {
			deliver: () => { order.push("msg"); return true; },
			epilogue: () => { throw new Error("board unavailable"); },
			submit: () => { order.push("enter"); },
		}, {});

		await vi.runAllTimersAsync();

		expect(order).toEqual(["msg", "enter"]);
	});

	// No text landed means no Enter — and therefore nothing to trail either.
	it("types no trailer when the message itself landed nowhere", async () => {
		const order: string[] = [];
		holdAgentMessage(KEY, {
			deliver: () => false,
			epilogue: () => { order.push("board"); return true; },
			submit: () => { order.push("enter"); },
		}, {});

		await vi.runAllTimersAsync();

		expect(order).toEqual([]);
	});

	it("behaves exactly as before for a message with no trailer", async () => {
		const { order, message } = recorder();
		holdAgentMessage(KEY, message("msg"), {});

		await vi.runAllTimersAsync();

		expect(order).toEqual(["msg", "enter"]);
	});

	it("keeps the order when the user's own Enter releases the burst early", async () => {
		const { order, message } = recorder();
		holdAgentMessage(KEY, message("a", "board"), {});
		holdAgentMessage(KEY, message("b", "board"), {});

		flushHeldAgentMessagesForTask("task-1");
		await vi.runAllTimersAsync();

		expect(order).toEqual(["a", "b", "board", "enter"]);
	});
});
