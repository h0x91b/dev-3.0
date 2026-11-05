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
	// A message is HELD, never typed on arrival: always for one pane, which the seam picks.
	holdMessageForPane: vi.fn(async () => ({ status: "held" })),
}));
vi.mock("../agent-message-target", () => ({
	resolveMainAgentTarget: vi.fn(),
	addressedAgentRefusal: vi.fn(async () => null),
	agentPaneRoles: vi.fn(async () => new Map([["%1", "main"], ["%2", "agent"]])),
	isSoleMainAgent: vi.fn(async () => false),
}));
vi.mock("../cli-socket/task-resolution", () => ({
	resolveTaskAcrossProjects: vi.fn(async (taskId: string) => ({ project: { id: "proj-2" }, task: { id: taskId } })),
}));
vi.mock("../agent-prompt-native", () => ({
	sendPromptToNativeAgentPane: vi.fn(async () => true),
	sendPromptToNativePane: vi.fn(async () => true),
}));
vi.mock("../pty-server", () => ({ DEFAULT_TMUX_SOCKET: "dev3" }));
vi.mock("../scheduled-message-author", () => ({
	resolveScheduledMessageAuthorPane: vi.fn(async (_task: unknown, author: { paneId: string }) => ({ ok: true, paneId: author.paneId })),
}));
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
import { holdMessageForPane, sendPromptToAgentPane, sendPromptToPane } from "../agent-prompt";
import { isSoleMainAgent, resolveMainAgentTarget } from "../agent-message-target";
import { encodeAgentHandle } from "../../shared/agent-handle";
import { sendPromptToNativeAgentPane, sendPromptToNativePane } from "../agent-prompt-native";
import { resolveScheduledMessageAuthorPane } from "../scheduled-message-author";
import {
	startScheduledMessageScheduler,
	stopScheduledMessageScheduler,
	fireScheduledMessage,
	scheduleMessage,
	cancelScheduledMessage,
	cancelScheduledMessageByRef,
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
	for (let i = 0; i < 30; i++) await Promise.resolve();
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

/** A message dev3 accepted with nothing typed yet — what every message path now answers. */
const HELD = { status: "held", detail: "held until the pane goes quiet" } as const;

/** A pane that is provably gone: nothing was sent and nothing is held. */
const PANE_GONE = { status: "not-delivered", reason: "pane-absent" } as const;

/** A hold whose delivery could not be confirmed — the native arm's own answer. */
const HOLD_UNCONFIRMED = { status: "unconfirmed", reason: "owner-unreachable" } as const;

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
	vi.mocked(holdMessageForPane).mockResolvedValue(HELD);
	vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: true, paneId: "%1", author: null });
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
		expect(holdMessageForPane).toHaveBeenCalledTimes(1);
		expect(holdMessageForPane).toHaveBeenCalledWith(expect.objectContaining({ id: "task-12345678" }), "%1", "check CI and continue", expect.any(Function), undefined);
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
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
		expect(holdMessageForPane).toHaveBeenCalledWith(expect.objectContaining({ id: "task-12345678" }), "%3", "check CI and continue", expect.any(Function), undefined);
	});

	it("start is idempotent (double start = one tick)", async () => {
		const task = makeTask();
		mockUpdateTaskWith(task);
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledMessageScheduler();
		startScheduledMessageScheduler();
		await flush();
		expect(holdMessageForPane).toHaveBeenCalledTimes(1);
	});
});

