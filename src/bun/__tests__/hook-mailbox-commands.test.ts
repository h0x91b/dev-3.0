import { afterEach, describe, expect, it, vi } from "vitest";

const move = vi.hoisted(() => vi.fn());
vi.mock("../cli-socket/task-commands", () => ({ taskHandlers: { "task.move": move } }));
vi.mock("../cli-socket/task-resolution", () => ({
	resolveTaskFromParams: vi.fn(async () => ({ project: { id: "p" }, task: { id: "task-full-id" } })),
}));
vi.mock("../cli-socket/shared", () => ({ log: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { resolveTaskFromParams } from "../cli-socket/task-resolution";
import { hookMailboxHandlers } from "../cli-socket/hook-mailbox-commands";
import { agentMessageHoldKey, holdAgentMessage, pendingAgentMessageHoldCount, resetAgentMessageHolds } from "../agent-message-hold";

const handler = hookMailboxHandlers["task.claudePostToolUse"]!;

function holdFor(taskId: string, paneId: string, text: string) {
	const delivered = vi.fn();
	holdAgentMessage(agentMessageHoldKey("tmux", taskId, paneId), {
		text,
		bytes: text.length,
		deliver: () => "landed",
		submit: () => "landed",
		hook: { text, delivered },
	}, {});
	return delivered;
}

afterEach(() => {
	resetAgentMessageHolds();
	vi.clearAllMocks();
});

describe("task.claudePostToolUse", () => {
	it("makes the same guarded status move the old hook command made", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		await handler({ taskId: "task-1", projectId: "p" });
		expect(move).toHaveBeenCalledWith({
			taskId: "task-1",
			projectId: "p",
			newStatus: "in-progress",
			ifStatusNot: "review-by-ai",
			sourceTaskId: "task-1",
		}, undefined);
	});

	it("drains the pane's held message, keyed by the task the move returned", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		const delivered = holdFor("task-full-id", "%3", "<dev3-ai-message>hi</dev3-ai-message>");
		await expect(handler({ taskId: "task-1", paneId: "%3" })).resolves.toEqual({
			context: "<dev3-ai-message>hi</dev3-ai-message>",
			messages: 1,
		});
		expect(delivered).toHaveBeenCalledTimes(1);
		expect(pendingAgentMessageHoldCount()).toBe(0);
		expect(resolveTaskFromParams).not.toHaveBeenCalled();
	});

	it("costs no task lookup when nothing is held anywhere", async () => {
		move.mockRejectedValue(new Error("offline board"));
		await expect(handler({ taskId: "task-1", paneId: "%3" })).resolves.toEqual({ moveError: "offline board" });
		expect(resolveTaskFromParams).not.toHaveBeenCalled();
	});

	it("still drains when the move failed, resolving the task itself", async () => {
		move.mockRejectedValue(new Error("status guard"));
		holdFor("task-full-id", "%3", "mail");
		await expect(handler({ taskId: "task-1", paneId: "%3" })).resolves.toEqual({ moveError: "status guard", context: "mail", messages: 1 });
	});

	it("drains nothing without a pane (a subagent's tool call) and leaves the hold to the pane", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		const delivered = holdFor("task-full-id", "%3", "mail");
		await expect(handler({ taskId: "task-1" })).resolves.toEqual({});
		expect(delivered).not.toHaveBeenCalled();
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});

	it("never drains another pane's mail", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		holdFor("task-full-id", "%4", "mail for the reviewer");
		await expect(handler({ taskId: "task-1", paneId: "%3" })).resolves.toEqual({});
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});
});
