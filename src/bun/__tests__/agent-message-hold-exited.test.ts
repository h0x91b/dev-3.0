import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { AGENT_MESSAGE_HOLD_IDLE_MS } from "../../shared/agent-message-hold-timing";
import {
	AGENT_MESSAGE_EXITED_BOUND_MS,
	AGENT_MESSAGE_SAVE_RETRY_BOUND_MS,
	agentMessageHoldKey,
	hasStrandedAgentMessage,
	holdAgentMessage,
	pendingAgentMessageHoldCount,
	resetAgentMessageHolds,
	type HeldAgentMessage,
	type HeldAgentMessageReport,
	type HeldDeliveryResult,
	type HeldRelocation,
} from "../agent-message-hold";

const OLD = agentMessageHoldKey("tmux", "task-1", "%1");
const NEW = agentMessageHoldKey("tmux", "task-1", "%9");

interface Spy {
	message: HeldAgentMessage;
	reports: HeldAgentMessageReport[];
	saved: string[][];
}

/** A registration whose text and Enter results are scripted, with every hook recorded. */
function held(
	text: string,
	opts: {
		deliver?: () => HeldDeliveryResult;
		submit?: () => HeldDeliveryResult;
		save?: (texts: string[]) => string | null;
		relocate?: () => HeldRelocation | null;
	} = {},
): Spy {
	const reports: HeldAgentMessageReport[] = [];
	const saved: string[][] = [];
	const message: HeldAgentMessage = {
		text,
		bytes: text.length,
		deliver: vi.fn<() => HeldDeliveryResult>(opts.deliver ?? (() => "landed")),
		submit: vi.fn<() => HeldDeliveryResult>(opts.submit ?? (() => "landed")),
		report: (event) => reports.push(event),
		save: async (texts) => {
			saved.push(texts);
			return opts.save ? opts.save(texts) : `/task/messages/undelivered-${saved.length}.md`;
		},
		...(opts.relocate ? { relocate: async () => opts.relocate!() } : {}),
	};
	return { message, reports, saved };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	resetAgentMessageHolds();
	vi.useRealTimers();
});

describe("an agent that exited: nothing more is typed, nothing is discarded", () => {
	it("keeps a message whose text was refused, sends no Enter, and retries each quiet window", async () => {
		const one = held("m1", { deliver: () => "exited" });
		holdAgentMessage(OLD, one.message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(one.message.deliver).toHaveBeenCalledTimes(1);
		expect(one.message.submit).not.toHaveBeenCalled();
		expect(pendingAgentMessageHoldCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(one.message.deliver).toHaveBeenCalledTimes(2);
		expect(one.reports).toEqual([]);
	});

	it("saves and drops once the bound passes with no replacement, naming the file", async () => {
		const one = held("m1", { deliver: () => "exited" });
		holdAgentMessage(OLD, one.message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_EXITED_BOUND_MS + 2 * AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(one.saved).toEqual([["m1"]]);
		expect(one.reports).toEqual([
			expect.objectContaining({ kind: "dropped", messages: 1, paths: ["/task/messages/undelivered-1.md"] }),
		]);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	it("moves the messages to the pane that replaced the agent, in front of what is held there", async () => {
		const order: string[] = [];
		const onNew = (text: string): HeldAgentMessage => ({
			text,
			bytes: text.length,
			deliver: vi.fn(() => (order.push(`new:${text}`), "landed" as const)),
			submit: vi.fn(() => (order.push("new:enter"), "landed" as const)),
		});
		const relocation: HeldRelocation = { key: NEW, context: {}, rebuild: onNew };
		const first = held("m1", { deliver: () => "exited", relocate: () => relocation });
		const second = held("m2", { deliver: () => "exited", relocate: () => relocation });
		holdAgentMessage(OLD, first.message, {});
		holdAgentMessage(OLD, second.message, {});
		// A message for the new pane arrives LATER, and is still waiting when the old ones move.
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS / 2);
		holdAgentMessage(NEW, onNew("later"), {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(order).toEqual(["new:m1", "new:m2", "new:later", "new:enter"]);
		expect(first.message.submit).not.toHaveBeenCalled();
		expect(second.reports).toEqual([]);
		expect(pendingAgentMessageHoldCount()).toBe(0);
	});

	// No submission hook will ever come from a dead agent, so a stranded turn would wait
	// forever; and the successor never saw that text, so it is not typed into it either.
	it("saves texts that landed before an Enter the exited agent refused, and does not strand them", async () => {
		const one = held("m1", { submit: () => "exited" });
		holdAgentMessage(OLD, one.message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(one.message.deliver).toHaveBeenCalledTimes(1);
		expect(hasStrandedAgentMessage(OLD)).toBe(false);
		expect(one.saved).toEqual([["m1"]]);
		expect(one.reports[0]).toMatchObject({ kind: "dropped", messages: 1, why: expect.stringContaining("not retyped") });
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 4);
		expect(one.message.deliver).toHaveBeenCalledTimes(1);
	});
});

describe("every drop is saved first (I5 / S-1)", () => {
	it("saves messages that landed nowhere", async () => {
		const one = held("m1", { deliver: () => "failed" });
		holdAgentMessage(OLD, one.message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(one.saved).toEqual([["m1"]]);
		expect(one.reports[0]).toMatchObject({ kind: "dropped", paths: ["/task/messages/undelivered-1.md"] });
	});

	it("saves the one text of a burst that failed, while the rest is submitted", async () => {
		const ok = held("ok");
		const bad = held("bad", { deliver: () => "failed" });
		holdAgentMessage(OLD, ok.message, {});
		holdAgentMessage(OLD, bad.message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(bad.message.submit).toHaveBeenCalledTimes(1);
		expect(bad.saved).toEqual([["bad"]]);
	});

	it("never claims 'saved' when the file cannot be written: retries, then reports the text as lost", async () => {
		let writable = false;
		const one = held("m1", { deliver: () => "failed", save: () => (writable ? "/late.md" : null) });
		holdAgentMessage(OLD, one.message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 3);
		expect(one.saved.length).toBeGreaterThan(1);
		expect(one.reports).toEqual([]);
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_SAVE_RETRY_BOUND_MS + AGENT_MESSAGE_HOLD_IDLE_MS);
		expect(one.reports).toEqual([expect.objectContaining({ kind: "dropped", messages: 1, lost: 1 })]);
		expect(one.reports[0]).not.toHaveProperty("paths");
		writable = true;
	});

	it("reports the file once a retried write succeeds", async () => {
		let attempts = 0;
		const one = held("m1", { deliver: () => "failed", save: () => (++attempts >= 3 ? "/late.md" : null) });
		holdAgentMessage(OLD, one.message, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_HOLD_IDLE_MS * 4);
		expect(one.reports).toEqual([expect.objectContaining({ kind: "dropped", paths: ["/late.md"] })]);
	});
});
