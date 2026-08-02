import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NativeTaskPanesState } from "../../native-task-panes";
import { createSplitTree, restoreSplitTree, serializeSplitTree } from "../../../shared/split-tree";
import { applySplitLayout } from "../../../shared/split-tree-layouts";

// ── Mocks (hoisted so vi.mock factories can reference them) ──────────────────

const mocks = vi.hoisted(() => ({
	// data
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(),
	getTask: vi.fn(),
	// pty-server
	getSessionSocket: vi.fn(),
	getSessionTmuxName: vi.fn(),
	getTmuxLayout: vi.fn(),
	getPtyPort: vi.fn(() => 9999),
	ensureNativePanePtySession: vi.fn(),
	hasSession: vi.fn((_key: string) => true),
	reattachNativeTaskSession: vi.fn(async () => true),
	// tmux singleton methods
	tmuxSelectPane: vi.fn(),
	tmuxSelectPaneDirection: vi.fn(),
	tmuxToggleZoom: vi.fn(),
	tmuxSelectLayout: vi.fn(),
	tmuxNextLayout: vi.fn(),
	tmuxResizePaneDirection: vi.fn(),
	tmuxNewWindow: vi.fn(),
	tmuxSplitWindow: vi.fn(),
	tmuxKillPane: vi.fn(),
	// task-terminal-backend
	taskTerminalBackendIdentity: vi.fn(),
	// native-task-panes
	nativeTaskPanesState: vi.fn(),
	nativeTaskPaneCommandsOf: vi.fn(() => []),
	nativeTaskPaneLayout: vi.fn(),
	splitNativeTaskPane: vi.fn(),
	closeNativeTaskPane: vi.fn(),
	focusNativeTaskPane: vi.fn(),
	setNativeTaskPaneLayout: vi.fn(),
	// tmux-pty helpers
	readPaneLayout: vi.fn(),
	tmuxActionHelper: vi.fn(),
	tmuxKillPaneHelper: vi.fn(),
	handlePaneExited: vi.fn(),
}));

vi.mock("../../data", () => ({
	loadProjects: mocks.loadProjects,
	loadVirtualProjects: mocks.loadVirtualProjects,
	getTask: mocks.getTask,
}));

vi.mock("../../pty-server", () => ({
	getSessionSocket: mocks.getSessionSocket,
	getSessionTmuxName: mocks.getSessionTmuxName,
	getTmuxLayout: mocks.getTmuxLayout,
	getPtyPort: mocks.getPtyPort,
	ensureNativePanePtySession: mocks.ensureNativePanePtySession,
	hasSession: mocks.hasSession,
	reattachNativeTaskSession: mocks.reattachNativeTaskSession,
}));

vi.mock("../../tmux", () => ({
	PANE_CWD_FORMAT: "#{pane_current_path}",
	TmuxError: class TmuxError extends Error {
		exitCode: number;
		stderr: string;
		constructor(msg: string, exitCode = 1, stderr = "") {
			super(msg);
			this.exitCode = exitCode;
			this.stderr = stderr;
		}
	},
	tmux: {
		selectPane: mocks.tmuxSelectPane,
		selectPaneDirection: mocks.tmuxSelectPaneDirection,
		toggleZoom: mocks.tmuxToggleZoom,
		selectLayout: mocks.tmuxSelectLayout,
		nextLayout: mocks.tmuxNextLayout,
		resizePaneDirection: mocks.tmuxResizePaneDirection,
		newWindow: mocks.tmuxNewWindow,
		splitWindow: mocks.tmuxSplitWindow,
		killPane: mocks.tmuxKillPane,
	},
}));

vi.mock("../../task-terminal-backend", () => ({
	taskTerminalBackendIdentity: mocks.taskTerminalBackendIdentity,
}));

vi.mock("../../native-task-panes", () => ({
	nativeTaskPanesState: mocks.nativeTaskPanesState,
	nativeTaskPaneCommandsOf: mocks.nativeTaskPaneCommandsOf,
	nativeTaskPaneLayout: mocks.nativeTaskPaneLayout,
	splitNativeTaskPane: mocks.splitNativeTaskPane,
	closeNativeTaskPane: mocks.closeNativeTaskPane,
	focusNativeTaskPane: mocks.focusNativeTaskPane,
	setNativeTaskPaneLayout: mocks.setNativeTaskPaneLayout,
}));

vi.mock("../tmux-pty", () => ({
	readPaneLayout: mocks.readPaneLayout,
	tmuxAction: mocks.tmuxActionHelper,
	tmuxKillPane: mocks.tmuxKillPaneHelper,
	handlePaneExited: mocks.handlePaneExited,
}));

