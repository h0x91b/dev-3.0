/**
 * task-aux-panes tests (seq 1376).
 *
 * Two guarantees, one per backend:
 *  • native never reaches tmux, dedups its own pane, and hands focus back;
 *  • tmux behaves exactly as it did before the module existed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../../shared/types";

const { FakeTmuxError } = vi.hoisted(() => ({
	FakeTmuxError: class FakeTmuxError extends Error {
		constructor(readonly args: string[], readonly exitCode: number, readonly stderr: string) {
			super(`tmux ${args[0] ?? ""} failed (exit ${exitCode}): ${stderr || "unknown error"}`);
			this.name = "TmuxError";
		}
	},
}));

const mocks = vi.hoisted(() => ({
	// tmux singleton — every method is a spy so "no tmux happened" is provable.
	tmuxListPanes: vi.fn(),
	tmuxSplitWindow: vi.fn(),
	tmuxSelectPane: vi.fn(),
	tmuxKillPane: vi.fn(),
	// native-task-panes
	nativeTaskPanesState: vi.fn(),
	nativeTaskPaneCommands: vi.fn(),
	splitNativeTaskPane: vi.fn(),
	closeNativeTaskPane: vi.fn(),
	focusNativeTaskPane: vi.fn(),
}));

/** Every tmux method the module could possibly reach. */
const TMUX_METHODS = [mocks.tmuxListPanes, mocks.tmuxSplitWindow, mocks.tmuxSelectPane, mocks.tmuxKillPane];

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Nothing in this module may spawn a process directly.
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock("../tmux", () => ({
	PANE_START_COMMAND_FORMAT: { formatString: "#{pane_id}\t#{pane_start_command}", parse: () => [] },
	TmuxError: FakeTmuxError,
	taskSessionName: (taskId: string) => `dev3-${taskId.slice(0, 8)}`,
	tmux: {
		listPanes: mocks.tmuxListPanes,
		splitWindow: mocks.tmuxSplitWindow,
		selectPane: mocks.tmuxSelectPane,
		killPane: mocks.tmuxKillPane,
	},
}));

vi.mock("../native-task-panes", () => ({
	nativeTaskPanesState: mocks.nativeTaskPanesState,
	nativeTaskPaneCommands: mocks.nativeTaskPaneCommands,
	splitNativeTaskPane: mocks.splitNativeTaskPane,
	closeNativeTaskPane: mocks.closeNativeTaskPane,
	focusNativeTaskPane: mocks.focusNativeTaskPane,
}));

import {
	auxPaneAlive,
	auxPaneMarker,
	auxPurposeOfCommand,
	AuxPaneUnavailableError,
	closeAuxPane,
	findAuxPane,
	nativeAuxPaneShellPid,
	openAuxPane,
} from "../task-aux-panes";
import { spawn } from "../spawn";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TASK_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION = `dev3-${TASK_ID.slice(0, 8)}`;
const SOCKET = "dev3-sock";

const nativeTask = { id: TASK_ID, seq: 1383, terminalBackend: "native" } as unknown as Task;
const tmuxTask = { id: TASK_ID, seq: 1383 } as unknown as Task;

const DEV_MARKER = auxPaneMarker(TASK_ID, "devServer");

function spec(task: Task, overrides: Partial<Parameters<typeof openAuxPane>[0]> = {}) {
	return {
		task,
		purpose: "devServer" as const,
		placement: "below" as const,
		size: "20%",
		cwd: "/tmp/wt",
		env: { DEV3_TASK_ID: TASK_ID },
		socket: SOCKET,
		title: "Dev Server",
		tmuxCommand: `bash ${DEV_MARKER}`,
		nativeLaunch: { executable: "/bin/bash", argv: [DEV_MARKER] },
		...overrides,
	};
}

function nativePane(paneId: string, command: string[], alive = true) {
	return { paneId, sessionId: `sess-${paneId}`, command, shellPid: 4242, alive };
}

function nativeState(paneIds: string[], activePaneId: string | null) {
	return {
		taskId: TASK_ID,
		panes: paneIds.map((paneId) => ({
			paneId,
			sessionId: `sess-${paneId}`,
			hostPid: 100,
			shellPid: 101,
			cols: 80,
			rows: 24,
			alive: true,
		})),
		layout: null,
		activePaneId,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.nativeTaskPanesState.mockResolvedValue(nativeState(["pane-1"], "pane-1"));
	mocks.nativeTaskPaneCommands.mockResolvedValue([]);
	mocks.splitNativeTaskPane.mockResolvedValue({ paneId: "pane-2", state: nativeState(["pane-1", "pane-2"], "pane-2") });
	mocks.closeNativeTaskPane.mockResolvedValue({ sessionTornDown: false, state: nativeState(["pane-1"], "pane-1") });
	mocks.focusNativeTaskPane.mockResolvedValue(nativeState(["pane-1", "pane-2"], "pane-1"));
	mocks.tmuxSplitWindow.mockResolvedValue({ paneId: "%7", stderr: "" });
	mocks.tmuxSelectPane.mockResolvedValue(undefined);
	mocks.tmuxKillPane.mockResolvedValue(undefined);
	mocks.tmuxListPanes.mockResolvedValue([]);
});

