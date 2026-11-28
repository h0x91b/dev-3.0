import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleCursorHook } from "../commands/cursor-hook";
import { cursorStatusEvent } from "../../shared/agent-hooks";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = { projectId: "project-1", taskId: "task-1", socketPath: SOCKET };

/** Shaped on the common fields Cursor's hook runner adds to every event. */
const payload = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({
	conversation_id: "conv-1",
	generation_id: "gen-1",
	hook_event_name: event,
	cursor_version: "2026.11.22",
	workspace_roots: ["/worktree"],
	...extra,
});

let stdout = "";
let stderr = "";
const env = { TMUX_PANE: process.env.TMUX_PANE, DEV3_PANE_ID: process.env.DEV3_PANE_ID };

beforeEach(() => {
	stdout = "";
	stderr = "";
	delete process.env.TMUX_PANE;
	delete process.env.DEV3_PANE_ID;
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
	mockSend.mockReset();
	mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("cursorStatusEvent", () => {
	it("maps prompt submit and tool use to working, stop to the turn end, and ignores the rest", () => {
		expect(cursorStatusEvent("beforeSubmitPrompt")).toBe("UserPromptSubmit");
		expect(cursorStatusEvent("postToolUse", { command: "bun run lint" })).toBe("PostToolUse");
		expect(cursorStatusEvent("stop")).toBe("Stop");
		for (const event of ["preToolUse", "afterAgentResponse", "sessionStart", ""]) {
			expect(cursorStatusEvent(event), event).toBeNull();
		}
	});

	it("stays silent after the agent's own status move, so a parked card is not pulled back", () => {
		for (const command of [
			"~/.dev3.0/bin/dev3 task move --status user-questions",
			"dev3 task move --status review-by-user && echo done",
			"\"C:\\Users\\A B\\.dev3.0\\bin\\dev3.exe\" task move --status user-questions",
		]) {
			expect(cursorStatusEvent("postToolUse", { command }), command).toBeNull();
		}
		expect(cursorStatusEvent("postToolUse", { command: "dev3 task show" })).toBe("PostToolUse");
		expect(cursorStatusEvent("postToolUse", { command: "mydev3 task move" })).toBe("PostToolUse");
	});
});

describe("handleCursorHook", () => {
	it("reports a submitted prompt with its generation id and the pane, as the cursor harness", async () => {
		process.env.TMUX_PANE = "%7";
		await handleCursorHook("beforeSubmitPrompt", payload("beforeSubmitPrompt", { prompt: "go on" }), SOCKET, CONTEXT);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.agentHook", {
			taskId: "task-1",
			projectId: "project-1",
			harness: "cursor",
			event: "UserPromptSubmit",
			paneId: "%7",
			prompt: "go on",
			turnId: "gen-1",
		}, expect.any(Object));
		expect(stdout).toBe("{}");
	});

	it("reports tool use and a completed or aborted turn as status events", async () => {
		await handleCursorHook("postToolUse", payload("postToolUse", { tool_name: "Shell", tool_input: { command: "ls" } }), SOCKET, CONTEXT);
		await handleCursorHook("stop", payload("stop", { status: "completed", loop_count: 0 }), SOCKET, CONTEXT);
		await handleCursorHook("stop", payload("stop", { status: "aborted", loop_count: 0 }), SOCKET, CONTEXT);
		expect(mockSend.mock.calls.map(([, method, params]) => [method, (params as { event: string }).event])).toEqual([
			["task.agentHook", "PostToolUse"],
			["task.agentHook", "Stop"],
			["task.agentHook", "Stop"],
		]);
		expect(stdout).toBe("{}{}{}");
	});

	it("parks a turn that ended on an error in front of the user", async () => {
		await handleCursorHook("stop", payload("stop", { status: "error" }), SOCKET, CONTEXT);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.claudeStopFailure", {
			taskId: "task-1", projectId: "project-1", error: "unknown",
		}, expect.any(Object));
	});

	it("does nothing outside a dev3 task, after its own status move, or for an unknown event — and still answers {}", async () => {
		await handleCursorHook("beforeSubmitPrompt", payload("beforeSubmitPrompt", { prompt: "hi" }), SOCKET, null);
		await handleCursorHook("beforeSubmitPrompt", payload("beforeSubmitPrompt", { prompt: "hi" }), null, CONTEXT);
		await handleCursorHook("postToolUse", payload("postToolUse", { tool_input: { command: "dev3 task move --status user-questions" } }), SOCKET, CONTEXT);
		await handleCursorHook("preToolUse", payload("preToolUse"), SOCKET, CONTEXT);
		expect(mockSend).not.toHaveBeenCalled();
		expect(stdout).toBe("{}{}{}{}");
	});

	it("never fails Cursor when the app is unreachable or the payload is garbage", async () => {
		mockSend.mockRejectedValue(new Error("connect ENOENT"));
		await handleCursorHook("stop", "not json", SOCKET, CONTEXT);
		expect(stdout).toBe("{}");
		expect(stderr).toContain("connect ENOENT");
	});
});
