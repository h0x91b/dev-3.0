/**
 * Claude Code's `PostToolUse` adapter: one request moves the status and drains
 * the pane's held messages. A subagent's tool call (payload carries `agent_id`)
 * must only clear approval waits that it owns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleClaudePostTool } from "../commands/claude-post-tool";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = { projectId: "project-1", taskId: "task-1", socketPath: SOCKET };
const PANE_ENV = { TMUX_PANE: "%3" };

const PAYLOAD = {
	session_id: "session-1",
	hook_event_name: "PostToolUse",
	tool_name: "Bash",
	tool_input: { command: "sleep 20" },
	tool_response: {},
};

let stdout = "";
let stderr = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stdout = "";
	stderr = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, cb?: unknown) => {
		stdout += String(chunk);
		if (typeof cb === "function") cb();
		return true;
	}) as typeof process.stdout.write);
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
});

describe("handleClaudePostTool", () => {
	it("sends one request with the pane, and prints the drained messages as PostToolUse context", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: { context: "<dev3-ai-message>hi</dev3-ai-message>", messages: 1 } });

		await handleClaudePostTool(JSON.stringify(PAYLOAD), SOCKET, CONTEXT, PANE_ENV);

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.claudePostToolUse", {
			taskId: "task-1",
			projectId: "project-1",
			event: "PostToolUse", sessionId: "session-1",
			paneId: "%3",
			toolName: "Bash",
		});
		// No custom timeout: the default the plain `task move` hook waited on.
		expect(mockSend.mock.calls[0]).toHaveLength(3);
		expect(JSON.parse(stdout)).toEqual({
			hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "<dev3-ai-message>hi</dev3-ai-message>" },
		});
	});

	it("acknowledges the claim only after printing it, so the app stops holding it", async () => {
		mockSend
			.mockResolvedValueOnce({ id: "1", ok: true, data: { context: "mail", messages: 1, claimId: "claim-1" } })
			.mockResolvedValueOnce({ id: "2", ok: true, data: { acknowledged: true } });
		await handleClaudePostTool(JSON.stringify(PAYLOAD), SOCKET, CONTEXT, PANE_ENV);
		expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toBe("mail");
		expect(mockSend).toHaveBeenNthCalledWith(2, SOCKET, "task.claudePostToolUseAck", { claimId: "claim-1" });
	});

	it("prints nothing when nothing was held", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
		await handleClaudePostTool(JSON.stringify(PAYLOAD), SOCKET, CONTEXT, PANE_ENV);
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	it("reports background completion without claiming the parent mailbox", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
		await handleClaudePostTool(JSON.stringify({ ...PAYLOAD, agent_id: "agent-7", agent_type: "Explore" }), SOCKET, CONTEXT, PANE_ENV);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.claudePostToolUse", {
			taskId: "task-1", projectId: "project-1", event: "PostToolUse", sessionId: "session-1", agentId: "agent-7", toolName: "Bash",
		});

		// It names the call it reports on, a subagent's too, so dev3 can close its prompt.
		await handleClaudePostTool(JSON.stringify({ ...PAYLOAD, tool_use_id: "toolu_9", agent_id: "agent-a" }), SOCKET, CONTEXT, PANE_ENV);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "task.claudePostToolUse", {
			taskId: "task-1", projectId: "project-1", event: "PostToolUse", sessionId: "session-1",
			toolName: "Bash", toolUseId: "toolu_9", agentId: "agent-a",
		});
	});

	it("never asks for mail from a `claude -p` run inside the pane: it is not the pane's conversation", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
		await handleClaudePostTool(JSON.stringify(PAYLOAD), SOCKET, CONTEXT, { ...PANE_ENV, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
		const [, , params] = mockSend.mock.calls[0]!;
		expect(params).not.toHaveProperty("paneId");
	});

	it("does not move status or drain mail for malformed or unrelated payloads", async () => {
		for (const raw of [' {"hook_event_name":"PostToolUse","agent_id":42}', "not json", "null", "[]", "{}", '{"hook_event_name":"PreToolUse"}']) {
			await handleClaudePostTool(raw, SOCKET, CONTEXT, PANE_ENV);
			expect(mockSend, raw).not.toHaveBeenCalled();
		}
	});

	it("shows the user a notice line, since hook context never appears in the pane", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: { context: "mail", notice: "dev3 message from #2: ping", messages: 1 } });
		await handleClaudePostTool(JSON.stringify(PAYLOAD), SOCKET, CONTEXT, PANE_ENV);
		expect(JSON.parse(stdout)).toEqual({
			systemMessage: "dev3 message from #2: ping",
			hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "mail" },
		});
	});

	it("says why the move failed on stderr, and still hands over the mail", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: { moveError: "task not found", context: "mail" } });
		await handleClaudePostTool(JSON.stringify(PAYLOAD), SOCKET, CONTEXT, PANE_ENV);
		expect(stderr).toContain("task not found");
		expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toBe("mail");
	});

	it("does nothing outside a task or with the app closed, and never throws", async () => {
		await handleClaudePostTool(JSON.stringify(PAYLOAD), null, CONTEXT, PANE_ENV);
		await handleClaudePostTool(JSON.stringify(PAYLOAD), SOCKET, null, PANE_ENV);
		expect(mockSend).not.toHaveBeenCalled();

		mockSend.mockRejectedValue(new Error("connect ENOENT"));
		await expect(handleClaudePostTool(JSON.stringify(PAYLOAD), SOCKET, CONTEXT, PANE_ENV)).resolves.toBeUndefined();
		expect(stdout).toBe("");
		expect(stderr).toContain("connect ENOENT");
	});
});
