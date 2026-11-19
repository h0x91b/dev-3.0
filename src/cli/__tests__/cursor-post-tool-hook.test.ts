/**
 * Cursor's `postToolUse` adapter: drains the pane's held messages and prints them as
 * `additional_context`, which the Cursor CLI injects into the running turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleCursorPostTool } from "../commands/cursor-post-tool";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = { projectId: "project-1", taskId: "task-1", socketPath: SOCKET };
const PANE_ENV = { TMUX_PANE: "%7" };
const PAYLOAD = JSON.stringify({ hook_event_name: "postToolUse", conversation_id: "conv-1", tool_name: "Shell" });

let stdout = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	stdout = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, cb?: unknown) => {
		stdout += String(chunk);
		if (typeof cb === "function") cb();
		return true;
	}) as typeof process.stdout.write);
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
});

describe("handleCursorPostTool", () => {
	it("prints the drained messages as additional_context, then acknowledges the claim", async () => {
		mockSend.mockResolvedValueOnce({ id: "1", ok: true, data: { context: "<dev3-ai-message>hi</dev3-ai-message>", claimId: "c1" } });
		mockSend.mockResolvedValueOnce({ id: "2", ok: true, data: { acknowledged: true } });

		await handleCursorPostTool(PAYLOAD, SOCKET, CONTEXT, PANE_ENV);

		expect(mockSend).toHaveBeenNthCalledWith(1, SOCKET, "task.cursorPostToolUse", { taskId: "task-1", projectId: "project-1", paneId: "%7", conversationId: "conv-1" });
		expect(JSON.parse(stdout)).toEqual({ additional_context: "<dev3-ai-message>hi</dev3-ai-message>" });
		expect(mockSend).toHaveBeenNthCalledWith(2, SOCKET, "task.claudePostToolUseAck", { claimId: "c1" });
	});

	it("prints nothing when no mail is held", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
		await handleCursorPostTool(PAYLOAD, SOCKET, CONTEXT, PANE_ENV);
		expect([stdout, mockSend.mock.calls.length]).toEqual(["", 1]);
	});

	it("asks nothing outside a task pane or without a conversation id", async () => {
		await handleCursorPostTool(PAYLOAD, SOCKET, CONTEXT, {});
		await handleCursorPostTool(PAYLOAD, SOCKET, null, PANE_ENV);
		await handleCursorPostTool("{}", SOCKET, CONTEXT, PANE_ENV);
		expect([stdout, mockSend.mock.calls.length]).toEqual(["", 0]);
	});

	it("stays silent and exits normally when the app is unreachable", async () => {
		mockSend.mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(handleCursorPostTool(PAYLOAD, SOCKET, CONTEXT, PANE_ENV)).resolves.toBeUndefined();
		expect(stdout).toBe("");
	});
});
