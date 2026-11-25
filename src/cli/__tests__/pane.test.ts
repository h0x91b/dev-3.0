/**
 * `dev3 pane` CLI (seq 1538) — argument handling and the one thing only the CLI
 * knows: which pane the CALLING agent is sitting in, read from the environment
 * variable its own backend exported, never inferred from the platform.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePane } from "../commands/pane";
import { CLI_EXIT_CODE_PANE_NO_ROOM } from "../../shared/cli-exit-codes";
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

	it("names its own pane: DEV3_PANE_ID on native, TMUX_PANE on tmux, native first, nothing when neither", async () => {
		const cases: Array<[string | undefined, string | undefined, string | undefined]> = [
			["pane-3", undefined, "pane-3"],
			[undefined, "%17", "%17"],
			["pane-3", "%17", "pane-3"],
			[undefined, undefined, undefined],
		];
		for (const [native, tmux, expected] of cases) {
			if (native === undefined) delete process.env.DEV3_PANE_ID;
			else process.env.DEV3_PANE_ID = native;
			if (tmux === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = tmux;
			mockSend.mockClear();
			mockSend.mockResolvedValue(okResp(listing()));
			await handlePane("list", args(), SOCKET, CTX);
			expect(mockSend, `${native}/${tmux}`).toHaveBeenCalledWith(SOCKET, "pane.list", { taskId: TASK_ID, projectId: "proj-001", selfPaneId: expected });
		}
	});
});

describe("dev3 pane run", () => {
	it("sends the command, passes --below/--label, and tells the agent how to read it back", async () => {
		mockSend.mockResolvedValue(
			okResp({ runId: "run-0123456789ab", paneId: "pane-2", backend: "native", logPath: "/tmp/x.log" }),
		);
		await handlePane("run", args({}, ["bun run build"]), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "pane.run", {
			taskId: TASK_ID,
			projectId: "proj-001",
			command: "bun run build",
			placement: "auto",
			selfPaneId: undefined,
			label: undefined,
		});
		expect(stdoutOutput).toContain("dev3 pane logs run-0123456789ab");

		mockSend.mockResolvedValue(okResp({ runId: "run-0123456789ab", paneId: "%2", backend: "tmux", logPath: "/tmp/x" }));
		await handlePane("run", args({ below: "true", label: "Build" }, ["bun run build"]), SOCKET, CTX);
		expect(mockSend).toHaveBeenLastCalledWith(SOCKET, "pane.run", expect.objectContaining({ placement: "below", label: "Build" }));
	});

	it("exits with the no-room code, and the message without its wire prefix, when nothing fits", async () => {
		mockSend.mockResolvedValue({ id: "test-id", ok: false, error: "DEV3_PANE_NO_ROOM: no room for another pane — too small" });
		await expect(handlePane("run", args({}, ["bun run build"]), SOCKET, CTX)).rejects.toThrow(
			`EXIT_${CLI_EXIT_CODE_PANE_NO_ROOM}`,
		);
		expect(stderrOutput).toContain("no room for another pane");
		expect(stderrOutput).not.toContain("DEV3_PANE_NO_ROOM");
	});
});

describe("dev3 pane logs", () => {
	it("prints the outcome above the tail", async () => {
		mockSend.mockResolvedValue(okResp(view()));
		await handlePane("logs", args({}, ["run-0123456789ab"]), SOCKET, CTX);
		expect(stdoutOutput).toContain("outcome: finished — exit code 0");
		expect(stdoutOutput).toContain("built");
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
	it("refuses bad input before calling the app: no command, bad --lines, no run id, unknown subcommand, no task", async () => {
		const cases: Array<[string, ParsedArgs, CliContext | null, string]> = [
			["run", args(), CTX, "needs a command"],
			["logs", args({ lines: String(PANE_RUN_TAIL_MAX_LINES + 1) }, ["run-0123456789ab"]), CTX, "--lines"],
			["logs", args(), CTX, "needs a run id"],
			["frobnicate", args(), CTX, "Unknown subcommand: pane frobnicate"],
			["list", args(), null, "No task in context"],
		];
		for (const [sub, parsed, ctx, message] of cases) {
			stderrOutput = "";
			await expect(handlePane(sub, parsed, SOCKET, ctx), message).rejects.toThrow(/EXIT_/);
			expect(stderrOutput, message).toContain(message);
		}
		expect(mockSend).not.toHaveBeenCalled();
	});
});
