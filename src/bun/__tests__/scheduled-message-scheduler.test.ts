import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The scheduler reaches Electrobun-backed modules transitively; stub the heavy
// ones and drive delivery/notification through spies.
vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => []),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => []),
	getTask: vi.fn(),
	updateTaskWith: vi.fn(),
}));
vi.mock("../agent-prompt", () => ({
	sendPromptToAgentPane: vi.fn(async () => true),
	sendPromptToPane: vi.fn(async () => true),
}));
vi.mock("../agent-prompt-native", () => ({
	sendPromptToNativeAgentPane: vi.fn(async () => true),
	sendPromptToNativePane: vi.fn(async () => true),
}));
vi.mock("../pty-server", () => ({ DEFAULT_TMUX_SOCKET: "dev3" }));
const pushFn = vi.fn();
vi.mock("../rpc-handlers", () => ({
	getPushMessage: vi.fn(() => pushFn),
	pushCliToast: vi.fn((payload: unknown) => pushFn("cliToast", payload)),
	pushCliAttention: vi.fn((payload: unknown) => pushFn("cliAttention", payload)),
	pushAgentMessage: vi.fn((payload: unknown) => pushFn("agentMessage", payload)),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as data from "../data";
import { sendPromptToAgentPane, sendPromptToPane } from "../agent-prompt";
import { sendPromptToNativeAgentPane, sendPromptToNativePane } from "../agent-prompt-native";
import {
	startScheduledMessageScheduler,
	stopScheduledMessageScheduler,
	fireScheduledMessage,
	scheduleMessage,
	cancelScheduledMessage,
	sendScheduledMessageNow,
	sendMessageImmediately,
} from "../scheduled-message-scheduler";

const project = { id: "proj-1", name: "Proj" } as unknown as import("../../shared/types").Project;

function makeMessage(overrides: Record<string, unknown> = {}) {
	return {
		id: "msg-1",
		text: "check CI and continue",
		at: new Date(Date.now() - 1000).toISOString(),
		target: { kind: "agent" as const },
		...overrides,
	};
}

function makeTask(overrides: Record<string, unknown> = {}) {
	return {
		id: "task-12345678",
		projectId: "proj-1",
		seq: 42,
		title: "T",
		status: "in-progress",
		scheduledMessages: [makeMessage()],
		sessionState: { panes: [{ paneId: "%1", agentCmd: "claude", sessionId: null, agentId: null, configId: null }] },
		...overrides,
	};
}

async function flush() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** updateTaskWith mock: apply the mutator to the given task snapshot. */
function mockUpdateTaskWith(task: Record<string, unknown>) {
	const impl = async (
		_p: unknown,
		_id: unknown,
		mutator: (t: unknown) => Promise<{ updates: object; result: unknown }> | { updates: object; result: unknown },
	) => {
		const { updates, result } = await mutator(task);
		return { task: { ...task, ...updates }, result };
	};
	vi.mocked(data.updateTaskWith).mockImplementation(impl as unknown as typeof data.updateTaskWith);
}

/** A tmux send the server accepted, as the pane-input seam reports it. */
const TMUX_DELIVERED = { deliveryId: "d1", backend: "tmux", paneId: "%1", status: "delivered", acceptedThrough: 2 } as const;

/** A tmux pane that is provably gone: nothing was sent. */
const TMUX_PANE_GONE = {
	deliveryId: "d1",
	backend: "tmux",
	paneId: "%1",
	status: "not-started",
	reason: "pane-absent",
	retryableAsNewDelivery: false,
} as const;

/** The best a native write can report — it is never "delivered". */
const NATIVE_UNCONFIRMED = { status: "unconfirmed", reason: "unacknowledged" } as const;

beforeEach(() => {
	vi.mocked(data.loadProjects).mockResolvedValue([project]);
	vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
	pushFn.mockClear();
	vi.mocked(sendPromptToAgentPane).mockResolvedValue(TMUX_DELIVERED);
	vi.mocked(sendPromptToPane).mockResolvedValue(TMUX_DELIVERED);
	vi.mocked(sendPromptToNativeAgentPane).mockResolvedValue(NATIVE_UNCONFIRMED);
	vi.mocked(sendPromptToNativePane).mockResolvedValue(NATIVE_UNCONFIRMED);
});

afterEach(() => {
	stopScheduledMessageScheduler();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("scheduled-message scheduler — tick", () => {
	it("delivers a due message and removes it from the queue", async () => {
		const task = makeTask();
		mockUpdateTaskWith(task);
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledMessageScheduler();
		await flush();
		expect(sendPromptToAgentPane).toHaveBeenCalledTimes(1);
		expect(sendPromptToAgentPane).toHaveBeenCalledWith(expect.objectContaining({ id: "task-12345678" }), "check CI and continue", task.sessionState.panes, { coalesceSubmit: true });
		// removed via updateTaskWith
		expect(data.updateTaskWith).toHaveBeenCalledWith(project, task.id, expect.any(Function));
	});

	it("does not deliver a message scheduled in the future", async () => {
		const task = makeTask({ scheduledMessages: [makeMessage({ at: new Date(Date.now() + 3_600_000).toISOString() })] });
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledMessageScheduler();
		await flush();
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("drops a message with an unparseable time without delivering", async () => {
		const task = makeTask({ scheduledMessages: [makeMessage({ at: "not-a-date" })] });
		mockUpdateTaskWith(task);
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledMessageScheduler();
		await flush();
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
		expect(data.updateTaskWith).toHaveBeenCalled();
	});

	it("routes a pane-target message to the concrete pane", async () => {
		const task = makeTask({ scheduledMessages: [makeMessage({ target: { kind: "pane", paneId: "%3" } })] });
		mockUpdateTaskWith(task);
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledMessageScheduler();
		await flush();
		expect(sendPromptToPane).toHaveBeenCalledWith(expect.objectContaining({ id: "task-12345678" }), "%3", "check CI and continue", { coalesceSubmit: true });
	});

	it("start is idempotent (double start = one tick)", async () => {
		const task = makeTask();
		mockUpdateTaskWith(task);
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledMessageScheduler();
		startScheduledMessageScheduler();
		await flush();
		expect(sendPromptToAgentPane).toHaveBeenCalledTimes(1);
	});
});

describe("fireScheduledMessage — notification semantics", () => {
	it("is silent on a normal (non-late) successful delivery", async () => {
		const task = makeTask();
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, makeMessage() as never, { late: false });
		expect(sendPromptToAgentPane).toHaveBeenCalled();
		expect(pushFn).not.toHaveBeenCalledWith("cliToast", expect.anything());
	});

	it("is NEVER silent on an unconfirmed delivery, even a non-late one", async () => {
		// The message leaves the queue whatever happened, so silence would read as
		// "delivered" and the text would be unrecoverable. This is the native backend's
		// everyday answer, not an edge case.
		vi.mocked(sendPromptToAgentPane).mockResolvedValue({
			deliveryId: "d1",
			backend: "tmux",
			paneId: "%1",
			status: "indeterminate",
			possiblyAcceptedThrough: 2,
			reason: "backend-failure",
		});
		const task = makeTask();
		mockUpdateTaskWith(task);

		const { delivery } = await fireScheduledMessage(project, task as never, makeMessage() as never, { late: false });

		expect(delivery.status).toBe("unconfirmed");
		expect(pushFn).toHaveBeenCalledWith("cliToast", expect.objectContaining({ level: "info" }));
		expect(pushFn).toHaveBeenCalledWith("cliAttention", expect.objectContaining({ taskId: task.id }));
		// Not the failure line: the text may well be in the agent already.
		expect(pushFn).not.toHaveBeenCalledWith("cliToast", expect.objectContaining({ level: "error" }));
	});

	it("does not throw an unconfirmed immediate send back at the caller", async () => {
		// A throw reads as "nothing happened" and invites a re-send, which is a second
		// submit into a live agent.
		vi.mocked(sendPromptToAgentPane).mockResolvedValue({
			deliveryId: "d1",
			backend: "tmux",
			paneId: "%1",
			status: "indeterminate",
			possiblyAcceptedThrough: 2,
			reason: "backend-failure",
		});

		await expect(sendMessageImmediately(makeTask() as never, "hello")).resolves.toMatchObject({
			status: "unconfirmed",
		});
	});

	it("notifies success when a delivery fires late (offline catch-up)", async () => {
		const task = makeTask();
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, makeMessage() as never, { late: true });
		expect(pushFn).toHaveBeenCalledWith("cliToast", expect.objectContaining({ level: "success" }));
	});

	it("notifies (toast + attention) and drops when the target is unresolvable", async () => {
		vi.mocked(sendPromptToAgentPane).mockResolvedValue(TMUX_PANE_GONE);
		const task = makeTask();
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, makeMessage() as never, { late: false });
		expect(pushFn).toHaveBeenCalledWith("cliToast", expect.objectContaining({ level: "error" }));
		expect(pushFn).toHaveBeenCalledWith("cliAttention", expect.objectContaining({ taskId: task.id }));
		expect(data.updateTaskWith).toHaveBeenCalled(); // still removed
	});

	it("drops (never delivers) for a terminal-status task", async () => {
		const task = makeTask({ status: "completed" });
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, makeMessage() as never, { late: false });
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
		expect(pushFn).toHaveBeenCalledWith("cliToast", expect.objectContaining({ level: "error" }));
	});
});

describe("scheduleMessage — validation + queueing", () => {
	it("appends a valid future message and broadcasts", async () => {
		const task = makeTask({ scheduledMessages: [] });
		mockUpdateTaskWith(task);
		const at = new Date(Date.now() + 600_000).toISOString();
		await scheduleMessage(project, task as never, { text: "later", at });
		expect(data.updateTaskWith).toHaveBeenCalled();
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: project.id }));
	});

	it("rejects empty text", async () => {
		const task = makeTask();
		await expect(scheduleMessage(project, task as never, { text: "   ", at: new Date(Date.now() + 60_000).toISOString() }))
			.rejects.toThrow(/required/i);
	});

	it("rejects a time in the past", async () => {
		const task = makeTask();
		await expect(scheduleMessage(project, task as never, { text: "x", at: new Date(Date.now() - 60_000).toISOString() }))
			.rejects.toThrow(/future/i);
	});

	it("rejects when the per-task cap is reached", async () => {
		const full = Array.from({ length: 20 }, (_, i) => makeMessage({ id: `m${i}` }));
		const task = makeTask({ scheduledMessages: full });
		mockUpdateTaskWith(task);
		await expect(scheduleMessage(project, task as never, { text: "x", at: new Date(Date.now() + 60_000).toISOString() }))
			.rejects.toThrow(/too many/i);
	});

	it("rejects scheduling for a terminal-status task", async () => {
		const task = makeTask({ status: "cancelled" });
		await expect(scheduleMessage(project, task as never, { text: "x", at: new Date(Date.now() + 60_000).toISOString() }))
			.rejects.toThrow(/completed or cancelled/i);
	});
});