describe("fireScheduledMessage — notification semantics", () => {
	it("is silent on a normal (non-late) successful delivery", async () => {
		const task = makeTask();
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, makeMessage() as never, { late: false });
		expect(holdMessageForPane).toHaveBeenCalled();
		expect(pushFn).not.toHaveBeenCalledWith("cliToast", expect.anything());
	});

	it("is NEVER silent on an unconfirmed delivery, even a non-late one", async () => {
		// The message leaves the queue whatever happened, so silence would read as
		// "delivered" and the text would be unrecoverable. This is the native backend's
		// everyday answer, not an edge case.
		vi.mocked(holdMessageForPane).mockResolvedValue(HOLD_UNCONFIRMED);
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
		vi.mocked(holdMessageForPane).mockResolvedValue(HOLD_UNCONFIRMED);

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
		vi.mocked(holdMessageForPane).mockResolvedValue(PANE_GONE);
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
		expect(holdMessageForPane).not.toHaveBeenCalled();
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

	it("cancelScheduledMessageByRef removes exactly the message its prefix names", async () => {
		const task = makeTask({ scheduledMessages: [makeMessage({ id: "abc-111" }), makeMessage({ id: "def-222" })] });
		mockUpdateTaskWith(task);
		const { task: updated, message } = await cancelScheduledMessageByRef(project, task.id, "ABC");
		expect(message.id).toBe("abc-111");
		expect((updated.scheduledMessages ?? []).map((m) => m.id)).toEqual(["def-222"]);
		expect(pushFn).toHaveBeenCalledWith("taskUpdated", expect.anything());
	});

	it("cancelScheduledMessageByRef refuses a missing (already fired) or ambiguous id without writing", async () => {
		const task = makeTask({ scheduledMessages: [makeMessage({ id: "abc-111" }), makeMessage({ id: "abc-222" })] });
		mockUpdateTaskWith(task);
		await expect(cancelScheduledMessageByRef(project, task.id, "zzz")).rejects.toThrow(/may have fired already/);
		await expect(cancelScheduledMessageByRef(project, task.id, "abc")).rejects.toThrow(/ambiguous/);
		await expect(cancelScheduledMessageByRef(project, task.id, "  ")).rejects.toThrow(/required/);
		expect(pushFn).not.toHaveBeenCalled();
	});

	// "Send now" on the chip is a click, so it types at once — the same reason the
	// review comment's "Send to agent" does. A hold here looked like a dead button.
	it("sendScheduledMessageNow delivers at once and removes the item", async () => {
		const task = makeTask();
		vi.mocked(data.getTask).mockResolvedValue(task as never);
		mockUpdateTaskWith(task);
		await sendScheduledMessageNow(project, task.id, "msg-1");
		expect(sendPromptToAgentPane).toHaveBeenCalled();
		expect(holdMessageForPane).not.toHaveBeenCalled();
	});

	it("sendScheduledMessageNow throws for an unknown message id", async () => {
		const task = makeTask();
		vi.mocked(data.getTask).mockResolvedValue(task as never);
		await expect(sendScheduledMessageNow(project, task.id, "nope")).rejects.toThrow(/not found/i);
	});

	it("sendMessageImmediately delivers to the agent", async () => {
		const task = makeTask();
		await sendMessageImmediately(task as never, "hello now");
		expect(holdMessageForPane).toHaveBeenCalledWith(expect.objectContaining({ id: "task-12345678" }), "%1", "hello now", expect.any(Function), undefined);
	});

	// The click paths (a review comment's "Send to agent", the launch handoff) opt out
	// of the hold: the user is watching that pane and a held message reads as a button
	// that did nothing. Asserted on the tmux helpers rather than on the flag, so the
	// test breaks if the flag stops reaching the backend.
	it("sendMessageImmediately types and submits at once when the caller opts out of the hold", async () => {
		const task = makeTask();
		await sendMessageImmediately(task as never, "fix this", null, null, { hold: false });
		expect(sendPromptToAgentPane).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), "fix this", task.sessionState.panes);
		expect(holdMessageForPane).not.toHaveBeenCalled();
	});

	it("sendMessageImmediately holds by default — an omitted flag is never an instant send", async () => {
		await sendMessageImmediately(makeTask() as never, "hello now");
		expect(holdMessageForPane).toHaveBeenCalled();
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("sendMessageImmediately wraps a cross-task message in the envelope", async () => {
		const task = makeTask();
		await sendMessageImmediately(task as never, "hello now", null, { taskId: "other", seq: 7, title: "Sender" });
		const text = vi.mocked(holdMessageForPane).mock.calls[0]![2];
		expect(text).toContain("<dev3-ai-message>");
		expect(text).toContain("<from-task>seq:7</from-task>");
		expect(text).toContain("hello now");
	});

	const senderAgent = { paneId: "%5", sessionId: null, paneToken: "gen-1", agentProcess: "501@Mon Oct 26 09:00:00 2026" };

	it("scopes the reply command when the sender sits on another project", async () => {
		const task = makeTask();
		await sendMessageImmediately(task as never, "hello now", null, {
			taskId: "other",
			seq: 7,
			projectId: "proj-2-abcdef",
			agent: senderAgent,
		});
		const text = vi.mocked(holdMessageForPane).mock.calls[0]![2];
		expect(text).toContain(`<reply-with>dev3 message --task seq:7 --project proj-2-a --agent ${encodeAgentHandle(senderAgent)} --subject "what your reply is about" "your reply"</reply-with>`);
	});

	it("leaves the reply command bare for a sender on the same project", async () => {
		const task = makeTask();
		await sendMessageImmediately(task as never, "hello now", null, {
			taskId: "other",
			seq: 7,
			projectId: "proj-1",
			agent: senderAgent,
		});
		const text = vi.mocked(holdMessageForPane).mock.calls[0]![2];
		expect(text).toContain(`<reply-with>dev3 message --task seq:7 --agent ${encodeAgentHandle(senderAgent)} --subject "what your reply is about" "your reply"</reply-with>`);
	});

	it("drops --agent when the sender is its task's only agent, asked at delivery", async () => {
		vi.mocked(isSoleMainAgent).mockResolvedValueOnce(true);
		await sendMessageImmediately(makeTask() as never, "hello now", null, { taskId: "other", seq: 7, projectId: "proj-1", agent: senderAgent });
		const text = vi.mocked(holdMessageForPane).mock.calls[0]![2];
		expect(isSoleMainAgent).toHaveBeenCalledWith({ id: "other" }, senderAgent);
		expect(text).toContain(`<reply-with>dev3 message --task seq:7 --subject "what your reply is about" "your reply"</reply-with>`);
	});

	it("offers no reply command at all when the sending agent could not be proven", async () => {
		await sendMessageImmediately(makeTask() as never, "hello now", null, {
			taskId: "other",
			seq: 7,
			projectId: "proj-1",
			agentUnavailable: "agent identity cannot be verified on Windows yet",
		});
		const text = vi.mocked(holdMessageForPane).mock.calls[0]![2];
		expect(text).not.toContain("<reply-with>");
		expect(text).not.toContain("dev3 message --task");
		expect(text).toContain("<reply-unavailable>agent identity cannot be verified on Windows yet</reply-unavailable>");
	});

	it("fireScheduledMessage wraps a queued cross-task message but stores it plain", async () => {
		const message = makeMessage({ source: { taskId: "other", seq: 7 } });
		const task = makeTask({ scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, message as never, { late: false });
		const text = vi.mocked(holdMessageForPane).mock.calls[0]![2];
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
			fromTaskId: "other",
			preview: "check the payload",
		});
	});

	// The toast links both ends by id, and `#21-2` must name the exact attempt:
	// a seq alone is ambiguous inside a variant group.
	it("carries the sender's id and both variant indices for the toast's links", async () => {
		const task = makeTask({ variantIndex: 3 });
		await sendMessageImmediately(task as never, "check the payload", null, {
			taskId: "sender-id",
			seq: 7,
			variantIndex: 2,
		});
		expect(pushFn).toHaveBeenCalledWith(
			"agentMessage",
			expect.objectContaining({ fromTaskId: "sender-id", fromVariantIndex: 2, toVariantIndex: 3 }),
		);
	});

	it("stays silent for a message the human sent", async () => {
		await sendMessageImmediately(makeTask() as never, "hello now");
		expect(pushFn).not.toHaveBeenCalledWith("agentMessage", expect.anything());
	});

	it("does not announce an agent-to-agent send that landed nowhere", async () => {
		vi.mocked(holdMessageForPane).mockResolvedValue(PANE_GONE);
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
		vi.mocked(holdMessageForPane).mockResolvedValue(PANE_GONE);
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

	const MAIN_GONE = "the task's main agent (pane pane-1) is not running; not sent to another agent.";

	it("sendMessageImmediately holds it for the native main agent pane, not tmux", async () => {
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: true, paneId: "pane-1", author: null });
		const task = nativeTask();
		await sendMessageImmediately(task as never, "hello now");
		expect(sendPromptToNativePane).toHaveBeenCalledWith(
			expect.objectContaining({ id: task.id }),
			"pane-1",
			"hello now",
			{ hold: true, verify: undefined },
		);
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
		expect(holdMessageForPane).not.toHaveBeenCalled();
	});

	it("carries the caller's opt-out into the native adapter", async () => {
		const task = nativeTask();
		await sendMessageImmediately(task as never, "fix this", null, null, { hold: false });
		expect(sendPromptToNativeAgentPane).toHaveBeenCalledWith(
			expect.objectContaining({ id: task.id }),
			"fix this",
			{ hold: false, epilogue: expect.any(Function), author: null },
		);
	});

	it("sendMessageImmediately says which agent is gone when the native main agent is not running", async () => {
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: false, detail: MAIN_GONE });
		await expect(sendMessageImmediately(nativeTask() as never, "hello")).rejects.toThrow(/main agent \(pane pane-1\) is not running/);
		expect(sendPromptToNativePane).not.toHaveBeenCalled();
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("a due queued message fires through the native adapter and leaves the queue", async () => {
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: true, paneId: "pane-1", author: null });
		const task = nativeTask();
		mockUpdateTaskWith(task);
		vi.mocked(data.loadTasks).mockResolvedValue([task] as never);
		startScheduledMessageScheduler();
		await flush();
		expect(sendPromptToNativePane).toHaveBeenCalledTimes(1);
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
		expect(data.updateTaskWith).toHaveBeenCalledWith(project, task.id, expect.any(Function));
	});

	it("an undeliverable queued message drops with the no-live-agent notice", async () => {
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: false, detail: MAIN_GONE });
		const message = makeMessage();
		const task = nativeTask({ scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		const { delivery } = await fireScheduledMessage(project, task as never, message as never, { late: false });
		expect(delivery.status).toBe("not-delivered");
		expect(pushFn).toHaveBeenCalledWith("cliToast", expect.objectContaining({ level: "error" }));
	});

	it("wraps a cross-task message in the envelope on the native path too", async () => {
		const task = nativeTask();
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: true, paneId: "pane-1", author: null });
		await sendMessageImmediately(task as never, "hello now", null, { taskId: "other", seq: 7, title: "Sender" });
		const text = vi.mocked(sendPromptToNativePane).mock.calls[0]![2];
		expect(text).toContain("<from-task>seq:7</from-task>");
		expect(text).toContain("hello now");
	});
});

