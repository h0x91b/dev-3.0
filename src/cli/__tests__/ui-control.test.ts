import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleNotify, handleAttention, handleUi } from "../commands/ui-control";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const SOCKET = "/tmp/test.sock";

const CTX: CliContext = {
	projectId: "proj-001",
	taskId: "aaaaaaaa-1111-2222-3333-444444444444",
	socketPath: SOCKET,
};

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function errResp(error: string): CliResponse {
	return { id: "test-id", ok: false, error };
}

function args(positional: string[] = [], flags: Record<string, string> = {}): ParsedArgs {
	return { positional, flags };
}

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutOutput += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrOutput += String(chunk);
		return true;
	});
	exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => {
		throw new Error(`EXIT_${_code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

// ─── notify ──────────────────────────────────────────────────────────────────

describe("notify", () => {
	it("sends a toast with the in-context task attached", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "toast", taskId: CTX.taskId }));

		await handleNotify(args(["build is green"]), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.notify", {
			message: "build is green",
			level: "info",
			taskId: CTX.taskId,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Toast sent");
	});

	it("passes the chosen level", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "toast", taskId: CTX.taskId }));

		await handleNotify(args(["it broke"], { level: "error" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.level).toBe("error");
	});

	it("rejects an invalid level", async () => {
		await expect(handleNotify(args(["x"], { level: "loud" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("Invalid --level");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects an empty message", async () => {
		await expect(handleNotify(args([]), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("forwards --desktop and reports the mode", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "desktop", taskId: CTX.taskId }));

		await handleNotify(args(["look at me"], { desktop: "true" }), SOCKET, CTX);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.desktop).toBe(true);
		expect(stdoutOutput).toContain("Desktop notification sent");
	});

	it("rejects --desktop with no task in context", async () => {
		const ctxNoTask: CliContext = { projectId: null, taskId: null, socketPath: SOCKET } as unknown as CliContext;
		await expect(handleNotify(args(["x"], { desktop: "true" }), SOCKET, ctxNoTask)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--desktop needs a task");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("reports focus-mode suppression", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: false, mode: "toast", suppressed: true }));

		await handleNotify(args(["x"]), SOCKET, CTX);

		expect(stdoutOutput).toContain("Focus mode is on");
	});

	it("reports a queued toast", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "toast", queued: true }));

		await handleNotify(args(["x"]), SOCKET, CTX);

		expect(stdoutOutput).toContain("Toast queued until Focus Mode ends");
	});

	it("works without a task (plain non-clickable toast)", async () => {
		const ctxNoTask: CliContext = { projectId: null, taskId: null, socketPath: SOCKET } as unknown as CliContext;
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "toast", taskId: null }));

		await handleNotify(args(["heads up"]), SOCKET, ctxNoTask);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params.taskId).toBeUndefined();
		expect(params.message).toBe("heads up");
	});
});

// ─── attention ─────────────────────────────────────────────────────────────

describe("attention", () => {
	it("raises the badge with a reason on the in-context task", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: CTX.taskId }));

		await handleAttention(args(["waiting for input"]), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.attention", {
			taskId: CTX.taskId,
			reason: "waiting for input",
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Attention badge raised");
	});

	it("errors when no task is in context", async () => {
		const ctxNoTask: CliContext = { projectId: null, taskId: null, socketPath: SOCKET } as unknown as CliContext;
		await expect(handleAttention(args(["x"]), SOCKET, ctxNoTask)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("reports focus-mode suppression", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: false, suppressed: true, taskId: CTX.taskId }));

		await handleAttention(args(["x"]), SOCKET, CTX);

		expect(stdoutOutput).toContain("Focus mode is on");
	});

	it("reports a queued attention badge", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, queued: true, taskId: CTX.taskId }));

		await handleAttention(args(["x"]), SOCKET, CTX);

		expect(stdoutOutput).toContain("Attention badge queued until Focus Mode ends");
	});

	it("surfaces a backend error", async () => {
		mockSend.mockResolvedValue(errResp("Task not found"));
		await expect(handleAttention(args(["x"]), SOCKET, CTX)).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task not found");
	});
});

// ─── ui state ────────────────────────────────────────────────────────────────

describe("ui state", () => {
	it("prints the reported UI state and passes the context task id", async () => {
		mockSend.mockResolvedValue(
			okResp({ appRunning: true, foreground: true, activeProjectId: "proj-001", activeTaskId: "task-9", userIdleSeconds: 4, tmux: null }),
		);

		await handleUi("state", args(), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.state", { taskId: CTX.taskId });
		expect(stdoutOutput).toContain("foreground");
		expect(stdoutOutput).toContain("yes");
		expect(stdoutOutput).toContain("userActivity");
		expect(stdoutOutput).toContain("active (4s idle)");
	});

	it("warns when the user has been idle a while", async () => {
		mockSend.mockResolvedValue(
			okResp({ appRunning: true, foreground: false, activeProjectId: "p", activeTaskId: "t", userIdleSeconds: 900, tmux: null }),
		);

		await handleUi("state", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("idle 15m");
		expect(stdoutOutput).toContain("may not see an in-app toast");
	});

	it("shows 'unknown' activity when idle is null", async () => {
		mockSend.mockResolvedValue(
			okResp({ appRunning: true, foreground: true, activeProjectId: "p", activeTaskId: "t", userIdleSeconds: null, tmux: null }),
		);

		await handleUi("state", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("unknown");
	});

	it("notes when the current task is the focused one", async () => {
		mockSend.mockResolvedValue(
			okResp({ appRunning: true, foreground: true, activeProjectId: CTX.projectId, activeTaskId: CTX.taskId, tmux: null }),
		);

		await handleUi("state", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("This task is currently focused");
	});

	it("renders the tmux layout (ASCII map + pane list) when present", async () => {
		mockSend.mockResolvedValue(
			okResp({
				appRunning: true,
				foreground: false,
				activeProjectId: CTX.projectId,
				activeTaskId: CTX.taskId,
				tmux: {
					sessionName: "dev3-aaaaaaaa",
					exists: true,
					windows: [{ index: 0, name: "agent", active: true, panes: 2, zoomed: false }],
					panes: [
						{ windowIndex: 0, paneId: "%0", active: true, left: 0, top: 0, width: 80, height: 24, command: "claude", title: "" },
						{ windowIndex: 0, paneId: "%1", active: false, left: 0, top: 25, width: 80, height: 24, command: "zsh", title: "" },
					],
				},
			}),
		);

		await handleUi("state", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("dev3-aaaaaaaa");
		expect(stdoutOutput).toContain("claude");
		expect(stdoutOutput).toContain("%0");
		expect(stdoutOutput).toContain("┌"); // ASCII box drawn
	});

	it("emits raw JSON with --json", async () => {
		mockSend.mockResolvedValue(
			okResp({ appRunning: true, foreground: true, activeProjectId: "p", activeTaskId: "t", tmux: null }),
		);

		await handleUi("state", args([], { json: "true" }), SOCKET, CTX);

		expect(stdoutOutput).toContain('"appRunning": true');
		expect(stdoutOutput).not.toContain("foreground     yes");
	});

	it("rejects an unknown subcommand", async () => {
		await expect(handleUi("wat", args(), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});
});