describe("cancel / send-now / immediate", () => {
	it("cancelScheduledMessage removes the item and broadcasts", async () => {
		const task = makeTask();
		vi.mocked(data.getTask).mockResolvedValue(task as never);
		mockUpdateTaskWith(task);
		await cancelScheduledMessage(project, task.id, "msg-1");
		expect(data.updateTaskWith).toHaveBeenCalled();
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.anything());
	});

	it("sendScheduledMessageNow delivers and removes the item", async () => {
		const task = makeTask();
		vi.mocked(data.getTask).mockResolvedValue(task as never);
		mockUpdateTaskWith(task);
		await sendScheduledMessageNow(project, task.id, "msg-1");
		expect(sendPromptToAgentPane).toHaveBeenCalled();
	});

	it("sendScheduledMessageNow throws for an unknown message id", async () => {
		const task = makeTask();
		vi.mocked(data.getTask).mockResolvedValue(task as never);
		await expect(sendScheduledMessageNow(project, task.id, "nope")).rejects.toThrow(/not found/i);
	});

	it("sendMessageImmediately delivers to the agent", async () => {
		const task = makeTask();
		await sendMessageImmediately(task as never, "hello now");
		expect(sendPromptToAgentPane).toHaveBeenCalledWith(expect.objectContaining({ id: "task-12345678" }), "hello now", task.sessionState.panes, { coalesceSubmit: true });
	});

	it("sendMessageImmediately wraps a cross-task message in the envelope", async () => {
		const task = makeTask();
		await sendMessageImmediately(task as never, "hello now", null, { taskId: "other", seq: 7, title: "Sender" });
		const text = vi.mocked(sendPromptToAgentPane).mock.calls[0]![1];
		expect(text).toContain("<dev3-ai-message>");
		expect(text).toContain("<from-task>seq:7</from-task>");
		expect(text).toContain("hello now");
	});

	it("fireScheduledMessage wraps a queued cross-task message but stores it plain", async () => {
		const message = makeMessage({ source: { taskId: "other", seq: 7 } });
		const task = makeTask({ scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, message as never, { late: false });
		const text = vi.mocked(sendPromptToAgentPane).mock.calls[0]![1];
		expect(text).toContain("<from-task>seq:7</from-task>");
		expect(message.text).toBe("check CI and continue");
	});

	it("announces an agent-to-agent send so the user sees who wrote to whom", async () => {
		const task = makeTask();
		await sendMessageImmediately(task as never, "check the payload", null, {
			taskId: "other",
			seq: 7,
			title: "Coordinator",
			projectId: "proj-9",
		});
		expect(pushFn).toHaveBeenCalledWith("agentMessage", {
			taskId: "task-12345678",
			projectId: "proj-1",
			toSeq: 42,
			toTitle: "T",
			fromSeq: 7,
			fromTitle: "Coordinator",
			fromProjectId: "proj-9",
			preview: "check the payload",
		});
	});

	it("stays silent for a message the human sent", async () => {
		await sendMessageImmediately(makeTask() as never, "hello now");
		expect(pushFn).not.toHaveBeenCalledWith("agentMessage", expect.anything());
	});

	it("does not announce an agent-to-agent send that landed nowhere", async () => {
		vi.mocked(sendPromptToAgentPane).mockResolvedValue(TMUX_PANE_GONE);
		await expect(
			sendMessageImmediately(makeTask() as never, "hi", null, { taskId: "other", seq: 7 }),
		).rejects.toThrow(/no live agent/i);
		expect(pushFn).not.toHaveBeenCalledWith("agentMessage", expect.anything());
	});

	it("announces a queued cross-task fire through the same seam", async () => {
		const message = makeMessage({ source: { taskId: "other", seq: 7, title: "Coordinator" } });
		const task = makeTask({ scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, message as never, { late: false });
		expect(pushFn).toHaveBeenCalledWith(
			"agentMessage",
			expect.objectContaining({ fromSeq: 7, toSeq: 42, preview: "check CI and continue" }),
		);
	});

	it("sendMessageImmediately throws when nothing is live to deliver to", async () => {
		vi.mocked(sendPromptToAgentPane).mockResolvedValue(TMUX_PANE_GONE);
		const task = makeTask();
		await expect(sendMessageImmediately(task as never, "hello")).rejects.toThrow(/no live agent/i);
	});
});

// Both entry points — the immediate `dev3 message` send and the queued
// "Send later" fire — go through ONE seam (deliverToTarget → deliverAgentPrompt),
// so a native task must reach the native adapter from either of them.
describe("scheduled-message scheduler — native-backend tasks", () => {
	const nativeTask = (overrides: Record<string, unknown> = {}) =>
		makeTask({ terminalBackend: "native", worktreePath: "/tmp/worktree", ...overrides });

	it("sendMessageImmediately delivers through the native adapter, not tmux", async () => {
		const task = nativeTask();
		await sendMessageImmediately(task as never, "hello now");
		expect(sendPromptToNativeAgentPane).toHaveBeenCalledWith(
			expect.objectContaining({ id: task.id }),
			"hello now",
			{ coalesceSubmit: true },
		);
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("sendMessageImmediately still fails honestly when no native agent is live", async () => {
		vi.mocked(sendPromptToNativeAgentPane).mockResolvedValue({ status: "not-delivered", reason: "pane-absent" });
		await expect(sendMessageImmediately(nativeTask() as never, "hello")).rejects.toThrow(/no live agent/i);
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("a due queued message fires through the native adapter and leaves the queue", async () => {
		const task = nativeTask();
		mockUpdateTaskWith(task);
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledMessageScheduler();
		await flush();
		expect(sendPromptToNativeAgentPane).toHaveBeenCalledTimes(1);
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("an undeliverable queued message drops with the no-live-agent notice", async () => {
		vi.mocked(sendPromptToNativeAgentPane).mockResolvedValue({ status: "not-delivered", reason: "pane-absent" });
		const message = makeMessage();
		const task = nativeTask({ scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		const { delivery } = await fireScheduledMessage(project, task as never, message as never, { late: false });
		expect(delivery.status).toBe("not-delivered");
		expect(pushFn).toHaveBeenCalledWith("cliToast", expect.objectContaining({ level: "error" }));
	});

	it("wraps a cross-task message in the envelope on the native path too", async () => {
		const task = nativeTask();
		await sendMessageImmediately(task as never, "hello now", null, { taskId: "other", seq: 7, title: "Sender" });
		const text = vi.mocked(sendPromptToNativeAgentPane).mock.calls[0]![1];
		expect(text).toContain("<from-task>seq:7</from-task>");
		expect(text).toContain("hello now");
	});
});