describe("scheduled-message scheduler — self-reminders in a multi-agent task", () => {
	const twoAgents = {
		panes: [
			{ paneId: "%1", agentCmd: "claude", sessionId: "conv-a", agentId: null, configId: null },
			{ paneId: "%2", agentCmd: "claude", sessionId: "conv-b", agentId: null, configId: null },
		],
	};
	const authorB = { paneId: "%2", sessionId: "conv-b", paneToken: "gen-1", agentProcess: "201@Mon Oct  5 09:00:00 2026" };

	it("fires to the agent that scheduled it, never through the focus-based task resolver", async () => {
		const message = makeMessage({ author: authorB });
		const task = makeTask({ sessionState: twoAgents, scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		const { delivery } = await fireScheduledMessage(project, task as never, message, { late: false });
		expect(delivery.status).toBe("held");
		expect(holdMessageForPane).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), "%2", "check CI and continue", expect.any(Function), expect.any(Function));
		expect(resolveMainAgentTarget).not.toHaveBeenCalled();
	});

	it("fires a native extra agent's self-reminder into its own native pane, not pane-1", async () => {
		const message = makeMessage({ author: { ...authorB, paneId: "pane-2", sessionId: null, paneToken: "native-s2" } });
		const task = makeTask({ terminalBackend: "native", sessionState: { panes: [] }, scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		await fireScheduledMessage(project, task as never, message, { late: false });
		expect(sendPromptToNativePane).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), "pane-2", "check CI and continue", expect.anything());
		expect(sendPromptToNativeAgentPane).not.toHaveBeenCalled();
	});

	it("'Send now' on a self-reminder types into the author's pane", async () => {
		const message = makeMessage({ author: authorB });
		const task = makeTask({ sessionState: twoAgents, scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		vi.mocked(data.getTask).mockResolvedValue(task as never);
		await sendScheduledMessageNow(project, task.id, message.id);
		expect(sendPromptToPane).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), "%2", "check CI and continue");
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("drops with a notice when the author is gone, instead of reaching the sibling", async () => {
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValueOnce({ ok: false, detail: "the agent is no longer running" });
		const message = makeMessage({ author: authorB });
		const task = makeTask({ sessionState: twoAgents, scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		const { delivery, task: after } = await fireScheduledMessage(project, task as never, message, { late: false });
		expect(delivery).toMatchObject({ status: "not-delivered", reason: "pane-absent" });
		expect(holdMessageForPane).not.toHaveBeenCalled();
		expect(resolveMainAgentTarget).not.toHaveBeenCalled();
		expect(after.scheduledMessages).toEqual([]);
		expect(pushFn).toHaveBeenCalledWith("cliToast", expect.objectContaining({
			level: "error",
			message: expect.stringContaining("the agent that scheduled it is gone"),
		}));
	});

	it("keeps the author through tasks.json and fires to it after a reload", async () => {
		const task = makeTask({ sessionState: twoAgents, scheduledMessages: [] });
		mockUpdateTaskWith(task);
		const queued = await scheduleMessage(project, task as never, {
			text: "wake up", at: new Date(Date.now() + 60_000).toISOString(), author: authorB,
		});
		const reloaded = JSON.parse(JSON.stringify(queued)) as typeof task;
		const message = reloaded.scheduledMessages[0]!;
		expect(message).toMatchObject({ target: { kind: "agent" }, author: authorB });
		mockUpdateTaskWith(reloaded);
		await fireScheduledMessage(project, reloaded as never, message, { late: true });
		expect(holdMessageForPane).toHaveBeenCalledWith(expect.anything(), "%2", "wake up", expect.any(Function), expect.any(Function));
	});

	it("leaves a message without an author on the task-level route", async () => {
		const message = makeMessage();
		const task = makeTask({ sessionState: twoAgents, scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		const queued = await scheduleMessage(project, task as never, { text: "x", at: new Date(Date.now() + 60_000).toISOString() });
		expect(queued.scheduledMessages?.[queued.scheduledMessages.length - 1]).not.toHaveProperty("author");
		await fireScheduledMessage(project, task as never, message, { late: false });
		expect(resolveMainAgentTarget).toHaveBeenCalledTimes(1);
		expect(holdMessageForPane).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), "%1", "check CI and continue", expect.any(Function), undefined);
	});

	it("holds an immediate message addressed to one agent for that agent, bound for the release check", async () => {
		const task = makeTask({ sessionState: twoAgents });
		await sendMessageImmediately(task as never, "review the diff", null, { taskId: "other", seq: 7 }, { author: authorB });
		expect(resolveScheduledMessageAuthorPane).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), authorB);
		expect(holdMessageForPane).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), "%2", expect.stringContaining("review the diff"), expect.any(Function), expect.any(Function));
		expect(resolveMainAgentTarget).not.toHaveBeenCalled();
	});

	it("refuses an addressed message whose agent is gone, saying so, and never falls back to the main agent", async () => {
		vi.mocked(resolveScheduledMessageAuthorPane).mockResolvedValueOnce({
			ok: false,
			detail: "the addressed agent (pane %2) is no longer running in this task; not sent to another pane",
		});
		await expect(
			sendMessageImmediately(makeTask({ sessionState: twoAgents }) as never, "review the diff", null, null, { author: authorB }),
		).rejects.toThrow(/the addressed agent \(pane %2\) is no longer running/);
		expect(holdMessageForPane).not.toHaveBeenCalled();
		expect(resolveMainAgentTarget).not.toHaveBeenCalled();
		expect(sendPromptToAgentPane).not.toHaveBeenCalled();
	});

	it("reports the pane it went to and which of the task's agents runs there", async () => {
		vi.mocked(holdMessageForPane).mockResolvedValueOnce({ ...HELD, paneId: "%2" });
		await expect(
			sendMessageImmediately(makeTask({ sessionState: twoAgents }) as never, "review the diff", null, null, { author: authorB }),
		).resolves.toMatchObject({ status: "held", paneId: "%2", agentRole: "agent" });
	});

	it("cancels a self-reminder by id like any other", async () => {
		const message = makeMessage({ id: "abc12345", author: authorB });
		const task = makeTask({ sessionState: twoAgents, scheduledMessages: [message] });
		mockUpdateTaskWith(task);
		const { task: after } = await cancelScheduledMessageByRef(project, task.id, "abc1");
		expect(after.scheduledMessages).toEqual([]);
		expect(holdMessageForPane).not.toHaveBeenCalled();
	});
});

