import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { AGENT_MESSAGE_HOLD_IDLE_MS } from "../../shared/agent-message-hold-timing";
import { AGENT_MESSAGE_BURST_SEPARATOR } from "../../shared/agent-message-envelope";
import {
	AGENT_MESSAGE_HOOK_ACK_TIMEOUT_MS,
	acknowledgeHookClaim,
	agentMessageHoldKey,
	claimHeldAgentMessagesForHook,
	holdAgentMessage,
	pendingAgentMessageHoldCount,
	resetAgentMessageHolds,
	type HeldAgentMessage,
	type HeldAgentMessageReport,
	type HeldDeliveryResult,
} from "../agent-message-hold";

const KEY = agentMessageHoldKey("tmux", "task-1", "%1");

/** A held message that may go through the hook: typing and the hook receipt are spies. */
function hookable(text: string, extra: Partial<HeldAgentMessage> = {}) {
	const delivered = vi.fn();
	const message = {
		text,
		bytes: text.length,
		deliver: vi.fn<() => HeldDeliveryResult>(() => "landed"),
		submit: vi.fn<() => HeldDeliveryResult>(() => "landed"),
		hook: { text: `inline:${text}`, delivered },
		...extra,
	};
	return { message, delivered };
}

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	resetAgentMessageHolds();
	vi.useRealTimers();
});