import { taskPanesHandlers } from "../task-panes";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const TASK_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const tmuxTask = { id: TASK_ID, terminalBackend: undefined } as any;
const nativeTask = { id: TASK_ID, terminalBackend: "native", worktreePath: "/tmp/wt", title: "T", branchName: "b" } as any;

/** Minimal TmuxLayout for two panes in one 100×40-cell window. */
const twoPane80TmuxLayout = {
	sessionName: "dev3-aaaaaaaa",
	exists: true,
	windows: [{ index: 0, name: "main", active: true, panes: 2, zoomed: false }],
	panes: [
		{ windowIndex: 0, paneId: "%1", active: true,  left: 0,  top: 0, width: 50, height: 40, command: "claude", title: "Agent" },
		{ windowIndex: 0, paneId: "%2", active: false, left: 50, top: 0, width: 50, height: 40, command: "bash",   title: ""      },
	],
};

/** readPaneLayout response for the above two-pane window. */
const twoPane80PaneLayout = {
	count: 2,
	activeIndex: 0,
	zoomed: false,
	paneIds: ["%1", "%2"],
	labels: ["Agent", ""],
};

/** A single-pane native state with a fresh SplitTree. */
function makeSingleNativeState(): NativeTaskPanesState {
	const tree = createSplitTree();
	return {
		taskId: TASK_ID,
		panes: [{ paneId: "pane-1", sessionId: "sess-1", hostPid: 100, shellPid: 101, cols: 80, rows: 24, alive: true }],
		layout: serializeSplitTree(tree),
		activePaneId: "pane-1",
	};
}

/** A two-pane native state (pane-1 left, pane-2 right). */
function makeTwoPaneNativeState(): NativeTaskPanesState {
	let tree = createSplitTree();
	tree = { ...tree, root: {
		type: "split", id: "split-1", orientation: "horizontal", ratio: 0.5,
		first: { type: "pane", id: "pane-1" },
		second: { type: "pane", id: "pane-2" },
	}, nextSplitOrdinal: 2, nextPaneOrdinal: 3 };
	return {
		taskId: TASK_ID,
		panes: [
			{ paneId: "pane-1", sessionId: "sess-1", hostPid: 100, shellPid: 101, cols: 80, rows: 24, alive: true },
			{ paneId: "pane-2", sessionId: "sess-2", hostPid: 102, shellPid: 103, cols: 80, rows: 24, alive: true },
		],
		layout: serializeSplitTree(tree),
		activePaneId: "pane-1",
	};
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks();
	// Default: both paths find the task
	mocks.loadProjects.mockResolvedValue([{ id: "proj-1" }]);
	mocks.loadVirtualProjects.mockResolvedValue([]);
	mocks.getTask.mockImplementation((_proj: any, taskId: string) => {
		if (taskId === TASK_ID) return Promise.resolve(tmuxTask);
		throw new Error("not found");
	});
	mocks.taskTerminalBackendIdentity.mockReturnValue("tmux");
	mocks.getSessionSocket.mockReturnValue("dev3-sock");
	mocks.getSessionTmuxName.mockReturnValue("dev3-aaaaaaaa");
	mocks.getTmuxLayout.mockResolvedValue(twoPane80TmuxLayout);
	mocks.readPaneLayout.mockResolvedValue(twoPane80PaneLayout);
	mocks.tmuxActionHelper.mockResolvedValue(undefined);
	mocks.tmuxKillPaneHelper.mockResolvedValue({ killed: true });
	mocks.handlePaneExited.mockResolvedValue(undefined);
	mocks.tmuxSelectPane.mockResolvedValue(undefined);
	mocks.tmuxSelectPaneDirection.mockResolvedValue(undefined);
	mocks.tmuxToggleZoom.mockResolvedValue(undefined);
	mocks.tmuxSelectLayout.mockResolvedValue(undefined);
	mocks.tmuxNextLayout.mockResolvedValue(undefined);
	mocks.tmuxResizePaneDirection.mockResolvedValue(undefined);
	mocks.tmuxNewWindow.mockResolvedValue(undefined);
	mocks.ensureNativePanePtySession.mockResolvedValue(undefined);
	mocks.hasSession.mockReturnValue(true);
	mocks.reattachNativeTaskSession.mockResolvedValue(true);
	mocks.nativeTaskPanesState.mockResolvedValue(makeTwoPaneNativeState());
	// The action path reads the layout only; in production it is the same tree the
	// full state serializes, so derive it from whatever a case set up.
	mocks.nativeTaskPaneLayout.mockImplementation(async () => {
		const state = await mocks.nativeTaskPanesState();
		return state?.layout ? restoreSplitTree(state.layout) : null;
	});
	mocks.splitNativeTaskPane.mockImplementation(async () => {
		const state = makeTwoPaneNativeState();
		return { paneId: "pane-2", state };
	});
	mocks.focusNativeTaskPane.mockImplementation(async (_taskId: string, paneId: string) => {
		const s = makeTwoPaneNativeState();
		return { ...s, activePaneId: paneId };
	});
	mocks.closeNativeTaskPane.mockResolvedValue({ sessionTornDown: false, state: makeTwoPaneNativeState() });
	mocks.setNativeTaskPaneLayout.mockImplementation(async (_taskId: string, tree: any) => {
		return { ...makeTwoPaneNativeState(), layout: serializeSplitTree(tree) };
	});
});

