import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
import { sendRequest } from "../socket-client";
import { handleClaudePreTool } from "../commands/claude-pre-tool";

const send = vi.mocked(sendRequest);
const socket = "/tmp/test.sock";
const context: CliContext = { taskId: "task-1", projectId: "project-1", socketPath: socket };
const payload = { hook_event_name: "PreToolUse", tool_name: "Bash" };
const noPane: NodeJS.ProcessEnv = {};
let stdout: string;
let stderr: string;

beforeEach(() => {
	stdout = "";
	stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
	send.mockReset().mockResolvedValue({ id: "1", ok: true, data: {} });
});
afterEach(() => vi.restoreAllMocks());

describe("handleClaudePreTool", () => {
	it("reports the background owner so only its own approval can resume", async () => {
		await handleClaudePreTool(JSON.stringify({ ...payload, agent_id: "agent-7" }), socket, context, noPane);
		expect(send).toHaveBeenCalledWith(socket, "task.claudePreToolUse", {
			taskId: "task-1", projectId: "project-1", toolName: "Bash", agentId: "agent-7", event: "PreToolUse",
		}, expect.objectContaining({ timeoutMs: 3_000 }));
	});

	it("reports the call to the prompt ledger with its session, tool and pane", async () => {
		const call = { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "AskUserQuestion", tool_use_id: "toolu_1", tool_input: {} };
		await handleClaudePreTool(JSON.stringify(call), socket, context, { TMUX_PANE: "%4" });
		expect(send).toHaveBeenCalledWith(socket, "task.claudePreToolUse", {
			taskId: "task-1", projectId: "project-1", event: "PreToolUse",
			sessionId: "s1", toolName: "AskUserQuestion", toolUseId: "toolu_1", paneId: "%4",
		}, expect.objectContaining({ timeoutMs: 3_000 }));
	});

	it("does not mistake a primary --agent selection for a subagent", async () => {
		await handleClaudePreTool(JSON.stringify({ ...payload, agent_type: "reviewer", agent_id: "" }), socket, context, noPane);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]![2]).not.toHaveProperty("agentId");
	});

	it("reports permission, notification, subagent and teammate events with their owner's identity", async () => {
		for (const event of ["PermissionRequest", "Notification", "SubagentStop", "TeammateIdle"]) {
			await handleClaudePreTool(JSON.stringify({ hook_event_name: event, session_id: "s", agent_id: "reader", notification_type: "permission_prompt" }), socket, context, noPane);
			expect(send, event).toHaveBeenLastCalledWith(socket, "task.claudeToolStatus", {
				taskId: "task-1", projectId: "project-1", event, sessionId: "s", agentId: "reader",
			}, expect.objectContaining({ timeoutMs: 3_000 }));
		}
	});

	it("moves nothing on idle notifications or unrelated/malformed input, and still answers Claude neutrally", async () => {
		const inputs = ['{"hook_event_name":"Notification","notification_type":"idle_prompt"}',
			"null", "[]", "{}", '{"hook_event_name":"Stop"}', '{"hook_event_name":"PostToolUse"}', "not json", "42", "true"];
		for (const raw of inputs) {
			stdout = "";
			await expect(handleClaudePreTool(raw, socket, context, noPane), raw).resolves.toBeUndefined();
			expect(JSON.parse(stdout), raw).toEqual({});
		}
		expect(send).not.toHaveBeenCalled();
	});

	it("never blocks tool execution when dev3 is offline", async () => {
		send.mockRejectedValue(new Error("connect ENOENT"));
		await expect(handleClaudePreTool(JSON.stringify(payload), socket, context, noPane)).resolves.toBeUndefined();
		expect(stderr).toContain("connect ENOENT");
		expect(JSON.parse(stdout)).toEqual({});
	});

	it("does nothing without a task or socket", async () => {
		await handleClaudePreTool(JSON.stringify(payload), null, context, noPane);
		await handleClaudePreTool(JSON.stringify(payload), socket, null, noPane);
		expect(send).not.toHaveBeenCalled();
	});
});

describe("Claude pre-tool hook imported by Cursor", () => {
	it("returns Cursor JSON instead of the human-readable task move output", async () => {
		await handleClaudePreTool('{"hook_event_name":"preToolUse","cursor_version":"1.7.2"}', socket, context, noPane);
		expect(JSON.parse(stdout)).toEqual({ permission: "allow" });
	});

	it("does not override Claude permission decisions", async () => {
		await handleClaudePreTool('{"hook_event_name":"PreToolUse"}', socket, context, noPane);
		expect(JSON.parse(stdout)).toEqual({});
	});

	it("keeps Cursor on the plain move: it reports no prompts or owners dev3 could track", async () => {
		await handleClaudePreTool('{"cursor_version":"1.7.2","session_id":"s1","tool_name":"Shell"}', socket, context, { TMUX_PANE: "%4" });
		expect(send).toHaveBeenCalledWith(socket, "task.move", {
			taskId: "task-1", projectId: "project-1", sourceTaskId: "task-1",
			newStatus: "in-progress", ifStatusNot: "review-by-ai",
		}, expect.objectContaining({ timeoutMs: 3_000 }));
	});

	it("still returns valid Cursor JSON when offline, rejected or without a task", async () => {
		for (const failure of ["offline", "rejected", "no-task"]) {
			stdout = "";
			if (failure === "offline") send.mockRejectedValue(new Error("offline"));
			if (failure === "rejected") send.mockResolvedValue({ id: "1", ok: false, error: "rejected" });
			await handleClaudePreTool('{"cursor_version":"1.7.2"}', socket, failure === "no-task" ? null : context, noPane);
			expect(JSON.parse(stdout), failure).toEqual({ permission: "allow" });
		}
	});
});
