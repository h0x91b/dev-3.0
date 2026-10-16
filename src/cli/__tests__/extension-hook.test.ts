import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
import { handleExtensionHook } from "../commands/extension-hook";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = {
	projectId: "project-1",
	taskId: "task-1",
	socketPath: SOCKET,
};
const SEND_OPTIONS = { timeoutMs: 3_000, connectAttempts: 2, retryDelayMs: 50 };

let stdout = "";
let stderr = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let originalTmuxPane: string | undefined;

beforeEach(() => {
	stdout = "";
	stderr = "";
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

describe("handleExtensionHook (omp)", () => {
	it("forwards a report from the status extension to the atomic socket handler, named as omp", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });

		await handleExtensionHook("omp", JSON.stringify({ event: "PermissionRequest", sessionId: "sess-1" }), SOCKET, CONTEXT);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.agentHook", {
			taskId: "task-1",
			projectId: "project-1",
			harness: "omp",
			event: "PermissionRequest",
			sessionId: "sess-1",
		}, SEND_OPTIONS);
		// omp reads no reply, so nothing is printed.
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	it("forwards the pane id from $TMUX_PANE for per-pane session capture", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
		process.env.TMUX_PANE = "%42";

		await handleExtensionHook("omp", JSON.stringify({ event: "SessionStart", sessionId: "sess-9" }), SOCKET, CONTEXT);

		expect(mockSend.mock.calls[0]![2]).toMatchObject({ event: "SessionStart", sessionId: "sess-9", paneId: "%42" });
	});

	it("carries the prompt and the extension's submission id on UserPromptSubmit only", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });

		await handleExtensionHook(
			"omp",
			JSON.stringify({ event: "UserPromptSubmit", sessionId: "s", prompt: "rebase and push", submissionId: "sub-1" }),
			SOCKET,
			CONTEXT,
		);
		await handleExtensionHook("omp", JSON.stringify({ event: "Stop", sessionId: "s", prompt: "leftover" }), SOCKET, CONTEXT);

		expect(mockSend.mock.calls[0]![2]).toMatchObject({ prompt: "rebase and push", turnId: "sub-1" });
		expect(mockSend.mock.calls[1]![2]).not.toHaveProperty("prompt");
	});

	it("is a successful no-op outside a dev3 task and when the app is offline", async () => {
		await handleExtensionHook("omp", JSON.stringify({ event: "Stop" }), SOCKET, null);
		await handleExtensionHook("omp", JSON.stringify({ event: "Stop" }), null, CONTEXT);

		expect(mockSend).not.toHaveBeenCalled();
		expect(stdout).toBe("");
	});

	it("reports a socket error on stderr without failing", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: false, error: "status update failed" });

		await handleExtensionHook("omp", JSON.stringify({ event: "Stop" }), SOCKET, CONTEXT);

		expect(stderr).toContain("dev3 omp hook: status update failed");
	});

	it("ignores malformed and unknown payloads", async () => {
		await handleExtensionHook("omp", "not-json", SOCKET, CONTEXT);
		await handleExtensionHook("omp", JSON.stringify({ event: "turn_start" }), SOCKET, CONTEXT);
		await handleExtensionHook("omp", JSON.stringify({ hook_event_name: "Stop" }), SOCKET, CONTEXT);

		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("handleExtensionHook (pi)", () => {
	it("names the report as pi, so the app matches it against the pi pane", async () => {
		mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });

		await handleExtensionHook("pi", JSON.stringify({ event: "Stop", sessionId: "0199aaaa" }), SOCKET, CONTEXT);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.agentHook", {
			taskId: "task-1",
			projectId: "project-1",
			harness: "pi",
			event: "Stop",
			sessionId: "0199aaaa",
		}, SEND_OPTIONS);
		expect(stdout).toBe("");
	});
});