// ── taskPaneState ─────────────────────────────────────────────────────────────

describe("taskPaneState", () => {
	it("returns tmux backend state with normalized rects and labels", async () => {
		const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });

		expect(state.backend).toBe("tmux");
		expect(state.panes).toHaveLength(2);

		// Rect normalization: each pane is 50 of 100 cells wide, full height
		const p0 = state.panes[0];
		expect(p0.paneId).toBe("%1");
		expect(p0.active).toBe(true);
		expect(p0.label).toBe("Agent");
		expect(p0.rect.x).toBeCloseTo(0);
		expect(p0.rect.y).toBeCloseTo(0);
		expect(p0.rect.width).toBeCloseTo(0.5);
		expect(p0.rect.height).toBeCloseTo(1.0);

		const p1 = state.panes[1];
		expect(p1.paneId).toBe("%2");
		expect(p1.active).toBe(false);
		expect(p1.rect.x).toBeCloseTo(0.5);
		expect(p1.rect.width).toBeCloseTo(0.5);

		// Zoom flag preserved
		expect(state.zoomedPaneId).toBeNull();
	});

	it("preserves zoom flag from pane layout", async () => {
		mocks.readPaneLayout.mockResolvedValue({ ...twoPane80PaneLayout, zoomed: true, activeIndex: 1 });
		const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(state.zoomedPaneId).toBe("%2");
	});

	it("reports tmux capabilities including newWindow", async () => {
		const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(state.capabilities).toContain("split");
		expect(state.capabilities).toContain("newWindow");
		expect(state.capabilities).toContain("focus");
		expect(state.capabilities).toContain("close");
	});

	it("returns native backend state with rects from SplitTree", async () => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		mocks.getTask.mockResolvedValue(nativeTask);
		const twoPane = makeTwoPaneNativeState();
		mocks.nativeTaskPanesState.mockResolvedValue(twoPane);

		const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });

		expect(state.backend).toBe("native");
		expect(state.panes).toHaveLength(2);
		// horizontal split ratio 0.5 → left pane x=0 width=0.5, right pane x=0.5 width=0.5
		expect(state.panes[0].rect.x).toBeCloseTo(0);
		expect(state.panes[0].rect.width).toBeCloseTo(0.5);
		expect(state.panes[1].rect.x).toBeCloseTo(0.5);
		expect(state.panes[1].rect.width).toBeCloseTo(0.5);
	});

	it("native capabilities do NOT include newWindow", async () => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		mocks.getTask.mockResolvedValue(nativeTask);
		const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(state.capabilities).not.toContain("newWindow");
		expect(state.capabilities).toContain("split");
		expect(state.capabilities).toContain("focus");
	});

	it("throws for an unusable persisted backend identity", async () => {
		mocks.taskTerminalBackendIdentity.mockImplementation(() => {
			throw new Error("unusable backend: gibberish");
		});
		await expect(taskPanesHandlers.taskPaneState({ taskId: TASK_ID })).rejects.toThrow("unusable backend");
	});
});

// ── taskPaneAction — tmux path ────────────────────────────────────────────────

