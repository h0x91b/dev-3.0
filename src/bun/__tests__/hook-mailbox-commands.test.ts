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
		const out = (await handler({ taskId: "task-1", paneId: "%3" })) as { claimId?: string };
		expect(out).toEqual({
			context: "<dev3-ai-message>hi</dev3-ai-message>",
			messages: 1,
			claimId: expect.any(String),
		});
		expect(delivered).not.toHaveBeenCalled();
		await expect(hookMailboxHandlers["task.claudePostToolUseAck"]!({ claimId: out.claimId })).resolves.toEqual({ acknowledged: true });
		expect(delivered).toHaveBeenCalledTimes(1);
		await expect(hookMailboxHandlers["task.claudePostToolUseAck"]!({ claimId: out.claimId })).resolves.toEqual({ acknowledged: false });
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
		await expect(handler({ taskId: "task-1", paneId: "%3" })).resolves.toEqual({ moveError: "status guard", context: "mail", messages: 1, claimId: expect.any(String) });
	});

	it("drains nothing without a pane (a subagent's tool call) and leaves the hold to the pane", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		const delivered = holdFor("task-full-id", "%3", "mail");
		await expect(handler({ taskId: "task-1" })).resolves.toEqual({});
		expect(delivered).not.toHaveBeenCalled();
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});

	it("hands back the notice lines for the user next to the context", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		for (const [text, notice] of [["a", "dev3 message from #2: first"], ["b", "dev3 message from #2: second"]]) {
			holdAgentMessage(agentMessageHoldKey("tmux", "task-full-id", "%3"), {
				text: text!, bytes: 1, deliver: () => "landed", submit: () => "landed", hook: { text: text!, delivered: vi.fn(), notice },
			}, {});
		}
		const result = await handler({ taskId: "task-1", paneId: "%3" });
		expect(result).toMatchObject({ messages: 2, notice: "dev3 message from #2: first\ndev3 message from #2: second" });
	});

	it("never drains another pane's mail", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		holdFor("task-full-id", "%4", "mail for the reviewer");
		await expect(handler({ taskId: "task-1", paneId: "%3" })).resolves.toEqual({});
		expect(pendingAgentMessageHoldCount()).toBe(1);
	});
});
