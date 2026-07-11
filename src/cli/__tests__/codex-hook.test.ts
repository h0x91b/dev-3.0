import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleCodexHook } from "../commands/codex-hook";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = {
	projectId: "project-1",
	taskId: "task-1",
	socketPath: SOCKET,
};

let stdout = "";
let stderr = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let originalTmuxPane: string | undefined;

beforeEach(() => {
	stdout = "";
	stderr = "";
	// Tests may run inside tmux (TMUX_PANE set); clear it so cases control it explicitly.
	originalTmuxPane = process.env.TMUX_PANE;
	delete process.env.TMUX_PANE;
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalTmuxPane;
});

describe("handleCodexHook", () => {
	it("forwards a supported lifecycle event to one atomic socket handler", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });

		await handleCodexHook(
			JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "session-1" }),
			SOCKET,
			CONTEXT,
		);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.agentHook", {
			taskId: "task-1",
			projectId: "project-1",
			event: "PermissionRequest",
			sessionId: "session-1",
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		expect(stdout).toBe("{}");
		expect(stderr).toBe("");
	});

	it("forwards the pane id from $TMUX_PANE for per-pane Codex session capture", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
		process.env.TMUX_PANE = "%42";

		await handleCodexHook(
			JSON.stringify({ hook_event_name: "SessionStart", session_id: "session-9" }),
			SOCKET,
			CONTEXT,
		);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.agentHook", {
			taskId: "task-1",
			projectId: "project-1",
			event: "SessionStart",
			sessionId: "session-9",
			paneId: "%42",
		}, { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 });
		expect(stdout).toBe("{}");
	});

	it("is a successful no-op outside a dev3 task", async () => {
		await handleCodexHook(
			JSON.stringify({ hook_event_name: "Stop" }),
			SOCKET,
			null,
		);

		expect(mockSend).not.toHaveBeenCalled();
		expect(stdout).toBe("{}");
	});

	it("never blocks Codex when the app is offline", async () => {
		await handleCodexHook(
			JSON.stringify({ hook_event_name: "Stop" }),
			null,
			CONTEXT,
		);

		expect(mockSend).not.toHaveBeenCalled();
		expect(stdout).toBe("{}");
	});

	it("reports a socket error without failing the hook", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: false, error: "status update failed" });

		await handleCodexHook(
			JSON.stringify({ hook_event_name: "Stop" }),
			SOCKET,
			CONTEXT,
		);

		expect(stdout).toBe("{}");
		expect(stderr).toContain("status update failed");
	});

	it("ignores malformed and unknown hook payloads", async () => {
		await handleCodexHook("not-json", SOCKET, CONTEXT);
		await handleCodexHook(JSON.stringify({ hook_event_name: "FutureEvent" }), SOCKET, CONTEXT);

		expect(mockSend).not.toHaveBeenCalled();
		expect(stdout).toBe("{}{}");
	});
});
