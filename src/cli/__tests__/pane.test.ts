/**
 * `dev3 pane` CLI (seq 1538) — argument handling and the one thing only the CLI
 * knows: which pane the CALLING agent is sitting in, read from the environment
 * variable its own backend exported, never inferred from the platform.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePane } from "../commands/pane";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { CliResponse } from "../../shared/types";
import { PANE_RUN_TAIL_MAX_LINES, type PaneRunListing, type PaneRunView } from "../../shared/pane-runs";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

let stdoutOutput = "";
let stderrOutput = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const SOCKET = "/tmp/test.sock";
const TASK_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const CTX: CliContext = { projectId: "proj-001", taskId: TASK_ID, socketPath: SOCKET };

function args(flags: Record<string, string> = {}, positional: string[] = []): ParsedArgs {
	return { positional, flags };
}

function okResp(data: unknown): CliResponse {
	return { id: "test-id", ok: true, data };
}

function view(overrides: Partial<PaneRunView> = {}): PaneRunView {
	return {
		runId: "run-0123456789ab",
		label: "Build",
		command: "bun run build",
		paneId: "pane-2",
		backend: "native",
		status: {
			runId: "run-0123456789ab",
			state: "exited",
			pid: 4,
			exitCode: 0,
			startedAt: null,
			endedAt: null,
			detail: null,
		},
		statusDetail: null,
		logPath: "/tmp/x.log",
		lines: ["built"],
		truncated: false,
		totalLines: 1,
		...overrides,
	};
}

function listing(): PaneRunListing {
	return {
		backend: "native",
		screenReadable: false,
		screenReadableDetail: "no screen snapshot",
		selfPaneId: "pane-1",
		panes: [{ paneId: "pane-1", index: 1, label: "pwsh", active: true, self: true, alive: true, runId: null }],
		runs: [],
	};
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
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockSend.mockReset();
	delete process.env.DEV3_PANE_ID;
	delete process.env.TMUX_PANE;
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
	delete process.env.DEV3_PANE_ID;
	delete process.env.TMUX_PANE;
});

describe("dev3 pane list", () => {
	it("reports the backend and the screen-read limit the server stated", async () => {
		mockSend.mockResolvedValue(okResp(listing()));
		await handlePane("list", args(), SOCKET, CTX);
		expect(stdoutOutput).toContain("terminal backend: native");
		expect(stdoutOutput).toContain("NOT readable");
	});

	it("names its own pane from DEV3_PANE_ID on a native task", async () => {
		process.env.DEV3_PANE_ID = "pane-3";
		mockSend.mockResolvedValue(okResp(listing()));
		await handlePane("list", args(), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "pane.list", { taskId: TASK_ID, selfPaneId: "pane-3" });
	});

	it("names its own pane from TMUX_PANE on a tmux task", async () => {
		process.env.TMUX_PANE = "%17";
		mockSend.mockResolvedValue(okResp(listing()));
		await handlePane("list", args(), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "pane.list", { taskId: TASK_ID, selfPaneId: "%17" });
	});

	it("prefers the native id when both are set, and sends nothing when neither is", async () => {
		process.env.DEV3_PANE_ID = "pane-3";
		process.env.TMUX_PANE = "%17";
		mockSend.mockResolvedValue(okResp(listing()));
		await handlePane("list", args(), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "pane.list", { taskId: TASK_ID, selfPaneId: "pane-3" });

		delete process.env.DEV3_PANE_ID;
		delete process.env.TMUX_PANE;
		mockSend.mockClear();
		mockSend.mockResolvedValue(okResp(listing()));
		await handlePane("list", args(), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "pane.list", { taskId: TASK_ID, selfPaneId: undefined });
	});
});

describe("dev3 pane run", () => {
	it("sends the command and tells the agent how to read it back", async () => {
		mockSend.mockResolvedValue(
			okResp({ runId: "run-0123456789ab", paneId: "pane-2", backend: "native", logPath: "/tmp/x.log" }),
		);
		await handlePane("run", args({}, ["bun run build"]), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "pane.run", {
			taskId: TASK_ID,
			command: "bun run build",
			placement: "right",
			label: undefined,
		});
		expect(stdoutOutput).toContain("dev3 pane logs run-0123456789ab");
	});

	it("passes --below and --label through", async () => {
		mockSend.mockResolvedValue(okResp({ runId: "run-0123456789ab", paneId: "%2", backend: "tmux", logPath: "/tmp/x" }));
		await handlePane("run", args({ below: "true", label: "Build" }, ["bun run build"]), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(
			SOCKET,
			"pane.run",
			expect.objectContaining({ placement: "below", label: "Build" }),
		);
	});

	it("refuses to run with no command instead of opening an empty pane", async () => {
		await expect(handlePane("run", args(), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(mockSend).not.toHaveBeenCalled();
		expect(stderrOutput).toContain("needs a command");
	});
});

describe("dev3 pane logs", () => {
	it("prints the outcome above the tail", async () => {
		mockSend.mockResolvedValue(okResp(view()));
		await handlePane("logs", args({}, ["run-0123456789ab"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("outcome: finished — exit code 0");
		expect(stdoutOutput).toContain("built");
	});

	it("refuses a --lines value outside the documented window before calling the app", async () => {
		await expect(
			handlePane("logs", args({ lines: String(PANE_RUN_TAIL_MAX_LINES + 1) }, ["run-0123456789ab"]), SOCKET, CTX),
		).rejects.toThrow(/EXIT_/);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("needs a run id", async () => {
		await expect(handlePane("logs", args(), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("needs a run id");
	});
});

describe("dev3 pane close", () => {
	it("says plainly when nothing was running the run", async () => {
		mockSend.mockResolvedValue(okResp({ closed: false }));
		await handlePane("close", args({}, ["run-0123456789ab"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("no live pane is running run-0123456789ab");
	});
});

describe("usage", () => {
	it("rejects an unknown subcommand rather than guessing", async () => {
		await expect(handlePane("frobnicate", args(), SOCKET, CTX)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("Unknown subcommand: pane frobnicate");
	});

	it("asks for a task when there is none in context", async () => {
		await expect(handlePane("list", args(), SOCKET, null)).rejects.toThrow(/EXIT_/);
		expect(stderrOutput).toContain("No task in context");
	});
});
