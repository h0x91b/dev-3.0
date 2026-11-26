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
	tmuxNewWindow: vi.fn(),
	tmuxListWindows: vi.fn(),
	tmuxSelectLayout: vi.fn(),
	tmuxDisplayMessage: vi.fn(),
	tmuxSetWindowOption: vi.fn(),
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
const TMUX_METHODS = [mocks.tmuxListPanes, mocks.tmuxSplitWindow, mocks.tmuxNewWindow, mocks.tmuxListWindows, mocks.tmuxSelectLayout, mocks.tmuxDisplayMessage, mocks.tmuxSetWindowOption, mocks.tmuxSelectPane, mocks.tmuxKillPane];

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Nothing in this module may spawn a process directly.
vi.mock("../spawn", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock("../tmux", () => ({
	PANE_START_COMMAND_FORMAT: { formatString: "#{pane_id}\t#{pane_start_command}", parse: () => [] },
	WINDOW_NAME_FORMAT: { formatString: "windows", parse: () => [] },
	WINDOW_PANE_FORMAT: { formatString: "window-pane", parse: () => [] },
	TMUX_WINDOW_NAME_OPTION: "@dev3_window_name",
	TmuxError: FakeTmuxError,
	taskSessionName: (taskId: string) => `dev3-${taskId.slice(0, 8)}`,
	tmux: {
		listPanes: mocks.tmuxListPanes,
		splitWindow: mocks.tmuxSplitWindow,
		newWindow: mocks.tmuxNewWindow,
		listWindows: mocks.tmuxListWindows,
		selectLayout: mocks.tmuxSelectLayout,
		displayMessage: mocks.tmuxDisplayMessage,
		setWindowOption: mocks.tmuxSetWindowOption,
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
	openTaskPaneInNamedWindow,
	openTaskPaneWindow,
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
	mocks.tmuxListWindows.mockResolvedValue([]);
	mocks.tmuxSelectLayout.mockResolvedValue(undefined);
	mocks.tmuxDisplayMessage.mockResolvedValue({ windowId: "@9" });
	mocks.tmuxSetWindowOption.mockResolvedValue(undefined);
	mocks.tmuxKillPane.mockResolvedValue(undefined);
	mocks.tmuxListPanes.mockResolvedValue([]);
});

// ── Native backend ───────────────────────────────────────────────────────────

describe("openAuxPane (native)", () => {
	it("splits from the coordinator's active pane, returns the native handle and makes ZERO tmux calls", async () => {
		const handle = await openAuxPane(spec(nativeTask));

		expect(mocks.splitNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-1", "vertical", {
			cwd: "/tmp/wt",
			env: { DEV3_TASK_SEQ: "1383", DEV3_TASK_ID: TASK_ID },
			launch: { executable: "/bin/bash", argv: [DEV_MARKER] },
			background: true,
		});
		expect(handle).toEqual({ backend: "native", paneId: "pane-2" });
		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	// Seq 1383: an auxiliary host must be as readable in a process viewer as the
	// agent's own pane, and the seam is the one place that guarantees it.
	it("gives every purpose's pane the task number (variant suffix included), lets the caller's env win, and adds nothing else", async () => {
		const titled = { ...nativeTask, title: "Rotate the prod secret", worktreePath: "/private/wt" } as Task;
		await openAuxPane(spec(titled, { purpose: "gitOp", env: undefined }));
		expect(mocks.splitNativeTaskPane.mock.calls[0][3].env).toEqual({ DEV3_TASK_SEQ: "1383" });

		await openAuxPane(spec(nativeTask, { env: { DEV3_TASK_SEQ: "explicit", FOO: "bar" } }));
		expect(mocks.splitNativeTaskPane.mock.calls[1][3].env).toEqual({ DEV3_TASK_SEQ: "explicit", FOO: "bar" });

		const variant = { id: TASK_ID, seq: 1383, variantIndex: 2, terminalBackend: "native" } as unknown as Task;
		await openAuxPane(spec(variant, { env: undefined }));
		expect(mocks.splitNativeTaskPane.mock.calls[2][3].env.DEV3_TASK_SEQ).toBe("1383-2");
	});

	it("opens in the background by default and focuses the new pane only when the opener asks", async () => {
		await openAuxPane(spec(nativeTask));
		expect(mocks.splitNativeTaskPane.mock.calls[0][3].background).toBe(true);

		await openAuxPane(spec(nativeTask, { focusNewPane: true }));
		expect(mocks.splitNativeTaskPane.mock.calls[1][3].background).toBeFalsy();
		expect(mocks.focusNativeTaskPane).not.toHaveBeenCalled();
	});

	it("forces focus nowhere when the coordinator had no active pane", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue(nativeState(["pane-1"], null));

		await openAuxPane(spec(nativeTask));

		expect(mocks.splitNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-1", "vertical", expect.anything());
		expect(mocks.focusNativeTaskPane).not.toHaveBeenCalled();
	});

	it("closes the purpose's existing panes, live or dead, before opening the new one", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([
			nativePane("pane-1", ["/bin/zsh"]),
			nativePane("pane-8", ["/bin/bash", DEV_MARKER], false),
			nativePane("pane-9", ["/bin/bash", DEV_MARKER]),
		]);

		await openAuxPane(spec(nativeTask));

		expect(mocks.closeNativeTaskPane).toHaveBeenCalledTimes(2);
		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-8");
		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-9");
		expect(mocks.closeNativeTaskPane.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.splitNativeTaskPane.mock.invocationCallOrder[0],
		);
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledTimes(1);
	});

	it("throws AuxPaneUnavailableError when the native terminal is not running or has no panes", async () => {
		for (const state of [null, nativeState([], null)]) {
			mocks.nativeTaskPanesState.mockResolvedValue(state);
			await expect(openAuxPane(spec(nativeTask))).rejects.toBeInstanceOf(AuxPaneUnavailableError);
		}
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
	});
});

describe("native pane lookup by launch-command marker", () => {
	it("findAuxPane / auxPaneAlive / nativeAuxPaneShellPid resolve only the live marked pane", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([
			nativePane("pane-1", ["/bin/zsh"]),
			nativePane("pane-9", ["/bin/bash", DEV_MARKER]),
		]);
		await expect(findAuxPane(nativeTask, "devServer", SOCKET)).resolves.toEqual({ backend: "native", paneId: "pane-9" });
		await expect(auxPaneAlive(nativeTask, "devServer", SOCKET)).resolves.toBe(true);
		await expect(nativeAuxPaneShellPid(nativeTask, "devServer")).resolves.toBe(4242);

		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-9", ["/bin/bash", DEV_MARKER], false)]);
		await expect(auxPaneAlive(nativeTask, "devServer", SOCKET)).resolves.toBe(false);

		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-1", ["/bin/zsh"])]);
		await expect(findAuxPane(nativeTask, "devServer", SOCKET)).resolves.toBeNull();
		await expect(auxPaneAlive(nativeTask, "devServer", SOCKET)).resolves.toBe(false);
		await expect(nativeAuxPaneShellPid(nativeTask, "devServer")).resolves.toBeNull();
	});

	it("auxPurposeOfCommand labels a command only by its own marker, each purpose distinct", () => {
		expect(auxPurposeOfCommand(TASK_ID, ["/bin/bash", DEV_MARKER])).toBe("devServer");
		expect(auxPurposeOfCommand(TASK_ID, ["/bin/bash", auxPaneMarker(TASK_ID, "gitOp") + "rebase.sh"])).toBe("gitOp");
		expect(auxPurposeOfCommand(TASK_ID, ["/bin/bash", auxPaneMarker(TASK_ID, "columnAgent")])).toBe("columnAgent");
		expect(auxPurposeOfCommand(TASK_ID, ["/bin/zsh"])).toBeNull();
		expect(auxPaneMarker(TASK_ID, "columnAgent")).toContain("col-agent");
	});

	// The dialect names the generated script `.sh` on POSIX and `.ps1` on Windows.
	// A marker carrying either extension matches only one of them, so the pane
	// launches on the other platform and is then invisible to every later lookup —
	// is it running, replace it, stop it (Seq 1546).
	it("matches the launched script on BOTH platforms' file names", () => {
		for (const purpose of ["devServer", "columnAgent", "fileBrowser"] as const) {
			const marker = auxPaneMarker(TASK_ID, purpose);
			expect(marker).not.toMatch(/\.(sh|ps1)$/);
			for (const extension of [".sh", ".ps1"]) {
				expect(auxPurposeOfCommand(TASK_ID, ["shell", marker + extension])).toBe(purpose);
			}
		}
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
	function ownedNativePanes(paneIds: string[], alive = true) {
		const owned = new Set(paneIds);
		mocks.nativeTaskPaneCommands.mockImplementation(async () =>
			[...owned].map((paneId) => nativePane(paneId, ["/bin/bash", COL_MARKER], alive)),
		);
		mocks.closeNativeTaskPane.mockImplementation(async (_taskId: string, paneId: string) => {
			owned.delete(paneId);
			return { sessionTornDown: false, state: nativeState(["pane-1"], "pane-1") };
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
			background: true,
		});
		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("clears EVERY pane it owns, not just the first", async () => {
		ownedNativePanes(["pane-7", "pane-8", "pane-9"]);

		await openAuxPane(columnSpec(nativeTask));

		for (const paneId of ["pane-7", "pane-8", "pane-9"]) {
			expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, paneId);
		}
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledTimes(1);
	});

	it("sweeps a pane whose agent already exited", async () => {
		ownedNativePanes(["pane-9"], false);

		await openAuxPane(columnSpec(nativeTask));

		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-9");
	});

	it("refuses to open a second pane when the close is rejected, the closed pane is still listed, or the tmux kill fails", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-9", ["/bin/bash", COL_MARKER])]);
		mocks.closeNativeTaskPane.mockRejectedValueOnce(new Error("host refused to close the pane"));
		await expect(openAuxPane(columnSpec(nativeTask))).rejects.toBeInstanceOf(AuxPaneReplaceError);

		mocks.closeNativeTaskPane.mockResolvedValue({ sessionTornDown: false, state: nativeState(["pane-1"], "pane-1") });
		await expect(openAuxPane(columnSpec(nativeTask))).rejects.toThrow(/still present/);
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();

		mocks.tmuxListPanes.mockResolvedValue([{ paneId: "%4", startCommand: `bash "${COL_MARKER}"` }]);
		mocks.tmuxKillPane.mockRejectedValue(new FakeTmuxError(["kill-pane"], 1, "no such pane"));
		await expect(openAuxPane(columnSpec(tmuxTask))).rejects.toBeInstanceOf(AuxPaneReplaceError);
		expect(mocks.tmuxSplitWindow).not.toHaveBeenCalled();
	});

	it("leaves another purpose's pane alone", async () => {
		mocks.nativeTaskPaneCommands.mockResolvedValue([nativePane("pane-5", ["/bin/bash", DEV_MARKER])]);

		await openAuxPane(columnSpec(nativeTask));

		expect(mocks.closeNativeTaskPane).not.toHaveBeenCalled();
	});

	it("still splits the tmux session to the right at 40% on a tmux task, in the background", async () => {
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
		expect(mocks.tmuxSelectPane.mock.calls.every(([, opts]) => typeof opts?.title === "string")).toBe(true);
	});

	it("re-finds and kills its tmux panes by launch command, not a remembered id", async () => {
		const owned = new Set(["%4", "%6"]);
		mocks.tmuxListPanes.mockImplementation(async () => [
			{ paneId: "%1", startCommand: "/bin/zsh" },
			...[...owned].map((paneId) => ({ paneId, startCommand: `bash "${COL_MARKER}"` })),
		]);
		mocks.tmuxKillPane.mockImplementation(async (paneId: string) => {
			owned.delete(paneId);
		});

		await openAuxPane(columnSpec(tmuxTask));

		expect(mocks.tmuxKillPane).toHaveBeenCalledWith("%4", { socket: SOCKET });
		expect(mocks.tmuxKillPane).toHaveBeenCalledWith("%6", { socket: SOCKET });
		expect(mocks.tmuxSplitWindow).toHaveBeenCalledTimes(1);
	});

	// A lookup that could not RUN is not a lookup that found nothing. Reading a
	// transient tmux failure as "no existing pane" is what would let the previous
	// review agent keep running beside the new one.
	it("refuses when it cannot tell whether a pane already exists (first lookup, verifying lookup, unreadable native set)", async () => {
		mocks.tmuxListPanes.mockRejectedValue(new FakeTmuxError(["list-panes"], 1, "server exited unexpectedly"));
		await expect(openAuxPane(columnSpec(tmuxTask))).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.tmuxKillPane).not.toHaveBeenCalled();

		let looks = 0;
		mocks.tmuxListPanes.mockImplementation(async () => {
			looks += 1;
			if (looks === 1) return [{ paneId: "%4", startCommand: `bash "${COL_MARKER}"` }];
			throw new FakeTmuxError(["list-panes"], 1, "server exited unexpectedly");
		});
		await expect(openAuxPane(columnSpec(tmuxTask))).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.tmuxKillPane).toHaveBeenCalledWith("%4", { socket: SOCKET });
		expect(mocks.tmuxSplitWindow).not.toHaveBeenCalled();

		mocks.nativeTaskPaneCommands.mockRejectedValue(new Error("pane records unreadable"));
		await expect(openAuxPane(columnSpec(nativeTask))).rejects.toBeInstanceOf(AuxPaneUndecidableError);
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
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
	it("splits the task session below at the requested size, titles the pane without focusing it, and makes ZERO native calls", async () => {
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
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith("%7", { socket: SOCKET, title: "Dev Server" });
		expect(mocks.tmuxSplitWindow.mock.calls[0][0].focus).toBeFalsy();
		expect(mocks.nativeTaskPanesState).not.toHaveBeenCalled();
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
		expect(mocks.closeNativeTaskPane).not.toHaveBeenCalled();
		expect(mocks.focusNativeTaskPane).not.toHaveBeenCalled();
		expect(mocks.nativeTaskPaneCommands).not.toHaveBeenCalled();
	});

	it("surfaces a failed split as a readable error", async () => {
		mocks.tmuxSplitWindow.mockRejectedValue(new FakeTmuxError(["split-window"], 1, "no such session"));

		await expect(openAuxPane(spec(tmuxTask))).rejects.toThrow(/tmux split-window failed/);
	});
});

describe("closeAuxPane", () => {
	it("kills the tmux pane best-effort, and does nothing when the purpose owns no pane", async () => {
		await closeAuxPane(tmuxTask, "devServer", SOCKET);
		expect(mocks.tmuxKillPane).not.toHaveBeenCalled();

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
});

// ── Focus ordering (tmux) ─────────────────────────────────────────────────────

describe("openTaskPaneWindow", () => {
	it("opens a detached window in the task session with the task's env, then titles the pane", async () => {
		mocks.tmuxNewWindow.mockResolvedValue({ paneId: "%12", stderr: "" });
		mocks.tmuxSelectPane.mockResolvedValue(undefined);
		const handle = await openTaskPaneWindow({ ...spec(tmuxTask, { title: "Build" }), windowName: "Runs" });
		expect(handle).toEqual({ backend: "tmux", paneId: "%12" });
		expect(mocks.tmuxNewWindow).toHaveBeenCalledWith(
			expect.objectContaining({ target: `${SESSION}:`, name: "Runs", detached: true, env: expect.objectContaining({ DEV3_TASK_ID: TASK_ID }) }),
		);
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith("%12", expect.objectContaining({ title: "Build" }));
	});

	it("refuses on native, which has no windows, and never reaches tmux", async () => {
		await expect(openTaskPaneWindow({ ...spec(nativeTask), windowName: "Runs" })).rejects.toThrow(/no windows/);
		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
	});
});

describe("openTaskPaneInNamedWindow", () => {
	// autoRename mirrors `#{automatic-rename}`: on for a window nobody named, off after `new-window -n`.
	const row = (windowId: string, index: number, name: string, customName = "", autoRename = false) => ({ windowId, index, name, customName, autoRename });

	it("creates a detached window when no window carries the name, and gives it a sticky name for the tab", async () => {
		mocks.tmuxListWindows.mockResolvedValue([row("@1", 0, "main", "", true)]);
		mocks.tmuxNewWindow.mockResolvedValue({ paneId: "%12", stderr: "" });
		mocks.tmuxDisplayMessage.mockResolvedValue({ windowId: "@9" });
		const handle = await openTaskPaneInNamedWindow({ ...spec(tmuxTask), windowName: "Agents" });
		expect(handle).toEqual({ backend: "tmux", paneId: "%12" });
		expect(mocks.tmuxListWindows).toHaveBeenCalledWith(expect.anything(), { target: SESSION, socket: SOCKET });
		expect(mocks.tmuxNewWindow).toHaveBeenCalledWith(expect.objectContaining({ name: "Agents", detached: true }));
		expect(mocks.tmuxDisplayMessage).toHaveBeenCalledWith(expect.anything(), { target: "%12", socket: SOCKET });
		expect(mocks.tmuxSetWindowOption).toHaveBeenCalledWith("@9", "@dev3_window_name", "Agents", { socket: SOCKET });
		expect(mocks.tmuxSplitWindow).not.toHaveBeenCalled();
		expect(mocks.tmuxSelectLayout).not.toHaveBeenCalled();
	});

	it("still opens the window when naming it fails", async () => {
		mocks.tmuxNewWindow.mockResolvedValue({ paneId: "%12", stderr: "" });
		mocks.tmuxSetWindowOption.mockRejectedValue(new Error("gone"));
		await expect(openTaskPaneInNamedWindow({ ...spec(tmuxTask), windowName: "Agents" })).resolves.toEqual({ backend: "tmux", paneId: "%12" });
		mocks.tmuxDisplayMessage.mockRejectedValue(new Error("gone"));
		await expect(openTaskPaneInNamedWindow({ ...spec(tmuxTask), windowName: "Agents" })).resolves.toEqual({ backend: "tmux", paneId: "%12" });
	});

	it("splits into the existing window and evens out only that window", async () => {
		mocks.tmuxListWindows.mockResolvedValue([row("@1", 0, "main", "", true), row("@5", 2, "Agents")]);
		const handle = await openTaskPaneInNamedWindow({ ...spec(tmuxTask, { placement: "right", size: "" }), windowName: "Agents" });
		expect(handle).toEqual({ backend: "tmux", paneId: "%7" });
		expect(mocks.tmuxSplitWindow).toHaveBeenCalledWith(expect.objectContaining({ target: "@5", orientation: "horizontal", printPaneId: true }));
		expect(mocks.tmuxSplitWindow.mock.calls[0][0].focus).toBeUndefined();
		expect(mocks.tmuxSelectLayout).toHaveBeenCalledWith("@5", "even-horizontal", { socket: SOCKET });
		expect(mocks.tmuxNewWindow).not.toHaveBeenCalled();
		expect(mocks.tmuxSetWindowOption).not.toHaveBeenCalled();
	});

	it("matches a window by its @dev3_window_name, and takes the lowest index when several match", async () => {
		mocks.tmuxListWindows.mockResolvedValue([row("@9", 4, "review"), row("@3", 1, "zsh", "review", true), row("@2", 0, "review")]);
		await openTaskPaneInNamedWindow({ ...spec(tmuxTask), windowName: "review" });
		expect(mocks.tmuxSplitWindow.mock.calls[0][0].target).toBe("@2");
	});

	it("never matches an auto-named window by the command it runs", async () => {
		mocks.tmuxListWindows.mockResolvedValue([row("@1", 0, "zsh", "", true), row("@2", 1, "claude", "", true)]);
		mocks.tmuxNewWindow.mockResolvedValue({ paneId: "%12", stderr: "" });
		await openTaskPaneInNamedWindow({ ...spec(tmuxTask), windowName: "zsh" });
		expect(mocks.tmuxSplitWindow).not.toHaveBeenCalled();
		expect(mocks.tmuxNewWindow).toHaveBeenCalledWith(expect.objectContaining({ name: "zsh" }));
	});

	it("matches a window the user renamed by its custom name, even though its command name differs", async () => {
		mocks.tmuxListWindows.mockResolvedValue([row("@1", 0, "zsh", "", true), row("@6", 1, "zsh", "Notes", true)]);
		await openTaskPaneInNamedWindow({ ...spec(tmuxTask), windowName: "Notes" });
		expect(mocks.tmuxSplitWindow.mock.calls[0][0].target).toBe("@6");
	});

	it("does not reuse a window dev3 created as Agents once the user renamed it to Review", async () => {
		mocks.tmuxListWindows.mockResolvedValue([row("@5", 1, "Agents", "Review")]);
		mocks.tmuxNewWindow.mockResolvedValue({ paneId: "%12", stderr: "" });
		await openTaskPaneInNamedWindow({ ...spec(tmuxTask), windowName: "Agents" });
		expect(mocks.tmuxSplitWindow).not.toHaveBeenCalled();
		expect(mocks.tmuxNewWindow).toHaveBeenCalledWith(expect.objectContaining({ name: "Agents" }));
	});

	it("still succeeds when the layout cannot be evened out", async () => {
		mocks.tmuxListWindows.mockResolvedValue([row("@5", 2, "Agents")]);
		mocks.tmuxSelectLayout.mockRejectedValue(new Error("no layout"));
		await expect(openTaskPaneInNamedWindow({ ...spec(tmuxTask), windowName: "Agents" })).resolves.toEqual({ backend: "tmux", paneId: "%7" });
	});

	it("refuses on native and never reaches tmux", async () => {
		await expect(openTaskPaneInNamedWindow({ ...spec(nativeTask), windowName: "Agents" })).rejects.toThrow(/no windows/);
		for (const method of TMUX_METHODS) expect(method).not.toHaveBeenCalled();
	});
});

describe("splitTaskPane focus", () => {
	it("native: opens in the background by default; an explicit focus request lets the new pane take focus", async () => {
		await splitTaskPane(spec(nativeTask));
		expect(mocks.splitNativeTaskPane.mock.calls[0][3].background).toBe(true);

		await splitTaskPane({ ...spec(nativeTask), focus: true });
		expect(mocks.splitNativeTaskPane.mock.calls[1][3].background).toBe(false);
	});

	it("tmux: splits in the background unless the caller (or a focusNewPane opener) asks for focus", async () => {
		await splitTaskPane(spec(tmuxTask, { title: "AI Review" }));
		expect(mocks.tmuxSplitWindow.mock.calls[0][0].focus).toBeUndefined();

		await splitTaskPane({ ...spec(tmuxTask), focus: true });
		expect(mocks.tmuxSplitWindow.mock.calls[1][0].focus).toBe(true);

		await openAuxPane(spec(tmuxTask, { focusNewPane: true }));
		expect(mocks.tmuxSplitWindow.mock.calls[2][0].focus).toBe(true);
	});
});
