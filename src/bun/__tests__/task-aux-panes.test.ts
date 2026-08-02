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
	nativeTaskPaneCommandsStrict: vi.fn(),
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
	// The strict read answers from the same fake pane list; the cases that make it
	// throw or report an unreadable record live in column-agent-strict-discovery,
	// where the production discovery path runs for real.
	nativeTaskPaneCommandsStrict: mocks.nativeTaskPaneCommandsStrict,
	splitNativeTaskPane: mocks.splitNativeTaskPane,
	closeNativeTaskPane: mocks.closeNativeTaskPane,
	focusNativeTaskPane: mocks.focusNativeTaskPane,
}));

import {
	auxPaneAlive,
	auxPaneMarker,
	auxPurposeOfCommand,
	AuxPaneReplaceError,
	AuxPaneUnavailableError,
	AuxPaneUndecidableError,
	closeAuxPane,
	findAuxPane,
	nativeAuxPaneShellPid,
	openAuxPane,
	splitTaskPane,
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
	mocks.nativeTaskPaneCommandsStrict.mockImplementation(async () => ({
		kind: "read",
		panes: await mocks.nativeTaskPaneCommands(),
		unreadable: [],
	}));
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
		expect(auxPurposeOfCommand(TASK_ID, ["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")])).toBe("columnAgent");
		expect(auxPurposeOfCommand(TASK_ID, ["/bin/zsh"])).toBeNull();
	});

	it("owns the column-agent pane by its own marker, distinct from every other purpose", () => {
		const marker = auxPaneMarker(TASK_ID, "columnAgent");
		expect(marker).toContain("col-agent.sh");
		expect(marker).not.toBe(auxPaneMarker(TASK_ID, "devServer"));
		expect(marker).not.toBe(auxPaneMarker(TASK_ID, "gitOp"));
	});
});

// ── The column-agent purpose (AI Review + custom column agents) ────────────────