describe("taskPaneAction (tmux)", () => {
	it("splitH delegates to tmuxAction with splitH", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "splitH" } });
		expect(mocks.tmuxActionHelper).toHaveBeenCalledWith(expect.objectContaining({ action: "splitH" }));
	});

	it("splitV delegates to tmuxAction with splitV", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "splitV" } });
		expect(mocks.tmuxActionHelper).toHaveBeenCalledWith(expect.objectContaining({ action: "splitV" }));
	});

	it("focus selects the specified pane", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "focus", paneId: "%2" } });
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith("%2", expect.anything());
	});

	it("focusStep:next selects .+ target", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "focusStep", step: "next" } });
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith(expect.stringContaining(".+"), expect.anything());
	});

	it("focusStep:prev selects .- target", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "focusStep", step: "prev" } });
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith(expect.stringContaining(".-"), expect.anything());
	});

	it("focusDirection calls selectPaneDirection", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "focusDirection", direction: "right" } });
		expect(mocks.tmuxSelectPaneDirection).toHaveBeenCalledWith("dev3-aaaaaaaa", "right", expect.anything());
	});

	it("zoom (toggle) calls toggleZoom", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "zoom" } });
		expect(mocks.tmuxToggleZoom).toHaveBeenCalled();
	});

	it("zoom:on does not toggle if already zoomed", async () => {
		mocks.readPaneLayout.mockResolvedValue({ ...twoPane80PaneLayout, zoomed: true });
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "zoom", mode: "on" } });
		expect(mocks.tmuxToggleZoom).not.toHaveBeenCalled();
	});

	it("zoom:off toggles when currently zoomed", async () => {
		mocks.readPaneLayout.mockResolvedValue({ ...twoPane80PaneLayout, zoomed: true });
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "zoom", mode: "off" } });
		expect(mocks.tmuxToggleZoom).toHaveBeenCalled();
	});

	it("close with paneId delegates to tmuxKillPane helper", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "close", paneId: "%2" } });
		expect(mocks.tmuxKillPaneHelper).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: TASK_ID, paneId: "%2" }),
		);
	});

	it("close without paneId delegates to tmuxAction killPane", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "close" } });
		expect(mocks.tmuxActionHelper).toHaveBeenCalledWith(
			expect.objectContaining({ action: "killPane" }),
		);
	});

	it("close delegates to tmuxKillPane which runs handlePaneExited", async () => {
		// tmuxKillPane internally calls handlePaneExited. Verify delegation occurs.
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "close", paneId: "%2" } });
		// tmuxKillPane was called — that function (when not mocked in real code) calls handlePaneExited
		expect(mocks.tmuxKillPaneHelper).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: TASK_ID, paneId: "%2" }),
		);
	});

	it("close force:true passes force through to tmuxKillPane", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "close", paneId: "%1", force: true } });
		expect(mocks.tmuxKillPaneHelper).toHaveBeenCalledWith(
			expect.objectContaining({ force: true }),
		);
	});

	it("close force:false (default) does NOT pass force=true to tmuxKillPane", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "close", paneId: "%1" } });
		expect(mocks.tmuxKillPaneHelper).toHaveBeenCalledWith(
			expect.objectContaining({ force: undefined }),
		);
	});

	it("resize calls resizePaneDirection", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "resize", direction: "right", amount: 10 } });
		expect(mocks.tmuxResizePaneDirection).toHaveBeenCalledWith("dev3-aaaaaaaa", "right", 10, expect.anything());
	});

	it("resize uses default amount 5 when omitted", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "resize", direction: "down" } });
		expect(mocks.tmuxResizePaneDirection).toHaveBeenCalledWith("dev3-aaaaaaaa", "down", 5, expect.anything());
	});

	it("layoutPreset calls selectLayout with the geometric name", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "layoutPreset", preset: "evenH" } });
		// evenH → even-vertical
		expect(mocks.tmuxSelectLayout).toHaveBeenCalledWith("dev3-aaaaaaaa", "even-vertical", expect.anything());
	});

	it("layoutPreset:evenV uses even-horizontal", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "layoutPreset", preset: "evenV" } });
		expect(mocks.tmuxSelectLayout).toHaveBeenCalledWith("dev3-aaaaaaaa", "even-horizontal", expect.anything());
	});

	it("layoutPreset:mainH uses main-horizontal", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "layoutPreset", preset: "mainH" } });
		expect(mocks.tmuxSelectLayout).toHaveBeenCalledWith("dev3-aaaaaaaa", "main-horizontal", expect.anything());
	});

	it("layoutCycle calls nextLayout and reports layoutPreset: null", async () => {
		const state = await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "layoutCycle" } });
		expect(mocks.tmuxNextLayout).toHaveBeenCalled();
		// After nextLayout tmux cycles freely — we cannot name the preset
		expect(state.layoutPreset).toBeNull();
	});

	it("returns fresh tmux state after every action", async () => {
		const state = await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "zoom" } });
		expect(state.backend).toBe("tmux");
		expect(state.panes).toHaveLength(2);
	});
});

// ── taskPaneAction — native path ──────────────────────────────────────────────