describe("sendMessageImmediately as an external sender", () => {
	it("goes to the main agent, wrapped in the sender envelope with its message id and only the --to-sender reply", async () => {
		vi.mocked(resolveMainAgentTarget).mockResolvedValue({ ok: true, paneId: "%7", author: null });
		const result = await sendMessageImmediately(makeTask() as never, "hello from outside", null, null, {
			subject: "ping",
			externalSender: { id: "openclaw:home:main", label: "OpenClaw <main>" },
		});
		expect(resolveMainAgentTarget).toHaveBeenCalled();
		const calls = vi.mocked(holdMessageForPane).mock.calls;
		expect(calls[calls.length - 1]![1]).toBe("%7");
		const text = calls[calls.length - 1]![2];
		expect(text.match(/<reply-with>/g)).toHaveLength(1);
		expect(text).not.toContain("--task ");
		expect(text).toContain('<from-sender id="openclaw:home:main">OpenClaw &lt;main&gt;</from-sender>');
		expect(text).toContain(`<message-id>${result.messageId}</message-id>`);
		expect(text).toContain(
			`<reply-with>dev3 message --to-sender openclaw:home:main --in-reply-to ${result.messageId} --subject "what your reply is about" "your reply"</reply-with>`,
		);
		expect(text).not.toContain("<from-task>");
	});

	it("never announces a sender's message as task-to-task traffic", async () => {
		pushFn.mockClear();
		await sendMessageImmediately(makeTask() as never, "hi", null, null, { externalSender: { id: "cli", label: "cli" } });
		expect(pushFn.mock.calls.filter(([name]) => name === "agentMessage")).toEqual([]);
	});
});
