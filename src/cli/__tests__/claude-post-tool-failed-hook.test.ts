/** Claude Code's `PostToolUseFailure` adapter: the failed call leaves the prompt ledger, nothing else. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../socket-client";
import { handleClaudePostToolFailed } from "../commands/claude-post-tool-failed";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = { projectId: "project-1", taskId: "task-1", socketPath: SOCKET };
const PAYLOAD = {
	session_id: "session-1",
	hook_event_name: "PostToolUseFailure",
	tool_name: "Bash",
	tool_use_id: "toolu_9",
	error: "exit 1",
	is_interrupt: true,
};

let stdout = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stdout = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write);
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
});

describe("handleClaudePostToolFailed", () => {
	it("names the failed call and nothing else: no pane, so no mail, and prints nothing", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
		await handleClaudePostToolFailed(JSON.stringify({ ...PAYLOAD, agent_id: "agent-a" }), SOCKET, CONTEXT, { TMUX_PANE: "%3" });
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.claudePostToolUseFailure", {
			taskId: "task-1",
			projectId: "project-1",
			sessionId: "session-1",
			toolName: "Bash",
			toolUseId: "toolu_9",
			agentId: "agent-a",
		}, expect.anything());
		expect(stdout).toBe("");
	});

	it("sends nothing for a payload without its call id, outside a task, or unreadable", async () => {
		await handleClaudePostToolFailed(JSON.stringify({ ...PAYLOAD, tool_use_id: undefined }), SOCKET, CONTEXT, {});
		await handleClaudePostToolFailed(JSON.stringify(PAYLOAD), SOCKET, null, {});
		await handleClaudePostToolFailed("not json", SOCKET, CONTEXT, {});
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("never throws when the app is unreachable", async () => {
		mockSend.mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(handleClaudePostToolFailed(JSON.stringify(PAYLOAD), SOCKET, CONTEXT, {})).resolves.toBeUndefined();
	});
});