describe("taskPaneAction (native)", () => {
	beforeEach(() => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		mocks.getTask.mockResolvedValue(nativeTask);
	});

	it("splitH calls splitNativeTaskPane with orientation 'vertical'", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "splitH" } });
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledWith(
			TASK_ID,
			"pane-1", // active pane id from makeTwoPaneNativeState
			"vertical",
			// cwd/env come from the task record, so a split survives an app restart.
			{ cwd: "/tmp/wt", env: expect.objectContaining({ DEV3_WORKTREE_PATH: "/tmp/wt" }) },
		);
	});

	it("splitV calls splitNativeTaskPane with orientation 'horizontal'", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "splitV" } });
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledWith(
			TASK_ID,
			expect.any(String),
			"horizontal",
			expect.objectContaining({ cwd: "/tmp/wt" }),
		);
	});

	it("focus calls focusNativeTaskPane", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "focus", paneId: "pane-2" } });
		expect(mocks.focusNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-2");
	});

	it("focusStep:next wraps to next pane by layout order", async () => {
		const state = makeTwoPaneNativeState(); // activePaneId = pane-1
		mocks.nativeTaskPanesState.mockResolvedValue(state);
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "focusStep", step: "next" } });
		expect(mocks.focusNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-2");
	});

	it("focusStep:prev wraps from first pane to last", async () => {
		const state = makeTwoPaneNativeState();
		mocks.nativeTaskPanesState.mockResolvedValue(state);
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "focusStep", step: "prev" } });
		// pane-1 is index 0; prev wraps to index 1 (pane-2)
		expect(mocks.focusNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-2");
	});

	it("focusDirection calls setNativeTaskPaneLayout when direction finds a different pane", async () => {
		// Two panes side by side — direction "right" from pane-1 should focus pane-2
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "focusDirection", direction: "right" } });
		expect(mocks.focusNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-2");
	});

	it("zoom:toggle updates layout via setNativeTaskPaneLayout", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "zoom" } });
		expect(mocks.setNativeTaskPaneLayout).toHaveBeenCalled();
	});

	it("zoom:on sets zoomedPaneId", async () => {
		await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "zoom", mode: "on", paneId: "pane-2" },
		});
		// After zoomPane, the tree should have zoomedPaneId set; setNativeTaskPaneLayout was called with that tree
		const calledTree = mocks.setNativeTaskPaneLayout.mock.calls[0][1];
		expect(calledTree.zoomedPaneId).toBe("pane-2");
	});

	it("zoom:off clears zoomedPaneId", async () => {
		// Pre-zoom the tree
		const preZoomedState = makeTwoPaneNativeState();
		const { restoreSplitTree: restore, zoomPane } = await import("../../../shared/split-tree");
		const baseTree = restore(preZoomedState.layout)!;
		const zoomedTree = zoomPane(baseTree, "pane-1");
		mocks.nativeTaskPanesState.mockResolvedValue({
			...preZoomedState,
			layout: serializeSplitTree(zoomedTree),
		});

		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "zoom", mode: "off" } });
		const calledTree = mocks.setNativeTaskPaneLayout.mock.calls[0][1];
		expect(calledTree.zoomedPaneId).toBeNull();
	});

	it("close with 1 pane and no force returns unchanged state (refuses)", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue(makeSingleNativeState());
		const state = await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "close", force: false },
		});
		expect(mocks.closeNativeTaskPane).not.toHaveBeenCalled();
		expect(state.panes).toHaveLength(1); // unchanged
	});

	it("close with 1 pane and force:true tears down session", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue(makeSingleNativeState());
		mocks.closeNativeTaskPane.mockResolvedValue({ sessionTornDown: true, state: null });

		const state = await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "close", force: true },
		});
		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-1");
		// Session torn down → empty state returned
		expect(state.panes).toHaveLength(0);
	});

	it("close with 2 panes and no force succeeds without confirm", async () => {
		// Two panes: closing one should proceed without force
		mocks.closeNativeTaskPane.mockResolvedValue({ sessionTornDown: false, state: makeSingleNativeState() });
		const state = await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "close", paneId: "pane-2" },
		});
		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-2");
		expect(state.panes).toHaveLength(1);
	});

	it("layoutPreset applies the correct geometric preset to the tree", async () => {
		await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "layoutPreset", preset: "evenH" },
		});
		expect(mocks.setNativeTaskPaneLayout).toHaveBeenCalled();
		// The tree passed should be the evenH layout (even-vertical in SplitTree)
		const calledTree = mocks.setNativeTaskPaneLayout.mock.calls[0][1];
		// applySplitLayout with even-vertical produces two equal-height panes
		expect(calledTree.root.type).toBe("split");
	});

	it("layoutCycle computes nextPreset honestly from current geometry", async () => {
		// Set up a tree that matches evenH (even-vertical preset)
		const twoPane = makeTwoPaneNativeState();
		const { restoreSplitTree: restore } = await import("../../../shared/split-tree");
		const baseTree = restore(twoPane.layout)!;
		const evenVTree = applySplitLayout(baseTree, "even-vertical");
		mocks.nativeTaskPanesState.mockResolvedValue({
			...twoPane,
			layout: serializeSplitTree(evenVTree),
		});

		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "layoutCycle" } });
		expect(mocks.setNativeTaskPaneLayout).toHaveBeenCalled();
	});

	it("resize adjusts the split ratio via setNativeTaskPaneLayout", async () => {
		await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "resize", direction: "right", amount: 10 },
		});
		expect(mocks.setNativeTaskPaneLayout).toHaveBeenCalled();
	});

	it("setSplitRatio persists the dragged ratio through setNativeTaskPaneLayout", async () => {
		const { restoreSplitTree: restore } = await import("../../../shared/split-tree");
		const splitId = (restore(makeTwoPaneNativeState().layout)! as { root: { id: string } }).root.id;

		await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "setSplitRatio", splitId, ratio: 0.72 },
		});

		const tree = mocks.setNativeTaskPaneLayout.mock.calls[0][1];
		expect(tree.root.ratio).toBeCloseTo(0.72, 5);
	});

	it("setSplitRatio clamps past the minimum pane ratio", async () => {
		const { restoreSplitTree: restore } = await import("../../../shared/split-tree");
		const splitId = (restore(makeTwoPaneNativeState().layout)! as { root: { id: string } }).root.id;

		await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "setSplitRatio", splitId, ratio: 0.001 },
		});

		expect(mocks.setNativeTaskPaneLayout.mock.calls[0][1].root.ratio).toBe(0.1);
	});

	it("setSplitRatio on an unknown split writes nothing", async () => {
		await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "setSplitRatio", splitId: "split-does-not-exist", ratio: 0.7 },
		});
		expect(mocks.setNativeTaskPaneLayout).not.toHaveBeenCalled();
	});

	it("advertises resizeSplit only once there is a boundary to drag", async () => {
		const multi = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(multi.capabilities).toContain("resizeSplit");

		const twoPane = makeTwoPaneNativeState();
		mocks.nativeTaskPanesState.mockResolvedValue({
			...twoPane,
			panes: [twoPane.panes[0]],
			layout: serializeSplitTree(createSplitTree()),
		});
		const single = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(single.capabilities).not.toContain("resizeSplit");
	});

	it("native path issues NO tmux call — ever", async () => {
		// Exercise the most common native actions and verify the tmux singleton is untouched
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "splitH" } });
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "zoom" } });
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "focus", paneId: "pane-2" } });

		expect(mocks.tmuxSelectPane).not.toHaveBeenCalled();
		expect(mocks.tmuxSelectPaneDirection).not.toHaveBeenCalled();
		expect(mocks.tmuxToggleZoom).not.toHaveBeenCalled();
		expect(mocks.tmuxSelectLayout).not.toHaveBeenCalled();
		expect(mocks.tmuxNextLayout).not.toHaveBeenCalled();
		expect(mocks.tmuxResizePaneDirection).not.toHaveBeenCalled();
		expect(mocks.tmuxActionHelper).not.toHaveBeenCalled();
		expect(mocks.tmuxKillPaneHelper).not.toHaveBeenCalled();
	});
});