describe("openAuxPane (columnAgent)", () => {
	const COL_MARKER = auxPaneMarker(TASK_ID, "columnAgent");

	function columnSpec(task: Task) {
		return spec(task, {
			purpose: "columnAgent" as const,
			placement: "right" as const,
			size: "40%",
			title: "AI Review",
			tmuxCommand: `bash "${COL_MARKER}"`,
			nativeLaunch: { executable: "/bin/bash", argv: [COL_MARKER] },
		});
	}

	/**
	 * A pane set that answers honestly: panes it owns are listed until closed, and
	 * gone afterwards. A static list would let a launch through without the close
	 * ever having worked, which is exactly the hole this purpose must not have.
	 */
	function ownedNativePanes(paneIds: string[]) {
		const owned = new Set(paneIds);
		mocks.nativeTaskPaneCommands.mockImplementation(async () =>
			[...owned].map((paneId) => nativePane(paneId, ["/bin/bash", COL_MARKER])),
		);
		mocks.closeNativeTaskPane.mockImplementation(async (_taskId: string, paneId: string) => {
			owned.delete(paneId);
			return { sessionTornDown: false, state: nativeState(["pane-1"], "pane-1") };
		});
		return owned;
	}

	function ownedTmuxPanes(paneIds: string[]) {
		const owned = new Set(paneIds);
		mocks.tmuxListPanes.mockImplementation(async () => [
			{ paneId: "%1", startCommand: "/bin/zsh" },
			...[...owned].map((paneId) => ({ paneId, startCommand: `bash "${COL_MARKER}"` })),
		]);
		mocks.tmuxKillPane.mockImplementation(async (paneId: string) => {
			owned.delete(paneId);
		});
		return owned;
	}

	it("opens a real native pane and makes ZERO tmux calls", async () => {
		const handle = await openAuxPane(columnSpec(nativeTask));

		expect(handle).toEqual({ backend: "native", paneId: "pane-2" });
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-1", "horizontal", {
			cwd: "/tmp/wt",
			env: { DEV3_TASK_SEQ: "1383", DEV3_TASK_ID: TASK_ID },
			launch: { executable: "/bin/bash", argv: [COL_MARKER] },
		});
		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("replaces a pane a previous activation already owns", async () => {
		ownedNativePanes(["pane-9"]);

		await openAuxPane(columnSpec(nativeTask));

		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-9");
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledTimes(1);
	});

	it("clears EVERY pane it owns, not just the first", async () => {
		ownedNativePanes(["pane-7", "pane-8", "pane-9"]);

		await openAuxPane(columnSpec(nativeTask));

		for (const paneId of ["pane-7", "pane-8", "pane-9"]) {
			expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, paneId);
		}
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledTimes(1);
	});

	it("refuses to open a second pane when a close is rejected", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-9", ["/bin/bash", COL_MARKER])]);
		mocks.closeNativeTaskPane.mockRejectedValue(new Error("host refused to close the pane"));

		await expect(openAuxPane(columnSpec(nativeTask))).rejects.toBeInstanceOf(AuxPaneReplaceError);
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
	});

	it("refuses to open a second pane when the closed one is still listed", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-9", ["/bin/bash", COL_MARKER])]);
		mocks.closeNativeTaskPane.mockResolvedValue({ sessionTornDown: false, state: nativeState(["pane-1"], "pane-1") });

		await expect(openAuxPane(columnSpec(nativeTask))).rejects.toThrow(/still present/);
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
	});

	it("sweeps a pane whose agent already exited", async () => {
		const owned = new Set(["pane-9"]);
		mocks.nativeTaskPaneCommands.mockImplementation(async () =>
			[...owned].map((paneId) => nativePane(paneId, ["/bin/bash", COL_MARKER], false)),
		);
		mocks.closeNativeTaskPane.mockImplementation(async (_taskId: string, paneId: string) => {
			owned.delete(paneId);
			return { sessionTornDown: false, state: nativeState(["pane-1"], "pane-1") };
		});

		await openAuxPane(columnSpec(nativeTask));

		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-9");
	});

	it("leaves another purpose's pane alone", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-5", ["/bin/bash", DEV_MARKER])]);

		await openAuxPane(columnSpec(nativeTask));

		expect(mocks.closeNativeTaskPane).not.toHaveBeenCalled();
	});

	it("refuses rather than falling back to tmux when the native terminal is down", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue(null);

		await expect(openAuxPane(columnSpec(nativeTask))).rejects.toBeInstanceOf(AuxPaneUnavailableError);
		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
	});

	it("still splits the tmux session to the right at 40% on a tmux task", async () => {
		const handle = await openAuxPane(columnSpec(tmuxTask));

		expect(mocks.tmuxSplitWindow).toHaveBeenCalledWith({
			target: SESSION,
			orientation: "horizontal",
			size: "40%",
			printPaneId: true,
			env: { DEV3_TASK_SEQ: "1383", DEV3_TASK_ID: TASK_ID },
			cwd: "/tmp/wt",
			command: `bash "${COL_MARKER}"`,
			socket: SOCKET,
		});
		expect(handle).toEqual({ backend: "tmux", paneId: "%7" });
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
	});

	it("re-finds and kills its tmux panes by launch command, not a remembered id", async () => {
		ownedTmuxPanes(["%4", "%6"]);

		await openAuxPane(columnSpec(tmuxTask));

		expect(mocks.tmuxKillPane).toHaveBeenCalledWith("%4", { socket: SOCKET });
		expect(mocks.tmuxKillPane).toHaveBeenCalledWith("%6", { socket: SOCKET });
		expect(mocks.tmuxSplitWindow).toHaveBeenCalledTimes(1);
	});

	// A lookup that could not RUN is not a lookup that found nothing. Reading a
	// transient tmux failure as "no existing pane" is what would let the previous
	// review agent keep running beside the new one.
	it("refuses to open a tmux pane when it cannot tell whether one already exists", async () => {
		mocks.tmuxListPanes.mockRejectedValue(new FakeTmuxError(["list-panes"], 1, "server exited unexpectedly"));

		await expect(openAuxPane(columnSpec(tmuxTask))).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.tmuxSplitWindow).not.toHaveBeenCalled();
		expect(mocks.tmuxKillPane).not.toHaveBeenCalled();
	});

	it("refuses when the VERIFYING lookup fails, after the close appeared to work", async () => {
		let looks = 0;
		mocks.tmuxListPanes.mockImplementation(async () => {
			looks += 1;
			if (looks === 1) return [{ paneId: "%4", startCommand: `bash "${COL_MARKER}"` }];
			throw new FakeTmuxError(["list-panes"], 1, "server exited unexpectedly");
		});

		await expect(openAuxPane(columnSpec(tmuxTask))).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.tmuxKillPane).toHaveBeenCalledWith("%4", { socket: SOCKET });
		expect(mocks.tmuxSplitWindow).not.toHaveBeenCalled();
	});

	it("refuses when a native pane set cannot be read at all", async () => {
		mocks.nativeTaskPaneCommands.mockRejectedValue(new Error("pane records unreadable"));

		await expect(openAuxPane(columnSpec(nativeTask))).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
	});

	it("refuses to open a second tmux pane when the kill fails", async () => {
		mocks.tmuxListPanes.mockResolvedValue([{ paneId: "%4", startCommand: `bash "${COL_MARKER}"` }]);
		mocks.tmuxKillPane.mockRejectedValue(new FakeTmuxError(["kill-pane"], 1, "no such pane"));

		await expect(openAuxPane(columnSpec(tmuxTask))).rejects.toBeInstanceOf(AuxPaneReplaceError);
		expect(mocks.tmuxSplitWindow).not.toHaveBeenCalled();
	});
});

