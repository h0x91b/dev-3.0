import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleNotify, handleAttention, handleUi } from "../commands/ui-control";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";

vi.mock("../socket-client", () => ({
	sendRequest: vi.fn(),
}));

// Only the endpoint enumeration is faked — the rest of the context module (id
// expansion, project resolution) is the real thing these tests already rely on.
vi.mock("../context", async (importOriginal) => ({
	...(await importOriginal<typeof import("../context")>()),
	allLiveSocketPaths: vi.fn(() => [] as string[]),
}));

import { sendRequest } from "../socket-client";
import { allLiveSocketPaths } from "../context";
const mockSend = vi.mocked(sendRequest);
const mockEndpoints = vi.mocked(allLiveSocketPaths);

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
	mockEndpoints.mockReset();
	mockEndpoints.mockReturnValue([]);
	// The harness that runs these tests may itself be an agent session, and the
	// session id is read from the ambient environment — so every case states
	// whether one exists instead of inheriting the developer's.
	delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(() => {
	delete process.env.CLAUDE_CODE_SESSION_ID;
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
			sourceTaskId: CTX.taskId,
		});
		expect(stdoutOutput).toContain("Toast sent");
	});

	it("names the caller's worktree separately from the task it points at", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "toast", taskId: "other-task" }));

		await handleNotify(args(["look at this"], { task: "other-task" }), SOCKET, CTX);

		expect(mockSend.mock.calls[0][2]).toMatchObject({ taskId: "other-task", sourceTaskId: CTX.taskId });
	});

	it("passes the harness session id only when the environment carries one", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "toast", taskId: CTX.taskId }));

		await handleNotify(args(["hi"]), SOCKET, CTX);
		expect(mockSend.mock.calls[0][2], "never invents one").not.toHaveProperty("sourceSessionId");

		process.env.CLAUDE_CODE_SESSION_ID = "session-xyz";
		await handleNotify(args(["hi"]), SOCKET, CTX);
		expect(mockSend.mock.calls[1][2]).toMatchObject({ sourceSessionId: "session-xyz" });
	});

	it("sends a plain non-clickable toast without the caller's worktree outside one", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "toast", taskId: null }));

		await handleNotify(args(["heads up"]), SOCKET, null);

		const params = mockSend.mock.calls[0]![2]!;
		expect(params).not.toHaveProperty("sourceTaskId");
		expect(params.taskId).toBeUndefined();
		expect(params.message).toBe("heads up");
	});

	it("delivers the toast to every live instance, marking only fan-out copies, and still succeeds when one refuses", async () => {
		mockEndpoints.mockReturnValue([SOCKET, "/tmp/guest-a.sock", "/tmp/guest-b.sock"]);
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "toast", taskId: CTX.taskId }));

		await handleNotify(args(["build is green"]), SOCKET, CTX);

		const dialed = mockSend.mock.calls.map((call) => call[0]);
		expect(dialed).toEqual([SOCKET, "/tmp/guest-a.sock", "/tmp/guest-b.sock"]);
		expect(new Set(mockSend.mock.calls.map((call) => call[1]))).toEqual(new Set(["ui.notify"]));
		expect(stdoutOutput).toContain("Toast sent to 3 instances");
		const [primary, fanout] = mockSend.mock.calls;
		expect(primary[2]).not.toHaveProperty("fanout");
		expect(fanout[2]).toMatchObject({ fanout: true });
		// A second instance that refuses the fan-out does not fail the toast.
		mockEndpoints.mockReturnValue([SOCKET, "/tmp/dying.sock"]);
		mockSend.mockImplementation(async (socket: string) => {
			if (socket !== SOCKET) throw new Error("Empty response from server");
			return okResp({ delivered: true, mode: "toast", taskId: CTX.taskId });
		});

		await handleNotify(args(["build is green"]), SOCKET, CTX);

		expect(stdoutOutput).toContain("Toast sent.");
		expect(stderrOutput).toBe("");
	});

	it("forwards --desktop and does not fan out an OS notification — one machine, one Notification Center", async () => {
		mockEndpoints.mockReturnValue([SOCKET, "/tmp/guest-a.sock"]);
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "desktop", taskId: CTX.taskId }));

		await handleNotify(args(["build is green"], { desktop: "true" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend.mock.calls[0]![2]!.desktop).toBe(true);
		expect(stdoutOutput).toContain("Desktop notification sent.");
	});

	it("passes the chosen level and a custom duration in milliseconds", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, mode: "toast", taskId: CTX.taskId }));

		await handleNotify(args(["it broke"], { level: "error", duration: "15" }), SOCKET, CTX);

		expect(mockSend.mock.calls[0]![2]!).toMatchObject({ level: "error", durationMs: 15_000 });
	});

	it("rejects invalid flags and an empty message before sending", async () => {
		const ctxNoTask: CliContext = { projectId: null, taskId: null, socketPath: SOCKET } as unknown as CliContext;
		const cases: Array<[ParsedArgs, CliContext, string]> = [
			[args(["x"], { duration: "31s" }), CTX, "Invalid --duration"],
			[args(["x"], { duration: "2s", desktop: "true" }), CTX, "cannot be combined with --desktop"],
			[args(["x"], { level: "loud" }), CTX, "Invalid --level"],
			[args(["x"], { desktop: "true" }), ctxNoTask, "--desktop needs a task"],
			[args([]), CTX, ""],
		];
		for (const [a, ctx, message] of cases) {
			stderrOutput = "";
			await expect(handleNotify(a, SOCKET, ctx), message || "empty message").rejects.toThrow("EXIT_3");
			expect(stderrOutput).toContain(message);
		}
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("reports focus-mode suppression and a queued toast", async () => {
		mockSend.mockResolvedValueOnce(okResp({ delivered: false, mode: "toast", suppressed: true }));
		await handleNotify(args(["x"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("Focus mode is on");

		mockSend.mockResolvedValueOnce(okResp({ delivered: true, mode: "toast", queued: true }));
		await handleNotify(args(["x"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("Toast queued until Focus Mode ends");
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

	it("errors without a task in context, with --clear plus a reason, with a valued --clear, and on a backend error", async () => {
		const ctxNoTask: CliContext = { projectId: null, taskId: null, socketPath: SOCKET } as unknown as CliContext;
		await expect(handleAttention(args(["x"]), SOCKET, ctxNoTask)).rejects.toThrow("EXIT_3");
		await expect(handleAttention(args(["all clear"], { clear: "true" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--clear cannot carry a reason");
		// `--clear "text"` parses as clear="text": reject it instead of swallowing the text.
		await expect(handleAttention(args([], { clear: "all clear" }), SOCKET, CTX)).rejects.toThrow("EXIT_3");
		expect(stderrOutput).toContain("--clear takes no value");
		expect(mockSend).not.toHaveBeenCalled();
		mockSend.mockResolvedValue(errResp("Task not found"));
		await expect(handleAttention(args(["x"]), SOCKET, CTX)).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task not found");
	});

	it("reports focus-mode suppression and a queued attention badge", async () => {
		mockSend.mockResolvedValueOnce(okResp({ delivered: false, suppressed: true, taskId: CTX.taskId }));
		await handleAttention(args(["x"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("Focus mode is on");

		mockSend.mockResolvedValueOnce(okResp({ delivered: true, queued: true, taskId: CTX.taskId }));
		await handleAttention(args(["x"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("Attention badge queued until Focus Mode ends");
	});

	it("clears the badge with --clear and sends no reason", async () => {
		mockSend.mockResolvedValue(okResp({ delivered: true, taskId: CTX.taskId }));

		await handleAttention(args([], { clear: "true" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.attention", {
			taskId: CTX.taskId,
			reason: "",
			clear: true,
			projectId: CTX.projectId,
		});
		expect(stdoutOutput).toContain("Attention badge cleared");

		mockSend.mockResolvedValue(okResp({ delivered: false, taskId: CTX.taskId }));
		await handleAttention(args([], { clear: "true" }), SOCKET, CTX);
		expect(stdoutOutput, "windowless app").toContain("nothing to clear");
	});
});

// ─── ui state ────────────────────────────────────────────────────────────────

describe("ui state", () => {
	it("prints the reported UI state, passes the context task id, and notes when this task is focused", async () => {
		mockSend.mockResolvedValue(
			okResp({ appRunning: true, foreground: true, activeProjectId: "proj-001", activeTaskId: "task-9", userIdleSeconds: 4, tmux: null }),
		);

		await handleUi("state", args(), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "ui.state", { taskId: CTX.taskId });
		expect(stdoutOutput).toContain("foreground");
		expect(stdoutOutput).toContain("yes");
		expect(stdoutOutput).toContain("userActivity");
		expect(stdoutOutput).toContain("active (4s idle)");
		mockSend.mockResolvedValue(
			okResp({ appRunning: true, foreground: true, activeProjectId: CTX.projectId, activeTaskId: CTX.taskId, tmux: null }),
		);

		await handleUi("state", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("This task is currently focused");
	});

	it("warns when the user has been idle a while", async () => {
		mockSend.mockResolvedValue(
			okResp({ appRunning: true, foreground: false, activeProjectId: "p", activeTaskId: "t", userIdleSeconds: 900, tmux: null }),
		);

		await handleUi("state", args(), SOCKET, CTX);

		expect(stdoutOutput).toContain("idle 15m");
		expect(stdoutOutput).toContain("may not see an in-app toast");

		stdoutOutput = "";
		mockSend.mockResolvedValue(
			okResp({ appRunning: true, foreground: true, activeProjectId: "p", activeTaskId: "t", userIdleSeconds: null, tmux: null }),
		);
		await handleUi("state", args(), SOCKET, CTX);
		expect(stdoutOutput, "null idle").toContain("unknown");
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
