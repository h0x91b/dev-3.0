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
vi.mock("../pty-server", () => ({ DEFAULT_TMUX_SOCKET: "dev3" }));
const pushFn = vi.fn();
vi.mock("../rpc-handlers", () => ({ getPushMessage: vi.fn(() => pushFn) }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as data from "../data";
import { sendPromptToAgentPane, sendPromptToPane } from "../agent-prompt";
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

beforeEach(() => {
	vi.mocked(data.loadProjects).mockResolvedValue([project]);
	vi.mocked(data.loadVirtualProjects).mockResolvedValue([]);
	pushFn.mockClear();
	vi.mocked(sendPromptToAgentPane).mockResolvedValue(true);
	vi.mocked(sendPromptToPane).mockResolvedValue(true);
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
		expect(sendPromptToAgentPane).toHaveBeenCalledWith("dev3-task-123", "dev3", "check CI and continue", task.sessionState.panes);
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
		expect(sendPromptToPane).toHaveBeenCalledWith("dev3-task-123", "dev3", "%3", "check CI and continue");
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

	it("notifies success when a delivery fires late (offline catch-up)", async () => {
		const task = makeTask();
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, makeMessage() as never, { late: true });
		expect(pushFn).toHaveBeenCalledWith("cliToast", expect.objectContaining({ level: "success" }));
	});

	it("notifies (toast + attention) and drops when the target is unresolvable", async () => {
		vi.mocked(sendPromptToAgentPane).mockResolvedValue(false);
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
		expect(sendPromptToAgentPane).toHaveBeenCalledWith("dev3-task-123", "dev3", "hello now", task.sessionState.panes);
	});

	it("sendMessageImmediately throws when nothing is live to deliver to", async () => {
		vi.mocked(sendPromptToAgentPane).mockResolvedValue(false);
		const task = makeTask();
		await expect(sendMessageImmediately(task as never, "hello")).rejects.toThrow(/no live agent/i);
	});
});
