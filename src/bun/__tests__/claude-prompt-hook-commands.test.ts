import { afterEach, describe, expect, it, vi } from "vitest";

const move = vi.hoisted(() => vi.fn());
vi.mock("../rpc-handlers", () => ({ moveTask: move }));
vi.mock("../cli-socket/task-resolution", () => ({
	resolveTaskFromParams: vi.fn(async () => ({ project: { id: "p" }, task: { id: "task-full-id", projectId: "p", status: "in-progress" } })),
}));
vi.mock("../cli-socket/shared", () => ({ log: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { claudePromptHookHandlers } from "../cli-socket/claude-prompt-hook-commands";
import { hookMailboxHandlers } from "../cli-socket/hook-mailbox-commands";
import { agentPromptLedger } from "../agent-prompt-ledger";
import { claudeApprovals } from "../claude-approval-state";
import { agentMessageHoldKey, agentMessageHeldBehindPrompt, holdAgentMessage, resetAgentMessageHolds } from "../agent-message-hold";

const preTool = claudePromptHookHandlers["task.claudePreToolUse"]!;
const permission = claudePromptHookHandlers["task.claudePermissionRequest"]!;
const postTool = hookMailboxHandlers["task.claudePostToolUse"]!;
const KEY = agentMessageHoldKey("tmux", "task-full-id", "%3");

function holdOne() {
	holdAgentMessage(KEY, { text: "hi", bytes: 2, deliver: () => "landed", submit: () => "landed" }, {});
}

afterEach(() => {
	resetAgentMessageHolds();
	agentPromptLedger.reset();
	claudeApprovals.endSession("task-full-id", "s1");
	vi.clearAllMocks();
});

describe("Claude prompt hooks → what the message hold does", () => {
	it("a PermissionRequest after its PreToolUse holds new messages for that pane, and moves the card to Has Questions", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		await preTool({ taskId: "task-1", projectId: "p", sessionId: "s1", toolName: "Bash", toolUseId: "toolu_1", paneId: "%3" });
		await permission({ taskId: "task-1", projectId: "p", sessionId: "s1", toolName: "Bash", paneId: "%3" });
		expect(move).toHaveBeenLastCalledWith(expect.objectContaining({ newStatus: "user-questions", taskId: "task-full-id" }));
		holdOne();
		expect(agentMessageHeldBehindPrompt(KEY)).toBe(true);
	});

	it("the PostToolUse of the answered call lets messages through again", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		await preTool({ taskId: "task-1", sessionId: "s1", toolName: "Bash", toolUseId: "toolu_1", paneId: "%3" });
		await permission({ taskId: "task-1", sessionId: "s1", toolName: "Bash", paneId: "%3" });
		await postTool({ taskId: "task-1", sessionId: "s1", toolName: "Bash", toolUseId: "toolu_1" });
		holdOne();
		expect(agentMessageHeldBehindPrompt(KEY)).toBe(false);
	});

	it("a failed call stops a later menu of its tool from waiting on it, and moves nothing", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		const failure = claudePromptHookHandlers["task.claudePostToolUseFailure"]!;
		await preTool({ taskId: "task-1", sessionId: "s1", toolName: "Bash", toolUseId: "toolu_failed", paneId: "%3" });
		await preTool({ taskId: "task-1", sessionId: "s1", toolName: "Bash", toolUseId: "toolu_ok", paneId: "%3" });
		await permission({ taskId: "task-1", sessionId: "s1", toolName: "Bash", paneId: "%3" });
		await postTool({ taskId: "task-1", sessionId: "s1", toolName: "Bash", toolUseId: "toolu_ok" });
		move.mockClear();
		await expect(failure({ taskId: "task-1", sessionId: "s1", toolName: "Bash", toolUseId: "toolu_failed" })).resolves.toEqual({});
		expect(move).not.toHaveBeenCalled();
		holdOne();
		expect(agentMessageHeldBehindPrompt(KEY)).toBe(false);
	});

	it("an AskUserQuestion PreToolUse alone holds messages", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		await preTool({ taskId: "task-1", sessionId: "s1", toolName: "AskUserQuestion", toolUseId: "toolu_q", paneId: "%3" });
		holdOne();
		expect(agentMessageHeldBehindPrompt(KEY)).toBe(true);
	});

	it("still records the prompt when the status move fails, and reports the failure", async () => {
		move.mockRejectedValue(new Error("offline board"));
		const result = await permission({ taskId: "task-1", sessionId: "s1", toolName: "ExitPlanMode", paneId: "%3" });
		expect(result).toEqual({ moveError: "offline board" });
		holdOne();
		expect(agentMessageHeldBehindPrompt(KEY)).toBe(true);
	});

	it("a hook that names no session or tool gates nothing", async () => {
		move.mockResolvedValue({ id: "task-full-id", status: "in-progress" });
		await permission({ taskId: "task-1", paneId: "%3" });
		holdOne();
		expect(agentMessageHeldBehindPrompt(KEY)).toBe(false);
	});
});
