/**
 * pane-run-placement (seq 2124) — reading the live layout for `dev3 pane run`.
 *
 * What must hold, per backend: the main pane is found by identity (the caller's
 * pane, then the task's agent pane) and never by focus; only dev3's own output
 * panes are split candidates, so a second agent or a user's shell is never
 * resized; tmux candidates come from the main pane's window only; and a native
 * task never reaches tmux.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "../../shared/types";
import { createSplitTree, serializeSplitTree, splitPane, activatePane } from "../../shared/split-tree";

const { FakeTmuxError } = vi.hoisted(() => ({
	FakeTmuxError: class FakeTmuxError extends Error {
		constructor(readonly args: string[], readonly exitCode: number, readonly stderr: string) {
			super(`tmux failed (exit ${exitCode})`);
			this.name = "TmuxError";
		}
	},
}));

const mocks = vi.hoisted(() => ({
	tmuxListPanes: vi.fn(),
	nativeTaskPaneCommands: vi.fn(),
	nativeTaskPanesState: vi.fn(),
}));

vi.mock("../native-task-panes", () => ({
	nativeTaskPaneCommands: mocks.nativeTaskPaneCommands,
	nativeTaskPanesState: mocks.nativeTaskPanesState,
}));

vi.mock("../tmux", () => ({
	PANE_SPLIT_LAYOUT_FORMAT: { formatString: "", parse: () => [] },
	TmuxError: FakeTmuxError,
	taskSessionName: (taskId: string) => `dev3-task-${taskId}`,
	tmux: { listPanes: mocks.tmuxListPanes },
}));

import { decidePaneRunSplit, isAuxiliaryOutputCommand } from "../pane-run-placement";
import { auxPaneMarker } from "../task-aux-panes";

const TMUX_TASK = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", seq: 7, worktreePath: "/wt" } as unknown as Task;
const NATIVE_TASK = { ...TMUX_TASK, terminalBackend: "native" } as unknown as Task;

const RUN = (n: number) => `'/home/u/.dev3.0/bin/dev3' '__pane-run' '/tmp/runs' 'run-${String(n).padStart(12, "0")}'`;

function row(paneId: string, width: number, height: number, startCommand: string, extra: Record<string, unknown> = {}) {
	return { windowId: "@1", paneId, width, height, dead: false, agentTag: "", startCommand, ...extra };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.tmuxListPanes.mockResolvedValue([]);
	mocks.nativeTaskPaneCommands.mockResolvedValue([]);
	mocks.nativeTaskPanesState.mockResolvedValue(null);
});

describe("isAuxiliaryOutputCommand", () => {
	it("counts runs, dev servers and git panes as dev3 output, and never a column agent", () => {
		expect(isAuxiliaryOutputCommand(TMUX_TASK.id, RUN(1))).toBe(true);
		expect(isAuxiliaryOutputCommand(TMUX_TASK.id, `bash ${auxPaneMarker(TMUX_TASK.id, "devServer")}.sh`)).toBe(true);
		expect(isAuxiliaryOutputCommand(TMUX_TASK.id, `bash ${auxPaneMarker(TMUX_TASK.id, "gitOp")}push.sh`)).toBe(true);
		expect(isAuxiliaryOutputCommand(TMUX_TASK.id, `bash ${auxPaneMarker(TMUX_TASK.id, "columnAgent")}.sh`)).toBe(false);
		expect(isAuxiliaryOutputCommand(TMUX_TASK.id, "claude --session-id x")).toBe(false);
		expect(isAuxiliaryOutputCommand(TMUX_TASK.id, "zsh")).toBe(false);
	});
});

describe("decidePaneRunSplit on tmux", () => {
	it("halves the caller's own pane when there is no output pane yet", async () => {
		mocks.tmuxListPanes.mockResolvedValue([row("%0", 200, 50, "claude"), row("%4", 50, 50, "zsh")]);
		const decision = await decidePaneRunSplit({ task: TMUX_TASK, socket: "dev3", selfPaneId: "%0", below: false });
		expect(decision).toMatchObject({ kind: "split", target: { paneId: "%0", orientation: "horizontal", plan: { splitsMain: true } } });
	});

	it("splits an output pane, never the agent or a user's pane, once one exists", async () => {
		mocks.tmuxListPanes.mockResolvedValue([
			row("%0", 149, 80, "claude"),
			row("%2", 150, 40, RUN(1)),
			// A user shell that is bigger than anything else is still not ours to split.
			row("%3", 150, 39, "zsh"),
		]);
		const decision = await decidePaneRunSplit({ task: TMUX_TASK, socket: "dev3", selfPaneId: "%0", below: false });
		expect(decision).toMatchObject({ kind: "split", target: { paneId: "%2", plan: { splitsMain: false } } });
	});

	it("finds the main pane by the task's agent registry when the caller is not in a pane", async () => {
		const task = { ...TMUX_TASK, sessionState: { panes: [{ paneId: "%7", agentCmd: "claude" }] } } as unknown as Task;
		mocks.tmuxListPanes.mockResolvedValue([row("%1", 100, 50, "zsh"), row("%7", 200, 50, "claude")]);
		const decision = await decidePaneRunSplit({ task, socket: "dev3", selfPaneId: null, below: false });
		expect(decision).toMatchObject({ kind: "split", target: { paneId: "%7" } });
	});

	it("falls back to the oldest tagged agent pane, then the oldest pane — never the focused one", async () => {
		mocks.tmuxListPanes.mockResolvedValue([row("%9", 200, 50, "zsh"), row("%5", 200, 50, "codex", { agentTag: "1" })]);
		const tagged = await decidePaneRunSplit({ task: TMUX_TASK, socket: "dev3", selfPaneId: null, below: false });
		expect(tagged).toMatchObject({ target: { paneId: "%5" } });

		mocks.tmuxListPanes.mockResolvedValue([row("%9", 200, 50, "zsh"), row("%5", 200, 50, "zsh")]);
		const oldest = await decidePaneRunSplit({ task: TMUX_TASK, socket: "dev3", selfPaneId: null, below: false });
		expect(oldest).toMatchObject({ target: { paneId: "%5" } });
	});

	it("only considers output panes in the main pane's own window", async () => {
		mocks.tmuxListPanes.mockResolvedValue([
			row("%0", 200, 50, "claude"),
			row("%8", 200, 50, RUN(2), { windowId: "@2" }),
		]);
		const decision = await decidePaneRunSplit({ task: TMUX_TASK, socket: "dev3", selfPaneId: "%0", below: false });
		expect(decision).toMatchObject({ target: { paneId: "%0", plan: { splitsMain: true } } });
	});

	it("asks for a new window instead of splitting the agent again when the main window is full", async () => {
		mocks.tmuxListPanes.mockResolvedValue([row("%0", 49, 30, "claude"), row("%1", 50, 14, RUN(1)), row("%2", 50, 15, RUN(2))]);
		const decision = await decidePaneRunSplit({ task: TMUX_TASK, socket: "dev3", selfPaneId: "%0", below: false });
		expect(decision.kind).toBe("new-window");
	});

	it("fills a window dev3 opened for output before opening another one", async () => {
		mocks.tmuxListPanes.mockResolvedValue([
			row("%0", 49, 30, "claude"),
			row("%1", 50, 14, RUN(1)),
			row("%2", 50, 15, RUN(2)),
			row("%5", 110, 32, RUN(3), { windowId: "@2" }),
		]);
		const decision = await decidePaneRunSplit({ task: TMUX_TASK, socket: "dev3", selfPaneId: "%0", below: false });
		expect(decision).toMatchObject({ kind: "split", target: { paneId: "%5", orientation: "horizontal" } });
	});

	it("never overflows into a window that holds anything besides dev3 output", async () => {
		mocks.tmuxListPanes.mockResolvedValue([
			row("%0", 49, 30, "claude"),
			row("%1", 50, 14, RUN(1)),
			row("%2", 50, 15, RUN(2)),
			row("%5", 110, 32, RUN(3), { windowId: "@2" }),
			row("%6", 110, 32, "zsh", { windowId: "@2" }),
		]);
		const decision = await decidePaneRunSplit({ task: TMUX_TASK, socket: "dev3", selfPaneId: "%0", below: false });
		expect(decision.kind).toBe("new-window");
	});

	it("says the layout is unknown when the session cannot be listed", async () => {
		mocks.tmuxListPanes.mockRejectedValue(new FakeTmuxError([], 1, "no such session"));
		const decision = await decidePaneRunSplit({ task: TMUX_TASK, socket: "dev3", selfPaneId: null, below: false });
		expect(decision.kind).toBe("unplanned");
	});
});

describe("decidePaneRunSplit on native", () => {
	function nativeLayout() {
		// pane-1 agent | pane-2 run; focus deliberately sits on the run pane.
		let tree = splitPane(createSplitTree(), "pane-1", "horizontal");
		tree = activatePane(tree, "pane-2");
		return tree;
	}

	it("splits the run pane by the SplitTree's geometry and never asks tmux", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue({
			taskId: NATIVE_TASK.id,
			activePaneId: "pane-2",
			layout: serializeSplitTree(nativeLayout()),
			panes: [
				{ paneId: "pane-1", cols: 150, rows: 80, alive: true },
				// A pane no view attached to still reports its spawn size.
				{ paneId: "pane-2", cols: 80, rows: 24, alive: true },
			],
		});
		mocks.nativeTaskPaneCommands.mockResolvedValue([
			{ paneId: "pane-1", command: ["claude"] },
			{ paneId: "pane-2", command: ["/bin/dev3", "__pane-run", "/tmp/runs", "run-000000000001"] },
		]);
		const decision = await decidePaneRunSplit({ task: NATIVE_TASK, socket: "dev3", selfPaneId: "pane-1", below: false });
		// 150x80 of real cells: stacking (150x40) beats side by side (75x80).
		expect(decision).toMatchObject({ kind: "split", target: { paneId: "pane-2", orientation: "vertical" } });
		expect(mocks.tmuxListPanes).not.toHaveBeenCalled();
	});

	it("protects the task's first pane even when the CLI was called from elsewhere", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue({
			taskId: NATIVE_TASK.id,
			activePaneId: "pane-1",
			layout: serializeSplitTree(createSplitTree()),
			panes: [{ paneId: "pane-1", cols: 200, rows: 50, alive: true }],
		});
		mocks.nativeTaskPaneCommands.mockResolvedValue([{ paneId: "pane-1", command: ["claude"] }]);
		const decision = await decidePaneRunSplit({ task: NATIVE_TASK, socket: "dev3", selfPaneId: null, below: false });
		expect(decision).toMatchObject({ target: { paneId: "pane-1", orientation: "horizontal", plan: { splitsMain: true } } });
	});

	it("reports no room on native, which has no windows to overflow into", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue({
			taskId: NATIVE_TASK.id,
			activePaneId: "pane-1",
			layout: serializeSplitTree(createSplitTree()),
			panes: [{ paneId: "pane-1", cols: 60, rows: 12, alive: true }],
		});
		mocks.nativeTaskPaneCommands.mockResolvedValue([{ paneId: "pane-1", command: ["claude"] }]);
		const decision = await decidePaneRunSplit({ task: NATIVE_TASK, socket: "dev3", selfPaneId: null, below: false });
		expect(decision.kind).toBe("no-room");
	});

	it("says the layout is unknown when the pane set cannot be read", async () => {
		const decision = await decidePaneRunSplit({ task: NATIVE_TASK, socket: "dev3", selfPaneId: null, below: false });
		expect(decision.kind).toBe("unplanned");
	});
});