// ── Native backend ───────────────────────────────────────────────────────────

describe("openAuxPane (native)", () => {
	it("splits from the coordinator's active pane and returns the native handle", async () => {
		const handle = await openAuxPane(spec(nativeTask));

		expect(mocks.splitNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-1", "vertical", {
			cwd: "/tmp/wt",
			env: { DEV3_TASK_SEQ: "1383", DEV3_TASK_ID: TASK_ID },
			launch: { executable: "/bin/bash", argv: [DEV_MARKER] },
		});
		expect(handle).toEqual({ backend: "native", paneId: "pane-2" });
	});

	it("makes ZERO tmux calls", async () => {
		await openAuxPane(spec(nativeTask));

		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	// Seq 1383: an auxiliary host must be as readable in a process viewer as the
	// agent's own pane, and the seam is the one place that guarantees it.
	it("gives every purpose's pane the task number, even one the caller did not pass", async () => {
		await openAuxPane(spec(nativeTask, { purpose: "gitOp", env: undefined }));
		const [, , , viewSpec] = mocks.splitNativeTaskPane.mock.calls[0];
		expect(viewSpec.env).toEqual({ DEV3_TASK_SEQ: "1383" });
	});

	it("lets the caller's own env win, so pane identity never overwrites task context", async () => {
		await openAuxPane(spec(nativeTask, { env: { DEV3_TASK_SEQ: "explicit", FOO: "bar" } }));
		const [, , , viewSpec] = mocks.splitNativeTaskPane.mock.calls[0];
		expect(viewSpec.env).toEqual({ DEV3_TASK_SEQ: "explicit", FOO: "bar" });
	});

	it("carries a variant's suffix", async () => {
		const variant = { id: TASK_ID, seq: 1383, variantIndex: 2, terminalBackend: "native" } as unknown as Task;
		await openAuxPane(spec(variant, { env: undefined }));
		const [, , , viewSpec] = mocks.splitNativeTaskPane.mock.calls[0];
		expect(viewSpec.env.DEV3_TASK_SEQ).toBe("1383-2");
	});

	it("does not put anything else about the task into the pane env", async () => {
		const titled = { ...nativeTask, title: "Rotate the prod secret", worktreePath: "/private/wt" } as Task;
		await openAuxPane(spec(titled, { env: undefined }));
		const [, , , viewSpec] = mocks.splitNativeTaskPane.mock.calls[0];
		expect(Object.keys(viewSpec.env)).toEqual(["DEV3_TASK_SEQ"]);
	});

	it("hands focus back to the pane that had it before the split", async () => {
		await openAuxPane(spec(nativeTask));
		expect(mocks.focusNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-1");
	});

	it("forces focus nowhere when the coordinator had no active pane", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue(nativeState(["pane-1"], null));

		await openAuxPane(spec(nativeTask));

		expect(mocks.splitNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-1", "vertical", expect.anything());
		expect(mocks.focusNativeTaskPane).not.toHaveBeenCalled();
	});

	it("closes the purpose's existing pane before opening the new one", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([
			nativePane("pane-1", ["/bin/zsh"]),
			nativePane("pane-9", ["/bin/bash", DEV_MARKER]),
		]);

		await openAuxPane(spec(nativeTask));

		expect(mocks.closeNativeTaskPane).toHaveBeenCalledTimes(1);
		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-9");
		expect(mocks.closeNativeTaskPane.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.splitNativeTaskPane.mock.invocationCallOrder[0],
		);
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledTimes(1);
	});

	it("sweeps a dead owned pane before opening a new one", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-9", ["/bin/bash", DEV_MARKER], false)]);

		await openAuxPane(spec(nativeTask));

		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-9");
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledTimes(1);
	});

	it("throws AuxPaneUnavailableError when the native terminal is not running", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue(null);

		await expect(openAuxPane(spec(nativeTask))).rejects.toBeInstanceOf(AuxPaneUnavailableError);
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
	});

	it("throws AuxPaneUnavailableError when the pane set is empty", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue(nativeState([], null));

		await expect(openAuxPane(spec(nativeTask))).rejects.toBeInstanceOf(AuxPaneUnavailableError);
		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
	});
});

