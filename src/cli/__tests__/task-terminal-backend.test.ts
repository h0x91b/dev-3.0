/**
 * `dev3 task terminal-backend` (seq 1292): read-only without `--to`, an explicit
 * opt-in with it, and a refusal for anything else — the CLI never guesses a
 * backend on the user's behalf.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTask } from "../commands/task";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";

vi.mock("../stdin", () => ({ readStdin: vi.fn() }));

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const TASK_ID = "aaaaaaaa-1111-2222-3333-444444444444";

const CTX: CliContext = { projectId: "proj-001", taskId: TASK_ID, socketPath: SOCKET };

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

function report(overrides: Record<string, unknown> = {}): CliResponse {
	return {
		id: "test-id",
		ok: true,
		data: { taskId: TASK_ID, backend: "tmux", explicit: false, liveBackend: null, ...overrides },
	};
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

describe("task terminal-backend — read-only", () => {
	it("asks the app without a target and reports the effective backend", async () => {
		mockSend.mockResolvedValue(report());

		await handleTask("terminal-backend", args([TASK_ID]), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.terminalBackend", { taskId: TASK_ID });
		expect(stdoutOutput).toContain("tmux — default (unmarked task)");
		expect(stdoutOutput).toContain("none");
	});

	it("reports an explicit marker and its live session as explicit", async () => {
		mockSend.mockResolvedValue(report({ backend: "native", explicit: true, liveBackend: "native" }));

		await handleTask("terminal-backend", args([TASK_ID]), SOCKET, null);

		expect(stdoutOutput).toContain("native — explicit");
	});
});

describe("task terminal-backend --to", () => {
	it("sends the requested native switch and says it applies to the next launch", async () => {
		mockSend.mockResolvedValue(report({ backend: "native", explicit: true }));

		await handleTask("terminal-backend", args([TASK_ID], { to: "native" }), SOCKET, null);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.terminalBackend", { taskId: TASK_ID, to: "native" });
		expect(stdoutOutput).toContain("terminal backend → native");
		expect(stdoutOutput).toContain("next launch");
	});

	it("sends an explicit tmux switch back", async () => {
		mockSend.mockResolvedValue(report({ explicit: true }));

		await handleTask("terminal-backend", args([], { to: "tmux" }), SOCKET, CTX);

		expect(mockSend).toHaveBeenCalledWith(SOCKET, "task.terminalBackend", {
			taskId: TASK_ID,
			to: "tmux",
			projectId: "proj-001",
		});
	});

	it("refuses an unsupported backend with the usage code and sends nothing", async () => {
		await expect(
			handleTask("terminal-backend", args([TASK_ID], { to: "wezterm" }), SOCKET, null),
		).rejects.toThrow("EXIT_3");

		expect(stderrOutput).toContain("--to must be tmux or native");
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("task terminal-backend — failures", () => {
	it("exits with the usage code when no task can be resolved", async () => {
		await expect(handleTask("terminal-backend", args(), SOCKET, null)).rejects.toThrow("EXIT_3");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("surfaces the app's error instead of assuming a backend", async () => {
		mockSend.mockResolvedValue({ id: "test-id", ok: false, error: "Task terminal is still live" });

		await expect(
			handleTask("terminal-backend", args([TASK_ID], { to: "native" }), SOCKET, null),
		).rejects.toThrow("EXIT_1");
		expect(stderrOutput).toContain("Task terminal is still live");
	});
});
