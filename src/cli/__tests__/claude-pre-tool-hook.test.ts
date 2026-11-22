import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
import { sendRequest } from "../socket-client";
import { handleClaudePreTool } from "../commands/claude-pre-tool";

const context: CliContext = { projectId: "project-1", taskId: "task-1", socketPath: "/tmp/test.sock" };
let stdout: string;

beforeEach(() => {
	stdout = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	vi.mocked(sendRequest).mockReset().mockResolvedValue({ id: "1", ok: true, data: {} });
});
afterEach(() => vi.restoreAllMocks());

describe("Claude pre-tool hook imported by Cursor", () => {
	it("returns Cursor JSON instead of the human-readable task move output", async () => {
		await handleClaudePreTool('{"hook_event_name":"preToolUse","cursor_version":"1.7.2"}', context.socketPath, context);
		expect(JSON.parse(stdout)).toEqual({ permission: "allow" });
	});

	it("does not override Claude permission decisions", async () => {
		await handleClaudePreTool('{"hook_event_name":"PreToolUse"}', context.socketPath, context);
		expect(JSON.parse(stdout)).toEqual({});
	});

	it("preserves the review guard when moving its own task, and reports the call to the prompt ledger", async () => {
		const payload = { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "AskUserQuestion", tool_use_id: "toolu_1", tool_input: {} };
		await handleClaudePreTool(JSON.stringify(payload), context.socketPath, context, { TMUX_PANE: "%4" });
		expect(sendRequest).toHaveBeenCalledWith(context.socketPath, "task.claudePreToolUse", {
			taskId: context.taskId, projectId: context.projectId, sourceTaskId: context.taskId,
			newStatus: "in-progress", ifStatusNot: "review-by-ai",
			sessionId: "s1", toolName: "AskUserQuestion", toolUseId: "toolu_1", paneId: "%4",
		}, expect.objectContaining({ timeoutMs: 3_000 }));
	});

	it("keeps Cursor on the plain move: it reports no prompts dev3 could track", async () => {
		await handleClaudePreTool('{"cursor_version":"1.7.2","session_id":"s1","tool_name":"Shell"}', context.socketPath, context, { TMUX_PANE: "%4" });
		expect(sendRequest).toHaveBeenCalledWith(context.socketPath, "task.move", {
			taskId: context.taskId, projectId: context.projectId, sourceTaskId: context.taskId,
			newStatus: "in-progress", ifStatusNot: "review-by-ai",
		}, expect.objectContaining({ timeoutMs: 3_000 }));
	});

	it.each(["offline", "rejected", "no-task"])("still returns valid Cursor JSON when %s", async (failure) => {
		if (failure === "offline") vi.mocked(sendRequest).mockRejectedValue(new Error("offline"));
		if (failure === "rejected") vi.mocked(sendRequest).mockResolvedValue({ id: "1", ok: false, error: "rejected" });
		await handleClaudePreTool('{"cursor_version":"1.7.2"}', context.socketPath, failure === "no-task" ? null : context);
		expect(JSON.parse(stdout)).toEqual({ permission: "allow" });
	});

	it("handles malformed input without blocking Claude", async () => {
		await handleClaudePreTool("{broken", null, null);
		expect(JSON.parse(stdout)).toEqual({});
		expect(sendRequest).not.toHaveBeenCalled();
	});
});
