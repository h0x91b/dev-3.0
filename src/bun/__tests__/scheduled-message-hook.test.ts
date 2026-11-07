import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What a held message offers the agent's PostToolUse hook: inline body or pointer,
// never for an external sender, and a receipt row once the hook took it.
vi.mock("../data", () => ({
	loadProjects: vi.fn(async () => []),
	loadVirtualProjects: vi.fn(async () => []),
	loadTasks: vi.fn(async () => []),
	getTask: vi.fn(),
	getProject: vi.fn(async () => ({ id: "proj-1", name: "Proj", path: "/tmp/proj" })),
	updateTaskWith: vi.fn(),
}));
vi.mock("../agent-prompt", () => ({
	sendPromptToAgentPane: vi.fn(async () => true),
	sendPromptToPane: vi.fn(async () => true),
	holdMessageForPane: vi.fn(async () => ({ status: "held" })),
}));
vi.mock("../agent-message-target", () => ({
	resolveMainAgentTarget: vi.fn(async () => ({ ok: true, paneId: "%1", author: null })),
	addressedAgentRefusal: vi.fn(async () => null),
	agentPaneRoles: vi.fn(async () => new Map([["%1", "main"]])),
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
	resolveScheduledMessageAuthorPane: vi.fn(),
}));
vi.mock("../agent-message-log", () => ({ appendAgentMessageLog: vi.fn(), appendAgentMessageLogReceipt: vi.fn() }));
vi.mock("../rpc-handlers", () => ({
	getPushMessage: vi.fn(() => vi.fn()),
	pushCliToast: vi.fn(),
	pushCliAttention: vi.fn(),
	pushAgentMessage: vi.fn(),
}));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as data from "../data";
import { holdMessageForPane } from "../agent-prompt";
import { appendAgentMessageLog, appendAgentMessageLogReceipt } from "../agent-message-log";
import { AGENT_MESSAGE_HOOK_MAX_CHARS } from "../agent-message-hold";
import { fireScheduledMessage, sendMessageImmediately } from "../scheduled-message-scheduler";
import type { Project } from "../../shared/types";

const project = { id: "proj-1", name: "Proj" } as unknown as Project;
const SOURCE = { taskId: "sender-task", seq: 7, title: "Sender" };
let dir: string;

function makeTask() {
	return {
		id: "task-12345678",
		projectId: "proj-1",
		seq: 42,
		title: "T",
		status: "in-progress",
		scheduledMessages: [],
		sessionState: { panes: [{ paneId: "%1", agentCmd: "claude", sessionId: null, agentId: null, configId: null }] },
	};
}

/** A queued message whose body was spilled to a file, as `scheduleMessage` stores it. */
function spilledMessage(body: string) {
	const path = join(dir, "message.md");
	writeFileSync(path, body);
	return {
		id: "msg-1",
		text: `This message is ${body.length} bytes, written to a file.\nRead it in full and act on it: ${path}`,
		at: new Date(Date.now() - 1000).toISOString(),
		target: { kind: "agent" as const },
		source: SOURCE,
		subject: "long report",
		spilledPath: path,
	};
}

/** The hook offer the last hold received (the sixth argument), or undefined. */
function lastHookOffer() {
	const calls = vi.mocked(holdMessageForPane).mock.calls;
	return calls[calls.length - 1]![5];
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dev3-hook-offer-"));
	vi.mocked(data.updateTaskWith).mockImplementation((async (_p: unknown, _id: unknown, mutator: (t: unknown) => { updates: object; result: unknown }) => {
		const task = makeTask();
		const { updates, result } = await mutator(task);
		return { task: { ...task, ...updates }, result };
	}) as unknown as typeof data.updateTaskWith);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe("the hook offer on a held message", () => {
	it("carries a spilled body inline when the whole envelope fits the hook cap", async () => {
		const body = `MARK ${"filler ".repeat(700)}`;
		await fireScheduledMessage(project, makeTask() as never, spilledMessage(body), { late: false });
		const hook = lastHookOffer()!;
		expect(hook.text).toContain("<subject>long report</subject>");
		expect(hook.text).toContain(body);
		expect(hook.text).not.toContain("Read it in full");
		// The pane still gets the pointer: the one-read limit holds there.
		expect(vi.mocked(holdMessageForPane).mock.calls[0]![2]).toContain("Read it in full");
	});

	it("falls back to the spill pointer when the envelope is over the hook cap", async () => {
		const body = "x".repeat(AGENT_MESSAGE_HOOK_MAX_CHARS);
		await fireScheduledMessage(project, makeTask() as never, spilledMessage(body), { late: false });
		const hook = lastHookOffer()!;
		expect(hook.text).toContain("Read it in full");
		expect(hook.text).not.toContain(body);
		expect(hook.text.length).toBeLessThanOrEqual(AGENT_MESSAGE_HOOK_MAX_CHARS);
	});

	it("carries a short body as the same envelope the pane would get", async () => {
		await sendMessageImmediately(makeTask() as never, "short note", null, SOURCE, { subject: "ping" });
		const typed = vi.mocked(holdMessageForPane).mock.calls[0]![2];
		expect(lastHookOffer()!.text).toBe(typed);
	});

	it("names the sender and the subject in the notice the user sees in the pane", async () => {
		await sendMessageImmediately(makeTask() as never, "short note", null, SOURCE, { subject: "ping" });
		expect(lastHookOffer()!.notice).toBe("dev3 message from #7: ping");
	});

	it("offers nothing for an external sender's message: hook context must not lend it authority", async () => {
		await sendMessageImmediately(makeTask() as never, "hello from outside", null, null, {
			subject: "ping",
			externalSender: { id: "openclaw:home:main", label: "OpenClaw" },
		});
		expect(lastHookOffer()).toBeUndefined();
	});

	it("offers nothing for a message no agent wrote", async () => {
		await sendMessageImmediately(makeTask() as never, "from a human terminal", null, null, { subject: "ping" });
		expect(lastHookOffer()).toBeUndefined();
	});

	it("writes one receipt for the message once the hook took it, and no extra row", async () => {
		const result = await sendMessageImmediately(makeTask() as never, "short note", null, SOURCE, { subject: "ping" });
		vi.mocked(appendAgentMessageLog).mockClear();
		lastHookOffer()!.delivered();
		await vi.waitFor(() => expect(appendAgentMessageLogReceipt).toHaveBeenCalledTimes(1));
		expect(vi.mocked(appendAgentMessageLogReceipt).mock.calls[0]![1]).toEqual({
			at: expect.any(String),
			receiptFor: result.messageId,
			status: "delivered",
			deliveredVia: "hook",
		});
		expect(appendAgentMessageLog).not.toHaveBeenCalled();
	});
});