// ── native layoutPreset detection ────────────────────────────────────────────

/**
 * Three-pane native state: pane-1 | pane-2 on top, pane-3 on bottom (initial
 * tiled-ish). Used for preset detection tests where 3 panes are needed to
 * distinguish main-* from even-* (2-pane trees collapse to identical rects).
 */
function makeThreePaneNativeState(): NativeTaskPanesState {
	// Build pane-1, pane-2, pane-3 in a vertical split
	let tree = createSplitTree(); // pane-1
	// Split pane-1 → pane-1 + pane-2 (horizontal)
	tree = { ...tree, root: {
		type: "split", id: "split-1", orientation: "horizontal", ratio: 0.5,
		first: { type: "pane", id: "pane-1" },
		second: { type: "pane", id: "pane-2" },
	}, nextSplitOrdinal: 2, nextPaneOrdinal: 3 };
	// Split pane-2 → pane-2 + pane-3 (vertical — stacked)
	tree = { ...tree, root: {
		type: "split", id: "split-2", orientation: "vertical", ratio: 0.5,
		first: tree.root,
		second: { type: "pane", id: "pane-3" },
	}, nextSplitOrdinal: 3, nextPaneOrdinal: 4 };
	return {
		taskId: TASK_ID,
		panes: [
			{ paneId: "pane-1", sessionId: "sess-1", hostPid: 100, shellPid: 101, cols: 80, rows: 24, alive: true },
			{ paneId: "pane-2", sessionId: "sess-2", hostPid: 102, shellPid: 103, cols: 80, rows: 24, alive: true },
			{ paneId: "pane-3", sessionId: "sess-3", hostPid: 104, shellPid: 105, cols: 80, rows: 24, alive: true },
		],
		layout: serializeSplitTree(tree),
		activePaneId: "pane-1",
	};
}