describe("native pane lookup by launch-command marker", () => {
	it("findAuxPane resolves the pane carrying the marker", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([
			nativePane("pane-1", ["/bin/zsh"]),
			nativePane("pane-9", ["/bin/bash", DEV_MARKER]),
		]);

		await expect(findAuxPane(nativeTask, "devServer", SOCKET)).resolves.toEqual({
			backend: "native",
			paneId: "pane-9",
		});
	});

	it("findAuxPane returns null for an ordinary pane", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-1", ["/bin/zsh"])]);
		await expect(findAuxPane(nativeTask, "devServer", SOCKET)).resolves.toBeNull();
	});

	it("auxPaneAlive is true only while the marked pane's process runs", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-9", ["/bin/bash", DEV_MARKER])]);
		await expect(auxPaneAlive(nativeTask, "devServer", SOCKET)).resolves.toBe(true);

		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-9", ["/bin/bash", DEV_MARKER], false)]);
		await expect(auxPaneAlive(nativeTask, "devServer", SOCKET)).resolves.toBe(false);
	});

	it("auxPaneAlive is false for an ordinary pane", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-1", ["/bin/zsh"])]);
		await expect(auxPaneAlive(nativeTask, "devServer", SOCKET)).resolves.toBe(false);
	});

	it("nativeAuxPaneShellPid returns the live pane's pid, null otherwise", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-9", ["/bin/bash", DEV_MARKER])]);
		await expect(nativeAuxPaneShellPid(nativeTask, "devServer")).resolves.toBe(4242);

		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-1", ["/bin/zsh"])]);
		await expect(nativeAuxPaneShellPid(nativeTask, "devServer")).resolves.toBeNull();
	});

	it("auxPurposeOfCommand labels a command only by its own marker", () => {
		expect(auxPurposeOfCommand(TASK_ID, ["/bin/bash", DEV_MARKER])).toBe("devServer");
		expect(auxPurposeOfCommand(TASK_ID, ["/bin/bash", auxPaneMarker(TASK_ID, "gitOp") + "rebase.sh"])).toBe("gitOp");
		expect(auxPurposeOfCommand(TASK_ID, ["/bin/zsh"])).toBeNull();
	});
});

// ── tmux backend (regression guard: behaviour must be unchanged) ──────────────

describe("openAuxPane (tmux)", () => {
	it("splits the task session below at the requested size", async () => {
		const handle = await openAuxPane(spec(tmuxTask));

		expect(mocks.tmuxSplitWindow).toHaveBeenCalledWith({
			target: SESSION,
			orientation: "vertical",
			size: "20%",
			printPaneId: true,
			env: { DEV3_TASK_SEQ: "1383", DEV3_TASK_ID: TASK_ID },
			cwd: "/tmp/wt",
			command: `bash ${DEV_MARKER}`,
			socket: SOCKET,
		});
		expect(handle).toEqual({ backend: "tmux", paneId: "%7" });
	});

	it("maps placement 'right' to a horizontal split", async () => {
		await openAuxPane(spec(tmuxTask, { placement: "right", size: "50%" }));

		expect(mocks.tmuxSplitWindow).toHaveBeenCalledWith(
			expect.objectContaining({ orientation: "horizontal", size: "50%" }),
		);
	});

	it("titles the new pane", async () => {
		await openAuxPane(spec(tmuxTask));
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith("%7", { socket: SOCKET, title: "Dev Server" });
	});

	it("surfaces a failed split as a readable error", async () => {
		mocks.tmuxSplitWindow.mockRejectedValue(new FakeTmuxError(["split-window"], 1, "no such session"));

		await expect(openAuxPane(spec(tmuxTask))).rejects.toThrow(/tmux split-window failed/);
	});

	it("makes ZERO native calls", async () => {
		await openAuxPane(spec(tmuxTask));

		expect(mocks.nativeTaskPanesState).not.toHaveBeenCalled();
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
		expect(mocks.closeNativeTaskPane).not.toHaveBeenCalled();
		expect(mocks.focusNativeTaskPane).not.toHaveBeenCalled();
		expect(mocks.nativeTaskPaneCommands).not.toHaveBeenCalled();
	});
});

describe("closeAuxPane", () => {
	it("kills the tmux pane best-effort", async () => {
		mocks.tmuxListPanes.mockResolvedValue([{ paneId: "%7", startCommand: `bash ${DEV_MARKER}` }]);

		await closeAuxPane(tmuxTask, "devServer", SOCKET);

		expect(mocks.tmuxKillPane).toHaveBeenCalledWith("%7", { socket: SOCKET, bestEffort: true });
	});

	it("closes the native pane through the native backend", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-9", ["/bin/bash", DEV_MARKER])]);

		await closeAuxPane(nativeTask, "devServer", SOCKET);

		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-9");
		expect(mocks.tmuxKillPane).not.toHaveBeenCalled();
	});

	it("does nothing when the purpose owns no pane", async () => {
		await closeAuxPane(tmuxTask, "devServer", SOCKET);
		expect(mocks.tmuxKillPane).not.toHaveBeenCalled();
	});
});