// ── tmux backend (regression guard: behaviour must be unchanged) ──────────────

describe("best-effort purposes keep their old tolerance", () => {
	it("still opens a dev-server pane when the pane lookup fails", async () => {
		mocks.tmuxListPanes.mockRejectedValue(new FakeTmuxError(["list-panes"], 1, "no server running"));

		const handle = await openAuxPane(spec(tmuxTask));

		expect(handle).toEqual({ backend: "tmux", paneId: "%7" });
		expect(mocks.tmuxSplitWindow).toHaveBeenCalledTimes(1);
	});
});

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

// ── Focus ordering (tmux) ─────────────────────────────────────────────────────

describe("splitTaskPane focus ordering (tmux)", () => {
	it("finishes titling the new pane before returning, so a caller's own focus wins", async () => {
		// `select-pane -t` sets the title AND activates that pane. A fire-and-forget
		// title call can land after the caller focused the pane it wants, silently
		// stealing focus back — so the title must be settled before the split returns.
		const order: string[] = [];
		let releaseTitle: (() => void) | undefined;
		const titleSettled = new Promise<void>((resolve) => { releaseTitle = resolve; });
		mocks.tmuxSelectPane.mockImplementation(async (target: string) => {
			if (target === "%7") {
				await titleSettled;
				order.push("title");
				return;
			}
			order.push(`focus:${target}`);
		});

		const opening = splitTaskPane(spec(tmuxTask, { title: "AI Review" }));
		// Nothing may have completed while the title call is still in flight.
		expect(order).toEqual([]);
		releaseTitle?.();
		await opening;
		// Only now may the caller focus its own pane; it must be last.
		await tmuxCaretFocus();

		expect(order).toEqual(["title", "focus:dev3-aaaaaaaa:.0"]);
	});
});

/** What `launchColumnAgent` does after the split: focus the agent pane. */
async function tmuxCaretFocus(): Promise<void> {
	await mocks.tmuxSelectPane(`${SESSION}:.0`, { socket: SOCKET, bestEffort: true });
}