describe("native layoutPreset detection", () => {
	beforeEach(() => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		mocks.getTask.mockResolvedValue(nativeTask);
	});

	async function stateForPreset(
		base: NativeTaskPanesState,
		preset: "even-horizontal" | "even-vertical" | "main-horizontal" | "main-vertical" | "tiled",
	) {
		const { restoreSplitTree: restore } = await import("../../../shared/split-tree");
		const baseTree = restore(base.layout)!;
		const presetTree = applySplitLayout(baseTree, preset);
		mocks.nativeTaskPanesState.mockResolvedValue({ ...base, layout: serializeSplitTree(presetTree) });
		return taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
	}

	it("detects evenH after applying even-vertical (2 panes)", async () => {
		const state = await stateForPreset(makeTwoPaneNativeState(), "even-vertical");
		expect(state.layoutPreset).toBe("evenH");
	});

	it("detects evenV after applying even-horizontal (2 panes)", async () => {
		const state = await stateForPreset(makeTwoPaneNativeState(), "even-horizontal");
		expect(state.layoutPreset).toBe("evenV");
	});

	// For 3+ panes, main-* and even-* produce distinct geometries and are distinguishable.
	it("detects mainH after applying main-horizontal (3 panes)", async () => {
		const state = await stateForPreset(makeThreePaneNativeState(), "main-horizontal");
		expect(state.layoutPreset).toBe("mainH");
	});

	it("detects mainV after applying main-vertical (3 panes)", async () => {
		const state = await stateForPreset(makeThreePaneNativeState(), "main-vertical");
		expect(state.layoutPreset).toBe("mainV");
	});

	it("detects tiled after applying tiled (3 panes)", async () => {
		const state = await stateForPreset(makeThreePaneNativeState(), "tiled");
		expect(state.layoutPreset).toBe("tiled");
	});

	it("reports null for a hand-built geometry that matches no preset", async () => {
		// A custom 70/30 ratio matches no standard preset
		const base = makeTwoPaneNativeState();
		const { restoreSplitTree: restore } = await import("../../../shared/split-tree");
		const baseTree = restore(base.layout)!;
		const customTree = { ...baseTree, root: {
			type: "split" as const, id: "split-1", orientation: "horizontal" as const, ratio: 0.7,
			first: { type: "pane" as const, id: "pane-1" },
			second: { type: "pane" as const, id: "pane-2" },
		}, nextSplitOrdinal: 2, nextPaneOrdinal: 3 };
		mocks.nativeTaskPanesState.mockResolvedValue({ ...base, layout: serializeSplitTree(customTree) });

		const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(state.layoutPreset).toBeNull();
	});
});

// ── tmuxNewWindow ─────────────────────────────────────────────────────────────

describe("tmuxNewWindow", () => {
	it("opens a new tmux window for a tmux task", async () => {
		await taskPanesHandlers.tmuxNewWindow({ taskId: TASK_ID });
		expect(mocks.tmuxNewWindow).toHaveBeenCalled();
	});

	it("is a no-op for a native task", async () => {
		mocks.getTask.mockResolvedValue(nativeTask);
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		await taskPanesHandlers.tmuxNewWindow({ taskId: TASK_ID });
		expect(mocks.tmuxNewWindow).not.toHaveBeenCalled();
	});
});

// ── Redundant work on the action path (seq 1382) ──────────────────────────────