describe("claimHeldAgentMessagesForHook - the hook mailbox", () => {
	it("hands a busy agent its held message at once, and the hold never types it", async () => {
		const { message, delivered } = hookable("one");
		holdAgentMessage(KEY, message, {});

		const claim = await claimHeldAgentMessagesForHook(KEY, 9_000);
		expect(claim).toMatchObject({ text: "inline:one", messages: 1, notices: [] });
		expect(delivered).not.toHaveBeenCalled();
		expect(acknowledgeHookClaim(claim!.claimId)).toBe(true);
		expect(delivered).toHaveBeenCalledTimes(1);
		expect(acknowledgeHookClaim(claim!.claimId)).toBe(false);
		expect(pendingAgentMessageHoldCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 2);
		expect(message.deliver).not.toHaveBeenCalled();
		expect(message.submit).not.toHaveBeenCalled();
	});

	it("delivers exactly once when the hook and the release race: the release wins and the hook gets nothing", async () => {
		const { message, delivered } = hookable("one");
		holdAgentMessage(KEY, message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		// The release has taken the hold synchronously; a hook arriving mid-typing finds nothing.
		await expect(claimHeldAgentMessagesForHook(KEY, 9_000)).resolves.toBeNull();
		expect(message.deliver).toHaveBeenCalledTimes(1);
		expect(delivered).not.toHaveBeenCalled();
	});

	it("delivers exactly once when the hook wins the race: the timer that fires next types nothing", async () => {
		const { message, delivered } = hookable("one");
		holdAgentMessage(KEY, message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS - 1);
		const claim = claimHeldAgentMessagesForHook(KEY, 9_000);
		await vi.advanceTimersByTimeAsync(1);
		const taken = await claim;
		expect(taken).toMatchObject({ messages: 1, notices: [] });
		acknowledgeHookClaim(taken!.claimId);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(message.deliver).not.toHaveBeenCalled();
		expect(delivered).toHaveBeenCalledTimes(1);
	});

	it("holds a claim again when the hook never confirms it, so a killed hook costs no message", async () => {
		const { message, delivered } = hookable("one");
		holdAgentMessage(KEY, message, {});
		await expect(claimHeldAgentMessagesForHook(KEY, 9_000)).resolves.toMatchObject({ messages: 1 });
		expect(pendingAgentMessageHoldCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOOK_ACK_TIMEOUT_MS);
		expect(pendingAgentMessageHoldCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(message.deliver).toHaveBeenCalledTimes(1);
		expect(message.submit).toHaveBeenCalledTimes(1);
		expect(delivered).not.toHaveBeenCalled();
	});

	it("puts an unconfirmed claim in front of messages held since", async () => {
		const first = hookable("one");
		holdAgentMessage(KEY, first.message, {});
		await claimHeldAgentMessagesForHook(KEY, 9_000);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOOK_ACK_TIMEOUT_MS - 1);
		const later = hookable("two", { hook: undefined });
		holdAgentMessage(KEY, later.message, {});
		await vi.advanceTimersByTimeAsync(1);
		expect(later.message.deliver).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		const order = [first.message.deliver, later.message.deliver].map((fn) => vi.mocked(fn).mock.invocationCallOrder[0]);
		expect(order[0]).toBeLessThan(order[1]!);
	});

	it("leaves an idle agent's message to the typed path after the quiet window", async () => {
		const { message, delivered } = hookable("one");
		holdAgentMessage(KEY, message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(message.deliver).toHaveBeenCalledTimes(1);
		expect(message.submit).toHaveBeenCalledTimes(1);
		expect(delivered).not.toHaveBeenCalled();
	});

	it("joins a burst with the separator the pane uses, in arrival order", async () => {
		holdAgentMessage(KEY, hookable("one").message, {});
		holdAgentMessage(KEY, hookable("two").message, {});
		await expect(claimHeldAgentMessagesForHook(KEY, 9_000)).resolves.toMatchObject({
			text: `inline:one${AGENT_MESSAGE_BURST_SEPARATOR}inline:two`,
			messages: 2,
			notices: [],
		});
	});

	it("stops at the first message that may not go through a hook, so order survives", async () => {
		const first = hookable("one");
		const typedOnly = hookable("two", { hook: undefined });
		const third = hookable("three");
		holdAgentMessage(KEY, first.message, {});
		holdAgentMessage(KEY, typedOnly.message, {});
		holdAgentMessage(KEY, third.message, {});

		await expect(claimHeldAgentMessagesForHook(KEY, 9_000)).resolves.toMatchObject({ text: "inline:one", messages: 1, notices: [] });
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(first.message.deliver).not.toHaveBeenCalled();
		expect(typedOnly.message.deliver).toHaveBeenCalledTimes(1);
		expect(third.message.deliver).toHaveBeenCalledTimes(1);
		expect(third.delivered).not.toHaveBeenCalled();
	});

	it("takes nothing when the first message alone is over the budget", async () => {
		holdAgentMessage(KEY, hookable("x".repeat(50)).message, {});
		await expect(claimHeldAgentMessagesForHook(KEY, 20)).resolves.toBeNull();
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});

	it("takes only what fits the budget and keeps the rest held, with its timer", async () => {
		const first = hookable("aaaa");
		const second = hookable("bbbb");
		holdAgentMessage(KEY, first.message, {});
		holdAgentMessage(KEY, second.message, {});
		// "inline:aaaa" is 11 characters; the second would need 2 + 11 more.
		await expect(claimHeldAgentMessagesForHook(KEY, 15)).resolves.toMatchObject({ text: "inline:aaaa", messages: 1, notices: [] });
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(first.message.deliver).not.toHaveBeenCalled();
		expect(second.message.deliver).toHaveBeenCalledTimes(1);
	});

	it("adds the newest message's trailer once when it fits, and nothing when it does not", async () => {
		holdAgentMessage(KEY, hookable("one", { hook: { text: "inline:one", delivered: vi.fn(), trailer: async () => "board" } }).message, {});
		await expect(claimHeldAgentMessagesForHook(KEY, 9_000)).resolves.toMatchObject({
			text: `inline:one${AGENT_MESSAGE_BURST_SEPARATOR}board`,
			messages: 1,
			notices: [],
		});

		holdAgentMessage(KEY, hookable("one", { hook: { text: "inline:one", delivered: vi.fn(), trailer: async () => "b".repeat(100) } }).message, {});
		await expect(claimHeldAgentMessagesForHook(KEY, 20)).resolves.toMatchObject({ text: "inline:one", messages: 1, notices: [] });
	});

	it("drops and reports a message whose bound agent is gone, and never types it", async () => {
		const reports: HeldAgentMessageReport[] = [];
		const { message, delivered } = hookable("one", {
			verify: async () => "the addressed agent is no longer running",
			report: (event) => reports.push(event),
		});
		holdAgentMessage(KEY, message, {});
		await expect(claimHeldAgentMessagesForHook(KEY, 9_000)).resolves.toBeNull();
		expect(delivered).not.toHaveBeenCalled();
		expect(reports).toEqual([{ kind: "dropped", messages: 1, why: "the addressed agent is no longer running" }]);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 2);
		expect(message.deliver).not.toHaveBeenCalled();
	});

	it("never claims around a stranded turn: its text is in the box and later mail waits behind it", async () => {
		const submit = vi.fn<() => HeldDeliveryResult>(() => "deferred");
		holdAgentMessage(KEY, { ...hookable("one").message, submit }, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		const later = hookable("two");
		holdAgentMessage(KEY, later.message, {});

		await expect(claimHeldAgentMessagesForHook(KEY, 9_000)).resolves.toBeNull();
		expect(later.delivered).not.toHaveBeenCalled();
	});

	it("returns one notice line per taken message that has one, for the user", async () => {
		holdAgentMessage(KEY, hookable("one", { hook: { text: "inline:one", delivered: vi.fn(), notice: "dev3 message from #2: first" } }).message, {});
		holdAgentMessage(KEY, hookable("two").message, {});
		holdAgentMessage(KEY, hookable("three", { hook: { text: "inline:three", delivered: vi.fn(), notice: "dev3 message from #5: third" } }).message, {});
		const claim = await claimHeldAgentMessagesForHook(KEY, 9_000);
		expect(claim?.notices).toEqual(["dev3 message from #2: first", "dev3 message from #5: third"]);
	});

	it("finds nothing for a pane with no hold", async () => {
		await expect(claimHeldAgentMessagesForHook(agentMessageHoldKey("tmux", "task-1", "%9"), 9_000)).resolves.toBeNull();
	});
});
