import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
import { sendRequest } from "../socket-client";
import { handleClaudePreTool } from "../commands/claude-pre-tool";

const send = vi.mocked(sendRequest);
const socket = "/tmp/test.sock";
const context: CliContext = { taskId: "task-1", projectId: "project-1", socketPath: socket };
const payload = { hook_event_name: "PreToolUse", tool_name: "Bash" };

beforeEach(() => {
	send.mockReset();
	send.mockResolvedValue({ id: "1", ok: true, data: {} });
});

describe("handleClaudePreTool", () => {
	it("reports the background owner so only its own approval can resume", async () => {
		await handleClaudePreTool(JSON.stringify({ ...payload, agent_id: "agent-7" }), socket, context);
		expect(send).toHaveBeenCalledWith(socket, "task.claudeToolStatus", {
			taskId: "task-1", projectId: "project-1", event: "PreToolUse", agentId: "agent-7",
		});
	});

	it("resumes the main conversation while preserving AI review", async () => {
		await handleClaudePreTool(JSON.stringify(payload), socket, context);
		expect(send).toHaveBeenCalledWith(socket, "task.claudeToolStatus", {
			taskId: "task-1", projectId: "project-1", event: "PreToolUse",
		});
	});

	it("does not mistake a primary --agent selection for a subagent", async () => {
		await handleClaudePreTool(JSON.stringify({ ...payload, agent_type: "reviewer", agent_id: "" }), socket, context);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it.each(["null", "[]", "{}", '{"hook_event_name":"Stop"}'])("ignores unrelated input %s", async raw => {
		await handleClaudePreTool(raw, socket, context);
		expect(send).not.toHaveBeenCalled();
	});

	it("never blocks tool execution when dev3 is offline", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			send.mockRejectedValue(new Error("connect ENOENT"));
			await expect(handleClaudePreTool(JSON.stringify(payload), socket, context)).resolves.toBeUndefined();
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("connect ENOENT"));
		} finally { stderr.mockRestore(); }
	});

	it.each(["not json", "42", "true"])("never blocks on malformed input %s", async raw => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await expect(handleClaudePreTool(raw, socket, context)).resolves.toBeUndefined();
			expect(send).not.toHaveBeenCalled();
		} finally { stderr.mockRestore(); }
	});

	it.each(["PermissionRequest", "Notification"])("reports %s with the waiting owner's identity", async event => {
		await handleClaudePreTool(JSON.stringify({ hook_event_name: event, session_id: "s", agent_id: "reader", notification_type: "permission_prompt" }), socket, context);
		expect(send).toHaveBeenCalledWith(socket, "task.claudeToolStatus", {
			taskId: "task-1", projectId: "project-1", event, sessionId: "s", agentId: "reader",
		});
	});

	it("ignores idle notifications", async () => {
		await handleClaudePreTool('{"hook_event_name":"Notification","notification_type":"idle_prompt"}', socket, context);
		expect(send).not.toHaveBeenCalled();
	});

	it("does nothing without a task or socket", async () => {
		await handleClaudePreTool(JSON.stringify(payload), null, context);
		await handleClaudePreTool(JSON.stringify(payload), socket, null);
		expect(send).not.toHaveBeenCalled();
	});
});
