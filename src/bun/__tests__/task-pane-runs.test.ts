/**
 * task-pane-runs (seq 1538) — the app side of `dev3 pane`.
 *
 * What must hold, per backend:
 *  • a run's spec exists on disk BEFORE the pane does, so the pane's process never
 *    has to have a command quoted into its argv;
 *  • the run id rides in the launch command on both backends, which is how a pane
 *    is re-found without anything being remembered in RAM;
 *  • a native task never reaches tmux;
 *  • what a reader is told about the screen-read limit is the backend's own answer,
 *    not a guess from the platform.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/types";

const { FakeTmuxError } = vi.hoisted(() => ({
	FakeTmuxError: class FakeTmuxError extends Error {
		constructor(readonly args: string[], readonly exitCode: number, readonly stderr: string) {
			super(`tmux failed (exit ${exitCode})`);
			this.name = "TmuxError";
		}
	},
}));

const mocks = vi.hoisted(() => ({
	splitTaskPane: vi.fn(),
	closeTaskPane: vi.fn(),
	tmuxListPanes: vi.fn(),
	nativeTaskPaneCommands: vi.fn(),
	nativeTaskPanesState: vi.fn(),
	runDir: vi.fn(),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../task-aux-panes", () => ({
	splitTaskPane: mocks.splitTaskPane,
	closeTaskPane: mocks.closeTaskPane,
}));

vi.mock("../native-task-panes", () => ({
	nativeTaskPaneCommands: mocks.nativeTaskPaneCommands,
	nativeTaskPanesState: mocks.nativeTaskPanesState,
}));

vi.mock("../tmux", () => ({
	DEFAULT_TMUX_SOCKET: "dev3",
	PANE_START_COMMAND_FORMAT: { formatString: "#{pane_id}\t#{pane_start_command}", parse: () => [] },
	TmuxError: FakeTmuxError,
	taskSessionName: (taskId: string) => `dev3-task-${taskId}`,
	tmux: { listPanes: mocks.tmuxListPanes },
}));

// The run directory is redirected into a scratch dir so a test never writes where
// a real task's runs live.
vi.mock("../pane-run-store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../pane-run-store")>();
	return { ...actual, paneRunDir: mocks.runDir };
});

import { closePaneRun, dev3CliExecutable, paneRunListing, readPaneRun, startPaneRun, PaneRunError } from "../task-pane-runs";
import { paneRunLogPath, paneRunSpecPath, paneRunStatusPath, PANE_RUN_VERB } from "../pane-run-store";

const NATIVE_TASK = {
	id: "11111111-2222-3333-4444-555555555555",
	seq: 1538,
	worktreePath: "/wt",
	terminalBackend: "native",
} as unknown as Task;

const TMUX_TASK = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", seq: 7, worktreePath: "/wt" } as unknown as Task;

let dir = "";

beforeEach(() => {
	vi.clearAllMocks();
	dir = mkdtempSync(join(tmpdir(), "dev3-pane-runs-test-"));
	mocks.runDir.mockReturnValue(dir);
	mocks.splitTaskPane.mockResolvedValue({ backend: "native", paneId: "pane-2" });
	mocks.nativeTaskPaneCommands.mockResolvedValue([]);
	mocks.nativeTaskPanesState.mockResolvedValue(null);
	mocks.tmuxListPanes.mockResolvedValue([]);
	delete process.env.DEV3_PANE_RUN_CLI;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.DEV3_PANE_RUN_CLI;
});

function splitSpec(): Record<string, unknown> {
	return mocks.splitTaskPane.mock.calls[0][0] as Record<string, unknown>;
}

describe("startPaneRun", () => {
	it("writes the run spec before the pane exists, so nothing is quoted into an argv", async () => {
		let specOnDisk: string | null = null;
		mocks.splitTaskPane.mockImplementation(async (spec: Record<string, unknown>) => {
			// Read the spec at the moment the split happens — proving the ORDER, not
			// just that both things eventually exist.
			const runId = /run-[0-9a-f]{12}/.exec(String((spec as { nativeLaunch: { argv: string[] } }).nativeLaunch.argv[2]))![0];
			specOnDisk = readFileSync(paneRunSpecPath(dir, runId), "utf8");
			return { backend: "native", paneId: "pane-2" };
		});

		const started = await startPaneRun({
			task: NATIVE_TASK,
			command: "bun run build",
			placement: "right",
			label: "Build",
			cwd: "/wt",
			env: { FOO: "bar" },
		});

		expect(specOnDisk).not.toBeNull();
		const parsed = JSON.parse(specOnDisk!) as Record<string, unknown>;
		expect(parsed.command).toBe("bun run build");
		expect(parsed.cwd).toBe("/wt");
		expect(parsed.label).toBe("Build");
		expect(parsed.runId).toBe(started.runId);
	});

	it("puts the run id in the launch command on BOTH backends", async () => {
		const started = await startPaneRun({
			task: NATIVE_TASK,
			command: "bun run build",
			placement: "right",
			cwd: "/wt",
			env: {},
		});
		const spec = splitSpec();
		expect((spec.nativeLaunch as { argv: string[] }).argv).toEqual([PANE_RUN_VERB, dir, started.runId]);
		expect(String(spec.tmuxCommand)).toContain(started.runId);
		expect(String(spec.tmuxCommand)).toContain(PANE_RUN_VERB);
	});

	it("splits below when asked, and keeps the agent's focus either way", async () => {
		await startPaneRun({ task: NATIVE_TASK, command: "sleep 1", placement: "below", cwd: "/wt", env: {} });
		expect(splitSpec().placement).toBe("below");
		expect(splitSpec().restoreFocus).toBe(true);
	});

	it("refuses a command that would smuggle a second command into the pane", async () => {
		await expect(
			startPaneRun({ task: NATIVE_TASK, command: "build\nrm -rf /", placement: "right", cwd: "/wt", env: {} }),
		).rejects.toThrow(PaneRunError);
		expect(mocks.splitTaskPane).not.toHaveBeenCalled();
	});

	it("drops a label that is not plain human text instead of passing it on", async () => {
		await startPaneRun({ task: NATIVE_TASK, command: "sleep 1", placement: "right", label: "$(boom)", cwd: "/wt", env: {} });
		expect(splitSpec().title).toBe("Run");
		const runId = (splitSpec().nativeLaunch as { argv: string[] }).argv[2];
		expect(JSON.parse(readFileSync(paneRunSpecPath(dir, runId), "utf8")).label).toBe("");
	});

	it("leaves no spec behind when the pane could not be opened", async () => {
		mocks.splitTaskPane.mockRejectedValue(new Error("the task terminal is not running"));
		await expect(
			startPaneRun({ task: NATIVE_TASK, command: "sleep 1", placement: "right", cwd: "/wt", env: {} }),
		).rejects.toThrow(/terminal is not running/);
		// A spec with no pane would be a phantom run in every later listing.
		expect(readdirSync(dir).filter((name) => name.endsWith(".run.json"))).toEqual([]);
	});

	it("launches an absolute binary, never a tilde a direct spawn cannot expand", async () => {
		expect(dev3CliExecutable().startsWith("~")).toBe(false);
		process.env.DEV3_PANE_RUN_CLI = "/scratch/dev3";
		expect(dev3CliExecutable()).toBe("/scratch/dev3");
	});
});

describe("readPaneRun", () => {
	async function seedRun(task: Task, status?: Record<string, unknown>, log?: string): Promise<string> {
		const started = await startPaneRun({ task, command: "bun run build", placement: "right", cwd: "/wt", env: {} });
		if (status) writeFileSync(paneRunStatusPath(dir, started.runId), JSON.stringify({ runId: started.runId, ...status }));
		if (log !== undefined) writeFileSync(paneRunLogPath(dir, started.runId), log);
		return started.runId;
	}

	it("reports a finished run with its exit code and the pane it ran in", async () => {
		const runId = await seedRun(NATIVE_TASK, { state: "exited", exitCode: 7, pid: 9 }, "boom\n");
		mocks.nativeTaskPaneCommands.mockResolvedValue([{ paneId: "pane-2", command: ["dev3", PANE_RUN_VERB, dir, runId] }]);

		const view = await readPaneRun(NATIVE_TASK, runId);
		expect(view.status?.exitCode).toBe(7);
		expect(view.paneId).toBe("pane-2");
		expect(view.lines).toEqual(["boom"]);
		expect(view.truncated).toBe(false);
	});

	it("bounds the tail and says so, rather than handing over a whole dev-server log", async () => {
		const runId = await seedRun(
			NATIVE_TASK,
			{ state: "running", pid: 5 },
			`${Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")}\n`,
		);
		const view = await readPaneRun(NATIVE_TASK, runId, 10);
		expect(view.lines).toHaveLength(10);
		expect(view.lines[9]).toBe("line 499");
		expect(view.truncated).toBe(true);
		expect(view.totalLines).toBe(500);
	});

	it("never pulls a whole runaway log into memory, and says the count is a floor", async () => {
		// 6 MiB of log against a 4 MiB window: what comes back is the window's tail,
		// and the header must not claim the file has only as many lines as it read.
		const line = `${"x".repeat(99)}\n`;
		const runId = await seedRun(NATIVE_TASK, { state: "running", pid: 5 }, line.repeat(63_000));
		const view = await readPaneRun(NATIVE_TASK, runId, 10);
		expect(view.lines).toHaveLength(10);
		expect(view.logWindowed).toBe(true);
		expect(view.truncated).toBe(true);
		// The first line of the window is dropped, because the window opens mid-line.
		expect(view.lines.every((text) => text === "x".repeat(99))).toBe(true);
		expect(view.totalLines).toBeLessThan(63_000);
	});

	it("reads a log that fits in the window whole, and says so", async () => {
		const runId = await seedRun(NATIVE_TASK, { state: "exited", exitCode: 0 }, "one\ntwo\n");
		const view = await readPaneRun(NATIVE_TASK, runId, 10);
		expect(view.lines).toEqual(["one", "two"]);
		expect(view.logWindowed).toBe(false);
		expect(view.truncated).toBe(false);
	});

	it("says the status is unknown when the status file cannot be believed", async () => {
		const runId = await seedRun(NATIVE_TASK, undefined, "");
		writeFileSync(paneRunStatusPath(dir, runId), "{not json");
		const view = await readPaneRun(NATIVE_TASK, runId);
		expect(view.status).toBeNull();
		expect(view.statusDetail).toMatch(/could not be read/);
	});

	it("refuses a run id that is not one, and a run this task never started", async () => {
		await expect(readPaneRun(NATIVE_TASK, "../../etc/passwd")).rejects.toThrow(/is not a run id/);
		await expect(readPaneRun(NATIVE_TASK, "run-000000000000")).rejects.toThrow(/has no run/);
	});

	it("never reaches tmux for a native task", async () => {
		const runId = await seedRun(NATIVE_TASK, { state: "exited", exitCode: 0 }, "ok\n");
		await readPaneRun(NATIVE_TASK, runId);
		expect(mocks.tmuxListPanes).not.toHaveBeenCalled();
	});

	it("finds a tmux run's pane through pane_start_command", async () => {
		mocks.splitTaskPane.mockResolvedValue({ backend: "tmux", paneId: "%9" });
		const runId = await seedRun(TMUX_TASK, { state: "exited", exitCode: 0 }, "ok\n");
		mocks.tmuxListPanes.mockResolvedValue([{ paneId: "%9", startCommand: `dev3 ${PANE_RUN_VERB} ${dir} ${runId}` }]);
		const view = await readPaneRun(TMUX_TASK, runId);
		expect(view.paneId).toBe("%9");
		expect(view.backend).toBe("tmux");
	});

	it("reads a run whose pane is already gone — the log outlives the pane", async () => {
		const runId = await seedRun(NATIVE_TASK, { state: "exited", exitCode: 1 }, "failed\n");
		mocks.nativeTaskPaneCommands.mockResolvedValue([]);
		const view = await readPaneRun(NATIVE_TASK, runId);
		expect(view.paneId).toBe("");
		expect(view.status?.exitCode).toBe(1);
		expect(view.lines).toEqual(["failed"]);
	});
});

describe("paneRunListing", () => {
	it("states the backend and the screen-read limit from the backend, not the platform", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue({
			taskId: NATIVE_TASK.id,
			panes: [{ paneId: "pane-1", sessionId: "s", hostPid: 1, shellPid: 2, cols: 80, rows: 24, alive: true }],
			layout: "",
			activePaneId: "pane-1",
		});
		const listing = await paneRunListing(NATIVE_TASK, "pane-1");
		expect(listing.backend).toBe("native");
		expect(listing.screenReadable).toBe(false);
		expect(listing.screenReadableDetail).toMatch(/decision 202/);
		expect(listing.panes[0].self).toBe(true);

		const tmuxListing = await paneRunListing(TMUX_TASK, "%1");
		expect(tmuxListing.backend).toBe("tmux");
		expect(tmuxListing.screenReadable).toBe(true);
	});

	it("asks the backend for its panes ONCE, however many runs the task has", async () => {
		mocks.splitTaskPane.mockResolvedValue({ backend: "tmux", paneId: "%9" });
		for (let i = 0; i < 4; i++) {
			await startPaneRun({ task: TMUX_TASK, command: `sleep ${i}`, placement: "right", cwd: "/wt", env: {} });
		}
		mocks.tmuxListPanes.mockClear();

		const listing = await paneRunListing(TMUX_TASK, "%1");
		expect(listing.runs).toHaveLength(4);
		// One list-panes for the whole listing — a lookup per run is a spawn per run.
		expect(mocks.tmuxListPanes).toHaveBeenCalledTimes(1);
		// And no log is read for a listing that prints none.
		expect(listing.runs.every((run) => run.lines.length === 0)).toBe(true);
	});

	it("points a listed run at the pane still executing it", async () => {
		mocks.splitTaskPane.mockResolvedValue({ backend: "tmux", paneId: "%9" });
		const started = await startPaneRun({ task: TMUX_TASK, command: "sleep 60", placement: "right", cwd: "/wt", env: {} });
		mocks.tmuxListPanes.mockResolvedValue([
			{ paneId: "%1", startCommand: "zsh" },
			{ paneId: "%9", startCommand: `dev3 ${PANE_RUN_VERB} ${dir} ${started.runId}` },
		]);

		const listing = await paneRunListing(TMUX_TASK, "%1");
		expect(listing.panes[1].runId).toBe(started.runId);
		expect(listing.runs[0].paneId).toBe("%9");
	});

	it("survives a tmux session that is simply gone", async () => {
		mocks.tmuxListPanes.mockRejectedValue(new FakeTmuxError(["list-panes"], 1, "no server"));
		const listing = await paneRunListing(TMUX_TASK, null);
		expect(listing.panes).toEqual([]);
	});
});

describe("closePaneRun", () => {
	it("closes the pane the run is in", async () => {
		const started = await startPaneRun({ task: NATIVE_TASK, command: "sleep 60", placement: "right", cwd: "/wt", env: {} });
		mocks.nativeTaskPaneCommands.mockResolvedValue([
			{ paneId: "pane-2", command: [PANE_RUN_VERB, dir, started.runId] },
		]);
		expect(await closePaneRun(NATIVE_TASK, started.runId)).toEqual({ closed: true });
		expect(mocks.closeTaskPane).toHaveBeenCalledWith(NATIVE_TASK, { backend: "native", paneId: "pane-2" }, "dev3");
	});

	it("reports honestly when no live pane is running it", async () => {
		const started = await startPaneRun({ task: NATIVE_TASK, command: "sleep 60", placement: "right", cwd: "/wt", env: {} });
		expect(await closePaneRun(NATIVE_TASK, started.runId)).toEqual({ closed: false });
		expect(mocks.closeTaskPane).not.toHaveBeenCalled();
	});
});
