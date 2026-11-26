/**
 * The board trailer's one hard rule: a burst of messages is ONE agent turn, so
 * it carries ONE trailer, typed after every message and before the single Enter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const {
	holdAgentMessage: holdAgentMessageWithText,
	agentMessageHoldKey,
	resetAgentMessageHolds,
	flushHeldAgentMessagesForTask,
} = await import("../agent-message-hold");
type HeldDeliveryResult = import("../agent-message-hold").HeldDeliveryResult;
type HeldAgentMessage = import("../agent-message-hold").HeldAgentMessage;
const holdAgentMessage = (key: string, message: Omit<HeldAgentMessage, "text">, context: Record<string, string>) =>
	holdAgentMessageWithText(key, { text: "", ...message }, context);

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
		deliver: (): HeldDeliveryResult => { order.push(name); return "landed"; },
		...(epilogue ? { epilogue: () => { order.push(epilogue); return true; } } : {}),
		bytes: 0,
		submit: (): HeldDeliveryResult => { order.push("enter"); return "landed"; },
	});
	return { order, message };
}

describe("held message epilogue", () => {
	it("types the trailer after the message and before the Enter, and nothing extra without one", async () => {
		const { order, message } = recorder();
		holdAgentMessage(KEY, message("msg", "board"), {});
		await vi.runAllTimersAsync();
		expect(order).toEqual(["msg", "board", "enter"]);

		order.length = 0;
		holdAgentMessage(KEY, message("plain"), {});
		await vi.runAllTimersAsync();
		expect(order, "no trailer").toEqual(["plain", "enter"]);
	});

	// Three peers reporting at once is one turn for the receiver. Three boards in
	// it would be three copies of the same table. The newest registration carries
	// the freshest pane pin, exactly as `submit` does, so its trailer wins.
	it("types ONE trailer for a burst of three messages: the newest registration's", async () => {
		const { order, message } = recorder();
		holdAgentMessage(KEY, message("a", "board-a"), {});
		holdAgentMessage(KEY, message("b", "board-b"), {});
		holdAgentMessage(KEY, message("c", "board-c"), {});

		await vi.runAllTimersAsync();

		expect(order).toEqual(["a", "b", "c", "board-c", "enter"]);
	});

	it("still sends the Enter when the trailer throws", async () => {
		const order: string[] = [];
		holdAgentMessage(KEY, {
			deliver: (): HeldDeliveryResult => { order.push("msg"); return "landed"; },
			epilogue: () => { throw new Error("board unavailable"); },
			bytes: 0,
			submit: (): HeldDeliveryResult => { order.push("enter"); return "landed"; },
		}, {});

		await vi.runAllTimersAsync();

		expect(order).toEqual(["msg", "enter"]);
	});

	// No text landed means no Enter — and therefore nothing to trail either.
	it("types no trailer when the message itself landed nowhere", async () => {
		const order: string[] = [];
		holdAgentMessage(KEY, {
			deliver: (): HeldDeliveryResult => "failed",
			epilogue: () => { order.push("board"); return true; },
			bytes: 0,
			submit: (): HeldDeliveryResult => { order.push("enter"); return "landed"; },
		}, {});

		await vi.runAllTimersAsync();

		expect(order).toEqual([]);
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