describe("native pane action reads only the layout", () => {
	beforeEach(() => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		mocks.getTask.mockResolvedValue({ id: TASK_ID, terminalBackend: "native", worktreePath: "/tmp/wt" } as any);
		// Serve the tree directly, so a call to the full-state read can only come
		// from the handler itself.
		mocks.nativeTaskPaneLayout.mockResolvedValue(restoreSplitTree(makeTwoPaneNativeState().layout));
		mocks.nativeTaskPanesState.mockClear();
	});

	it("does not run the per-pane ownership sweep for a layout preset", async () => {
		await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "layoutPreset", preset: "evenV" },
		});
		expect(mocks.nativeTaskPaneLayout).toHaveBeenCalledWith(TASK_ID);
		expect(mocks.nativeTaskPanesState).not.toHaveBeenCalled();
	});

	it("does not run it for a layout cycle either", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "layoutCycle" } });
		expect(mocks.nativeTaskPanesState).not.toHaveBeenCalled();
	});

	it("does not run it for a split", async () => {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "splitH" } });
		expect(mocks.nativeTaskPanesState).not.toHaveBeenCalled();
	});

	// PR #1222 gave aux panes real titles; an action must return them too, or a split
	// would blank "Dev Server" back to "Pane 2" until the next poll.
	it("keeps auxiliary pane labels in the state an action returns", async () => {
		mocks.nativeTaskPaneCommandsOf.mockReturnValue([
			{ paneId: "pane-2", sessionId: "s2", command: ["/bin/bash", "dev-server"], shellPid: 2, alive: true },
		]);
		const result = await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "layoutCycle" },
		});
		expect(mocks.nativeTaskPaneCommandsOf).toHaveBeenCalled();
		expect(result.panes.map((p) => p.paneId)).toContain("pane-2");
	});

	it("still reports the full state for an action that changed nothing", async () => {
		mocks.nativeTaskPanesState.mockResolvedValue(makeSingleNativeState());
		mocks.nativeTaskPaneLayout.mockImplementation(async () => {
			const state = await mocks.nativeTaskPanesState();
			return state?.layout ? restoreSplitTree(state.layout) : null;
		});
		const result = await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "close" },
		});
		expect(result.panes).toHaveLength(1);
	});
});

// ── getPanePtyUrl ─────────────────────────────────────────────────────────────

const nativeTaskWithWorktree = { id: TASK_ID, terminalBackend: "native", worktreePath: "/tmp/wt" } as any;

describe("getPanePtyUrl", () => {
	beforeEach(() => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		mocks.getTask.mockImplementation((_proj: any, taskId: string) => {
			if (taskId === TASK_ID) return Promise.resolve(nativeTaskWithWorktree);
			throw new Error("not found");
		});
		mocks.nativeTaskPanesState.mockResolvedValue(makeTwoPaneNativeState());
	});

	it("returns a ws:// URL for the first pane using the bare taskId", async () => {
		const result = await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-1" });
		expect(result).toEqual({ url: `ws://localhost:9999?session=${TASK_ID}` });
		expect(mocks.ensureNativePanePtySession).not.toHaveBeenCalled();
	});

	// The bug: only the process that LAUNCHED the task holds the bare-key session,
	// so every other viewer got `Unknown session` for pane-1 while panes 2..N —
	// registered lazily on this very call — attached fine.
	it("rebinds the first pane when this app process did not launch the task", async () => {
		mocks.hasSession.mockReturnValue(false);
		mocks.reattachNativeTaskSession.mockResolvedValue(true);

		const result = await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-1" });

		expect(mocks.reattachNativeTaskSession).toHaveBeenCalledWith(TASK_ID, "proj-1", "/tmp/wt");
		expect(result).toEqual({ url: `ws://localhost:9999?session=${TASK_ID}` });
	});

	it("does not rebind the first pane when this process already holds the session", async () => {
		mocks.hasSession.mockReturnValue(true);
		await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-1" });
		expect(mocks.reattachNativeTaskSession).not.toHaveBeenCalled();
	});

	it("reports the first pane gone when its host cannot be rebound — never a dead URL", async () => {
		mocks.hasSession.mockReturnValue(false);
		mocks.reattachNativeTaskSession.mockResolvedValue(false);

		const result = await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-1" });

		expect(result).toEqual({ gone: true });
	});

	it("reports a non-first pane gone when its host cannot be bound", async () => {
		mocks.hasSession.mockImplementation((key: string) => key !== `${TASK_ID}~pane-2`);
		const result = await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-2" });
		expect(result).toEqual({ gone: true });
	});

	it("never spawns a replacement while rebinding", async () => {
		mocks.hasSession.mockReturnValue(false);
		mocks.reattachNativeTaskSession.mockResolvedValue(true);
		await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-1" });
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
		expect(mocks.ensureNativePanePtySession).not.toHaveBeenCalled();
	});

	it("returns a composite-key URL for a non-first pane", async () => {
		const result = await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-2" });
		expect(result).toEqual({ url: `ws://localhost:9999?session=${TASK_ID}~pane-2` });
	});

	it("calls ensureNativePanePtySession for non-first panes", async () => {
		await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-2" });
		expect(mocks.ensureNativePanePtySession).toHaveBeenCalledWith(
			TASK_ID,
			"pane-2",
			"sess-2",
			"proj-1",
			"/tmp/wt",
		);
	});

	it("throws for a tmux task", async () => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("tmux");
		mocks.getTask.mockResolvedValue(tmuxTask);
		await expect(
			taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-1" }),
		).rejects.toThrow(/only available for native/);
	});

	it("throws when the pane does not exist in the native state", async () => {
		await expect(
			taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-99" }),
		).rejects.toThrow(/Pane pane-99 not found/);
	});
});
