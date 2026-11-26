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
	installPaneExitedHook: vi.fn(async () => {}),
	getTmuxLayout: vi.fn(),
	getPtyPort: vi.fn(() => 9999),
	ensureNativePanePtySession: vi.fn(),
	hasSession: vi.fn((_key: string) => true),
	reattachNativeTaskSession: vi.fn(async () => true),
	// tmux singleton methods
	tmuxSelectPane: vi.fn(),
	tmuxSelectWindow: vi.fn(),
	tmuxSelectPaneDirection: vi.fn(),
	tmuxToggleZoom: vi.fn(),
	tmuxSwapPaneStep: vi.fn(),
	tmuxSelectLayout: vi.fn(),
	tmuxNextLayout: vi.fn(),
	tmuxResizePaneDirection: vi.fn(),
	tmuxNewWindow: vi.fn(),
	tmuxSplitWindow: vi.fn(),
	tmuxKillPane: vi.fn(),
	tmuxKillWindow: vi.fn(),
	tmuxListPanes: vi.fn(),
	tmuxSetWindowOption: vi.fn(),
	tmuxUnsetWindowOption: vi.fn(),
	// task-terminal-backend
	taskTerminalBackendIdentity: vi.fn(),
	// native-task-panes
	nativeTaskPanesState: vi.fn(),
	nativeTaskPaneCommandsOf: vi.fn<(state: unknown) => Array<{ paneId: string; sessionId: string; command: string[]; shellPid: number; alive: boolean }>>(() => []),
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

vi.mock("../../task-workspace-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-workspace-guard")>()),
	// Fixture worktree paths do not exist on disk; the guard has its own tests.
	assertTaskWorkspacePresent: (_project: unknown, path: string | null | undefined) => path ?? "",
	worktreeAccessState: () => "present",
}));
vi.mock("../../data", () => ({
	loadProjects: mocks.loadProjects,
	loadVirtualProjects: mocks.loadVirtualProjects,
	getTask: mocks.getTask,
}));

vi.mock("../../pty-server", () => ({
	getSessionSocket: mocks.getSessionSocket,
	getSessionTmuxName: mocks.getSessionTmuxName,
	installPaneExitedHook: mocks.installPaneExitedHook,
	getTmuxLayout: mocks.getTmuxLayout,
	getPtyPort: mocks.getPtyPort,
	ensureNativePanePtySession: mocks.ensureNativePanePtySession,
	hasSession: mocks.hasSession,
	reattachNativeTaskSession: mocks.reattachNativeTaskSession,
}));

vi.mock("../../tmux", () => ({
	PANE_CWD_FORMAT: "#{pane_current_path}",
	WINDOW_PANE_FORMAT: { formatString: "window-panes" },
	TMUX_WINDOW_NAME_OPTION: "@dev3_window_name",
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
		selectWindow: mocks.tmuxSelectWindow,
		selectPaneDirection: mocks.tmuxSelectPaneDirection,
		toggleZoom: mocks.tmuxToggleZoom,
		swapPaneStep: mocks.tmuxSwapPaneStep,
		selectLayout: mocks.tmuxSelectLayout,
		nextLayout: mocks.tmuxNextLayout,
		resizePaneDirection: mocks.tmuxResizePaneDirection,
		newWindow: mocks.tmuxNewWindow,
		splitWindow: mocks.tmuxSplitWindow,
		killPane: mocks.tmuxKillPane,
		killWindow: mocks.tmuxKillWindow,
		listPanes: mocks.tmuxListPanes,
		setWindowOption: mocks.tmuxSetWindowOption,
		unsetWindowOption: mocks.tmuxUnsetWindowOption,
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
import { ptyWsUrl } from "../../pty-server-access";

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

/** Three windows: @1 holds the agent pane, @2 is active with two panes, @3 is a shell. */
const threeWindowPanes = [
	{ windowId: "@1", windowActive: false, paneId: "%1", agent: true },
	{ windowId: "@2", windowActive: true, paneId: "%2", agent: false },
	{ windowId: "@2", windowActive: true, paneId: "%5", agent: false },
	{ windowId: "@3", windowActive: false, paneId: "%3", agent: false },
];

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
	mocks.tmuxSwapPaneStep.mockResolvedValue(undefined);
	mocks.tmuxSelectLayout.mockResolvedValue(undefined);
	mocks.tmuxNextLayout.mockResolvedValue(undefined);
	mocks.tmuxResizePaneDirection.mockResolvedValue(undefined);
	mocks.tmuxNewWindow.mockResolvedValue({ paneId: "%8", stderr: "" });
	mocks.tmuxKillWindow.mockResolvedValue(undefined);
	mocks.tmuxListPanes.mockResolvedValue(threeWindowPanes);
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
	it("returns tmux backend state with normalized rects, labels, zoom and capabilities", async () => {
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

		expect(state.zoomedPaneId).toBeNull();
		for (const cap of ["split", "newWindow", "focus", "close"]) expect(state.capabilities).toContain(cap);

		mocks.readPaneLayout.mockResolvedValue({ ...twoPane80PaneLayout, zoomed: true, activeIndex: 1 });
		const zoomed = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(zoomed.zoomedPaneId).toBe("%2");
	});

	it("names the agent's tmux pane: registry wins, oldest without one, null once gone, undefined without a task", async () => {
		// No registry → the oldest pane.
		expect((await taskPanesHandlers.taskPaneState({ taskId: TASK_ID })).agentPaneId).toBe("%1");

		// Registry names the pane wherever a swap moved it.
		mocks.getTask.mockResolvedValue({ ...tmuxTask, sessionState: { panes: [{ paneId: "%2" }] } });
		expect((await taskPanesHandlers.taskPaneState({ taskId: TASK_ID })).agentPaneId).toBe("%2");
		// ...and keeps naming it after a pane action.
		const afterAction = await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "swapStep", step: "next" } });
		expect(afterAction.agentPaneId).toBe("%2");

		// Registry pane in another window.
		mocks.getTask.mockResolvedValue({ ...tmuxTask, sessionState: { panes: [{ paneId: "%7" }] } });
		mocks.getTmuxLayout.mockResolvedValue({
			...twoPane80TmuxLayout,
			windows: [...twoPane80TmuxLayout.windows, { index: 1, name: "agent", active: false, panes: 1, zoomed: false }],
			panes: [...twoPane80TmuxLayout.panes, { windowIndex: 1, paneId: "%7", active: true, left: 0, top: 0, width: 100, height: 40, command: "claude", title: "" }],
		});
		const otherWindow = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(otherWindow.panes.map((pane) => pane.paneId)).toEqual(["%1", "%2"]);
		expect(otherWindow.agentPaneId).toBe("%7");

		// Registry pane gone.
		mocks.getTmuxLayout.mockResolvedValue(twoPane80TmuxLayout);
		mocks.getTask.mockResolvedValue({ ...tmuxTask, sessionState: { panes: [{ paneId: "%9" }] } });
		expect((await taskPanesHandlers.taskPaneState({ taskId: TASK_ID })).agentPaneId).toBeNull();

		// Task missing.
		mocks.getTask.mockRejectedValue(new Error("not found"));
		expect((await taskPanesHandlers.taskPaneState({ taskId: TASK_ID })).agentPaneId).toBeUndefined();
	});

	it("keeps the oldest tmux pane as the agent's with no registry after a swap", async () => {
		const [first, second] = twoPane80TmuxLayout.panes;
		mocks.getTmuxLayout.mockResolvedValue({ ...twoPane80TmuxLayout, panes: [{ ...first!, paneId: "%2" }, { ...second!, paneId: "%1" }] });
		mocks.readPaneLayout.mockResolvedValue({ ...twoPane80PaneLayout, paneIds: ["%2", "%1"] });
		const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(state.panes.map((pane) => pane.paneId)).toEqual(["%2", "%1"]);
		expect(state.agentPaneId).toBe("%1");
	});

	it("returns native backend state with SplitTree rects, capabilities and the agent pane", async () => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		mocks.getTask.mockResolvedValue(nativeTask);

		const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });

		expect(state.backend).toBe("native");
		expect(state.panes).toHaveLength(2);
		// horizontal split ratio 0.5 → left pane x=0 width=0.5, right pane x=0.5 width=0.5
		expect(state.panes[0].rect.x).toBeCloseTo(0);
		expect(state.panes[0].rect.width).toBeCloseTo(0.5);
		expect(state.panes[1].rect.x).toBeCloseTo(0.5);
		expect(state.panes[1].rect.width).toBeCloseTo(0.5);
		expect(state.capabilities).not.toContain("newWindow");
		expect(state.capabilities).toContain("split");
		expect(state.capabilities).toContain("focus");
		expect(state.sessionAbsent).toBeFalsy();
		expect(state.agentPaneId).toBe("pane-1");

		// An exited agent pane is no longer named.
		const twoPane = makeTwoPaneNativeState();
		twoPane.panes[0] = { ...twoPane.panes[0]!, alive: false };
		mocks.nativeTaskPanesState.mockResolvedValue(twoPane);
		expect((await taskPanesHandlers.taskPaneState({ taskId: TASK_ID })).agentPaneId).toBeNull();
	});

	it("marks a vanished native session absent, so empty panes cannot read as loading", async () => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		mocks.getTask.mockResolvedValue(nativeTask);
		mocks.nativeTaskPanesState.mockResolvedValue(null);

		const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });

		expect(state.backend).toBe("native");
		expect(state.panes).toHaveLength(0);
		expect(state.sessionAbsent).toBe(true);
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
	const act = (action: Parameters<typeof taskPanesHandlers.taskPaneAction>[0]["action"]) =>
		taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action });

	it("splitH / splitV delegate to tmuxAction", async () => {
		await act({ kind: "splitH" });
		expect(mocks.tmuxActionHelper).toHaveBeenCalledWith(expect.objectContaining({ action: "splitH" }));
		await act({ kind: "splitV" });
		expect(mocks.tmuxActionHelper).toHaveBeenCalledWith(expect.objectContaining({ action: "splitV" }));
	});

	it("focus, focusStep and focusDirection select the right tmux target", async () => {
		await act({ kind: "focus", paneId: "%2" });
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith("%2", expect.anything());
		await act({ kind: "focusStep", step: "next" });
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith(expect.stringContaining(".+"), expect.anything());
		await act({ kind: "focusStep", step: "prev" });
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith(expect.stringContaining(".-"), expect.anything());
		await act({ kind: "focusDirection", direction: "right" });
		expect(mocks.tmuxSelectPaneDirection).toHaveBeenCalledWith("dev3-aaaaaaaa", "right", expect.anything());
	});

	it("reveal switches to the pane's window, then selects it, which lifts a zoom", async () => {
		await act({ kind: "reveal", paneId: "%1" });
		expect(mocks.tmuxSelectWindow).toHaveBeenCalledWith("%1", { socket: "dev3-sock", bestEffort: true });
		expect(mocks.tmuxSelectPane).toHaveBeenCalledWith("%1", { socket: "dev3-sock", bestEffort: true });
		expect(mocks.tmuxSelectWindow.mock.invocationCallOrder[0]).toBeLessThan(mocks.tmuxSelectPane.mock.invocationCallOrder[0]!);
	});

	it("zoom toggles, and on/off only toggle when the state differs; fresh state comes back", async () => {
		const state = await act({ kind: "zoom" });
		expect(mocks.tmuxToggleZoom).toHaveBeenCalledTimes(1);
		expect(state.backend).toBe("tmux");
		expect(state.panes).toHaveLength(2);

		mocks.readPaneLayout.mockResolvedValue({ ...twoPane80PaneLayout, zoomed: true });
		mocks.tmuxToggleZoom.mockClear();
		await act({ kind: "zoom", mode: "on" });
		expect(mocks.tmuxToggleZoom).not.toHaveBeenCalled();
		await act({ kind: "zoom", mode: "off" });
		expect(mocks.tmuxToggleZoom).toHaveBeenCalledTimes(1);
	});

	it("swapStep hands the window and the step to tmux", async () => {
		await act({ kind: "swapStep", step: "next" });
		expect(mocks.tmuxSwapPaneStep).toHaveBeenCalledWith("dev3-aaaaaaaa", "next", expect.anything());
		await act({ kind: "swapStep", step: "prev" });
		expect(mocks.tmuxSwapPaneStep).toHaveBeenCalledWith("dev3-aaaaaaaa", "prev", expect.anything());
	});

	it("close routes a named pane to tmuxKillPane (passing force) and a bare close to killPane", async () => {
		await act({ kind: "close", paneId: "%2" });
		expect(mocks.tmuxKillPaneHelper).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: TASK_ID, paneId: "%2", force: undefined }));
		await act({ kind: "close", paneId: "%1", force: true });
		expect(mocks.tmuxKillPaneHelper).toHaveBeenLastCalledWith(expect.objectContaining({ paneId: "%1", force: true }));
		await act({ kind: "close" });
		expect(mocks.tmuxActionHelper).toHaveBeenCalledWith(expect.objectContaining({ action: "killPane" }));
	});

	it("resize calls resizePaneDirection, defaulting the amount to 5", async () => {
		await act({ kind: "resize", direction: "right", amount: 10 });
		expect(mocks.tmuxResizePaneDirection).toHaveBeenCalledWith("dev3-aaaaaaaa", "right", 10, expect.anything());
		await act({ kind: "resize", direction: "down" });
		expect(mocks.tmuxResizePaneDirection).toHaveBeenCalledWith("dev3-aaaaaaaa", "down", 5, expect.anything());
	});

	it("layoutPreset maps to the geometric tmux name; layoutCycle reports layoutPreset: null", async () => {
		for (const [preset, tmuxName] of [["evenH", "even-vertical"], ["evenV", "even-horizontal"], ["mainH", "main-horizontal"]] as const) {
			await act({ kind: "layoutPreset", preset });
			expect(mocks.tmuxSelectLayout, preset).toHaveBeenLastCalledWith("dev3-aaaaaaaa", tmuxName, expect.anything());
		}
		const state = await act({ kind: "layoutCycle" });
		expect(mocks.tmuxNextLayout).toHaveBeenCalled();
		// After nextLayout tmux cycles freely — we cannot name the preset
		expect(state.layoutPreset).toBeNull();
	});
});

// ── taskPaneAction — native path ──────────────────────────────────────────────

describe("taskPaneAction (native)", () => {
	beforeEach(() => {
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		mocks.getTask.mockResolvedValue(nativeTask);
	});

	const act = (action: Parameters<typeof taskPanesHandlers.taskPaneAction>[0]["action"]) =>
		taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action });

	it("splitH / splitV call splitNativeTaskPane with the task's cwd/env", async () => {
		await act({ kind: "splitH" });
		expect(mocks.splitNativeTaskPane).toHaveBeenCalledWith(
			TASK_ID,
			"pane-1", // active pane id from makeTwoPaneNativeState
			"vertical",
			// cwd/env come from the task record, so a split survives an app restart.
			{ cwd: "/tmp/wt", env: expect.objectContaining({ DEV3_WORKTREE_PATH: "/tmp/wt" }) },
		);
		await act({ kind: "splitV" });
		expect(mocks.splitNativeTaskPane).toHaveBeenLastCalledWith(TASK_ID, expect.any(String), "horizontal", expect.objectContaining({ cwd: "/tmp/wt" }));
	});

	it("focus, focusStep (wrapping both ways) and focusDirection focus the right pane", async () => {
		await act({ kind: "focus", paneId: "pane-2" });
		expect(mocks.focusNativeTaskPane).toHaveBeenLastCalledWith(TASK_ID, "pane-2");
		// pane-1 is active at index 0: next → pane-2, prev wraps to pane-2.
		for (const step of ["next", "prev"] as const) {
			mocks.focusNativeTaskPane.mockClear();
			await act({ kind: "focusStep", step });
			expect(mocks.focusNativeTaskPane, step).toHaveBeenCalledWith(TASK_ID, "pane-2");
		}
		mocks.focusNativeTaskPane.mockClear();
		await act({ kind: "focusDirection", direction: "right" });
		expect(mocks.focusNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-2");
	});

	it("reveal lifts a zoom on another pane, and leaves the layout alone when nothing hides it", async () => {
		await act({ kind: "reveal", paneId: "pane-1" });
		expect(mocks.setNativeTaskPaneLayout).not.toHaveBeenCalled();
		expect(mocks.focusNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-1");

		const zoomed = makeTwoPaneNativeState();
		zoomed.layout = serializeSplitTree({ ...restoreSplitTree(zoomed.layout!)!, zoomedPaneId: "pane-2", activePaneId: "pane-2" });
		mocks.nativeTaskPanesState.mockResolvedValue(zoomed);
		await act({ kind: "reveal", paneId: "pane-1" });
		expect(mocks.setNativeTaskPaneLayout.mock.calls[0][1].zoomedPaneId).toBeNull();
		expect(mocks.focusNativeTaskPane).toHaveBeenLastCalledWith(TASK_ID, "pane-1");
	});

	it("zoom toggle/on/off write the zoomed pane through setNativeTaskPaneLayout", async () => {
		await act({ kind: "zoom" });
		expect(mocks.setNativeTaskPaneLayout).toHaveBeenCalledTimes(1);

		mocks.setNativeTaskPaneLayout.mockClear();
		await act({ kind: "zoom", mode: "on", paneId: "pane-2" });
		expect(mocks.setNativeTaskPaneLayout.mock.calls[0][1].zoomedPaneId).toBe("pane-2");

		const preZoomedState = makeTwoPaneNativeState();
		const { zoomPane } = await import("../../../shared/split-tree");
		mocks.nativeTaskPanesState.mockResolvedValue({
			...preZoomedState,
			layout: serializeSplitTree(zoomPane(restoreSplitTree(preZoomedState.layout)!, "pane-1")),
		});
		mocks.setNativeTaskPaneLayout.mockClear();
		await act({ kind: "zoom", mode: "off" });
		expect(mocks.setNativeTaskPaneLayout.mock.calls[0][1].zoomedPaneId).toBeNull();
	});

	it("swapStep trades the active pane with its neighbour and wraps; a single pane changes nothing", async () => {
		await act({ kind: "swapStep", step: "next" });
		const tree = mocks.setNativeTaskPaneLayout.mock.calls[0][1];
		// pane-1 was left of pane-2; after the swap it is on the right.
		expect(tree.root.first.id).toBe("pane-2");
		expect(tree.root.second.id).toBe("pane-1");
		// Splits and ratios are untouched — a swap must not reshape the layout.
		expect(tree.root.id).toBe("split-1");
		expect(tree.root.ratio).toBe(0.5);
		// Active pane is an identity, not a position: still pane-1, now on the right.
		expect(tree.activePaneId).toBe("pane-1");

		// prev wraps to the same partner in a two-pane tree.
		mocks.setNativeTaskPaneLayout.mockClear();
		await act({ kind: "swapStep", step: "prev" });
		expect(mocks.setNativeTaskPaneLayout.mock.calls[0][1].root.first.id).toBe("pane-2");

		mocks.setNativeTaskPaneLayout.mockClear();
		mocks.nativeTaskPanesState.mockResolvedValue(makeSingleNativeState());
		await act({ kind: "swapStep", step: "next" });
		expect(mocks.setNativeTaskPaneLayout).not.toHaveBeenCalled();
	});

	it("close: two panes close freely; the last pane is refused without force and torn down with it", async () => {
		mocks.closeNativeTaskPane.mockResolvedValue({ sessionTornDown: false, state: makeSingleNativeState() });
		const two = await act({ kind: "close", paneId: "pane-2" });
		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-2");
		expect(two.panes).toHaveLength(1);

		mocks.closeNativeTaskPane.mockClear();
		mocks.nativeTaskPanesState.mockResolvedValue(makeSingleNativeState());
		const refused = await act({ kind: "close", force: false });
		expect(mocks.closeNativeTaskPane).not.toHaveBeenCalled();
		expect(refused.panes).toHaveLength(1); // unchanged

		mocks.closeNativeTaskPane.mockResolvedValue({ sessionTornDown: true, state: null });
		const forced = await act({ kind: "close", force: true });
		expect(mocks.closeNativeTaskPane).toHaveBeenCalledWith(TASK_ID, "pane-1");
		expect(forced.panes).toHaveLength(0);
	});

	it("layoutPreset, layoutCycle and resize each write a new tree", async () => {
		await act({ kind: "layoutPreset", preset: "evenH" });
		expect(mocks.setNativeTaskPaneLayout.mock.calls[0][1].root.type).toBe("split");

		const twoPane = makeTwoPaneNativeState();
		mocks.nativeTaskPanesState.mockResolvedValue({
			...twoPane,
			layout: serializeSplitTree(applySplitLayout(restoreSplitTree(twoPane.layout)!, "even-vertical")),
		});
		mocks.setNativeTaskPaneLayout.mockClear();
		await act({ kind: "layoutCycle" });
		expect(mocks.setNativeTaskPaneLayout).toHaveBeenCalled();

		mocks.setNativeTaskPaneLayout.mockClear();
		mocks.nativeTaskPanesState.mockResolvedValue(makeTwoPaneNativeState());
		await act({ kind: "resize", direction: "right", amount: 10 });
		expect(mocks.setNativeTaskPaneLayout).toHaveBeenCalled();
	});

	it("setSplitRatio persists the dragged ratio, clamps it, and ignores an unknown split", async () => {
		const splitId = (restoreSplitTree(makeTwoPaneNativeState().layout)! as { root: { id: string } }).root.id;

		await act({ kind: "setSplitRatio", splitId, ratio: 0.72 });
		expect(mocks.setNativeTaskPaneLayout.mock.calls[0][1].root.ratio).toBeCloseTo(0.72, 5);

		await act({ kind: "setSplitRatio", splitId, ratio: 0.001 });
		expect(mocks.setNativeTaskPaneLayout.mock.calls[1][1].root.ratio).toBe(0.1);

		mocks.setNativeTaskPaneLayout.mockClear();
		await act({ kind: "setSplitRatio", splitId: "split-does-not-exist", ratio: 0.7 });
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
		await act({ kind: "splitH" });
		await act({ kind: "zoom" });
		await act({ kind: "focus", paneId: "pane-2" });

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

	it("detects each preset after applying it (main-* needs 3 panes to differ from even-*)", async () => {
		const cases = [
			[makeTwoPaneNativeState, "even-vertical", "evenH"],
			[makeTwoPaneNativeState, "even-horizontal", "evenV"],
			[makeThreePaneNativeState, "main-horizontal", "mainH"],
			[makeThreePaneNativeState, "main-vertical", "mainV"],
			[makeThreePaneNativeState, "tiled", "tiled"],
		] as const;
		for (const [make, preset, expected] of cases) {
			const base = make();
			const presetTree = applySplitLayout(restoreSplitTree(base.layout)!, preset);
			mocks.nativeTaskPanesState.mockResolvedValue({ ...base, layout: serializeSplitTree(presetTree) });
			const state = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
			expect(state.layoutPreset, preset).toBe(expected);
		}
	});

	it("reports null for a hand-built geometry that matches no preset", async () => {
		// A custom 70/30 ratio matches no standard preset
		const base = makeTwoPaneNativeState();
		const baseTree = restoreSplitTree(base.layout)!;
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

// ── tmux windows ──────────────────────────────────────────────────────────────

describe("tmux window handlers on a native task", () => {
	it("tmuxNewWindow / tmuxCloseWindow / tmuxRenameWindow are no-ops", async () => {
		mocks.getTask.mockResolvedValue(nativeTask);
		mocks.taskTerminalBackendIdentity.mockReturnValue("native");
		await taskPanesHandlers.tmuxNewWindow({ taskId: TASK_ID });
		expect(mocks.tmuxNewWindow).not.toHaveBeenCalled();
		expect(await taskPanesHandlers.tmuxCloseWindow({ taskId: TASK_ID })).toEqual({ closed: false, reason: "notFound" });
		expect(await taskPanesHandlers.tmuxRenameWindow({ taskId: TASK_ID, windowId: "@1", name: "x" })).toEqual({ renamed: false });
		expect(mocks.tmuxListPanes).not.toHaveBeenCalled();
	});
});

describe("tmuxNewWindow", () => {
	it("opens a new tmux window for a tmux task", async () => {
		await taskPanesHandlers.tmuxNewWindow({ taskId: TASK_ID });
		expect(mocks.tmuxNewWindow).toHaveBeenCalled();
	});

	it("asks for the new pane id and gives its window the pane-exited hook", async () => {
		await taskPanesHandlers.tmuxNewWindow({ taskId: TASK_ID });
		expect(mocks.tmuxNewWindow).toHaveBeenCalledWith(expect.objectContaining({ focus: true, printPaneId: true }));
		expect(mocks.installPaneExitedHook).toHaveBeenCalledWith("dev3-aaaaaaaa", "%8", expect.any(String));
	});
});

describe("tmuxCloseWindow", () => {
	it("closes the active window when none is named, or a named one by id", async () => {
		expect(await taskPanesHandlers.tmuxCloseWindow({ taskId: TASK_ID })).toEqual({ closed: true });
		expect(mocks.tmuxKillWindow).toHaveBeenCalledWith("@2", { socket: "dev3-sock" });
		expect(mocks.handlePaneExited).toHaveBeenCalled();

		expect(await taskPanesHandlers.tmuxCloseWindow({ taskId: TASK_ID, windowId: "@3" })).toEqual({ closed: true });
		expect(mocks.tmuxKillWindow).toHaveBeenLastCalledWith("@3", { socket: "dev3-sock" });
	});

	it("refuses the agent's window without force (naming it for the retry) and closes it once forced", async () => {
		expect(await taskPanesHandlers.tmuxCloseWindow({ taskId: TASK_ID, windowId: "@1" })).toEqual({ closed: false, reason: "agentWindow", windowId: "@1" });
		expect(mocks.tmuxKillWindow).not.toHaveBeenCalled();

		expect(await taskPanesHandlers.tmuxCloseWindow({ taskId: TASK_ID, windowId: "@1", force: true })).toEqual({ closed: true });
		expect(mocks.tmuxKillWindow).toHaveBeenCalledWith("@1", { socket: "dev3-sock" });
	});

	it("kills nothing for a malformed id, a window already gone, or the last window even forced", async () => {
		expect(await taskPanesHandlers.tmuxCloseWindow({ taskId: TASK_ID, windowId: "dev3-x:1" })).toEqual({ closed: false, reason: "notFound" });
		expect(await taskPanesHandlers.tmuxCloseWindow({ taskId: TASK_ID, windowId: "@9" })).toEqual({ closed: false, reason: "notFound" });
		mocks.tmuxListPanes.mockResolvedValue([{ windowId: "@1", windowActive: true, paneId: "%1", agent: false }]);
		expect(await taskPanesHandlers.tmuxCloseWindow({ taskId: TASK_ID, force: true })).toEqual({ closed: false, reason: "lastWindow" });
		expect(mocks.tmuxKillWindow).not.toHaveBeenCalled();
	});
});

describe("tmuxRenameWindow", () => {
	beforeEach(() => {
		mocks.tmuxSetWindowOption.mockReset().mockResolvedValue(undefined);
		mocks.tmuxUnsetWindowOption.mockReset().mockResolvedValue(undefined);
	});

	it("stores a cleaned-up name; an empty name hands the window back to automatic naming", async () => {
		expect(await taskPanesHandlers.tmuxRenameWindow({ taskId: TASK_ID, windowId: "@3", name: "  Dev\tserver\n " })).toEqual({ renamed: true });
		expect(mocks.tmuxSetWindowOption).toHaveBeenCalledWith("@3", "@dev3_window_name", "Dev server", { socket: "dev3-sock" });

		mocks.tmuxSetWindowOption.mockClear();
		expect(await taskPanesHandlers.tmuxRenameWindow({ taskId: TASK_ID, windowId: "@3", name: "   " })).toEqual({ renamed: true });
		expect(mocks.tmuxUnsetWindowOption).toHaveBeenCalledWith("@3", "@dev3_window_name", { socket: "dev3-sock" });
		expect(mocks.tmuxSetWindowOption).not.toHaveBeenCalled();
	});

	it("never touches a window outside the task's session or a malformed id", async () => {
		expect(await taskPanesHandlers.tmuxRenameWindow({ taskId: TASK_ID, windowId: "@9", name: "x" })).toEqual({ renamed: false });
		expect(await taskPanesHandlers.tmuxRenameWindow({ taskId: TASK_ID, windowId: "dev3-x:1", name: "x" })).toEqual({ renamed: false });
		expect(mocks.tmuxSetWindowOption).not.toHaveBeenCalled();
	});
});

describe("taskPaneState closeWindow capability", () => {
	it("is offered only while the session has more than one window", async () => {
		const one = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(one.capabilities).not.toContain("closeWindow");

		mocks.getTmuxLayout.mockResolvedValue({
			...twoPane80TmuxLayout,
			windows: [...twoPane80TmuxLayout.windows, { index: 1, name: "zsh", active: false, panes: 1, zoomed: false }],
		});
		const two = await taskPanesHandlers.taskPaneState({ taskId: TASK_ID });
		expect(two.capabilities).toContain("closeWindow");
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

	it("does not run the per-pane ownership sweep for a layout preset, a layout cycle or a split", async () => {
		const actions = [{ kind: "layoutPreset", preset: "evenV" }, { kind: "layoutCycle" }, { kind: "splitH" }] as const;
		for (const action of actions) {
			await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action });
			expect(mocks.nativeTaskPanesState, action.kind).not.toHaveBeenCalled();
		}
		expect(mocks.nativeTaskPaneLayout).toHaveBeenCalledWith(TASK_ID);
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

	it("returns a bare-taskId ws:// URL for the first pane, without rebinding a session this process holds", async () => {
		const result = await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-1" });
		expect(result).toEqual({ url: ptyWsUrl(9999, TASK_ID) });
		expect(mocks.ensureNativePanePtySession).not.toHaveBeenCalled();
		expect(mocks.reattachNativeTaskSession).not.toHaveBeenCalled();
	});

	// The bug: only the process that LAUNCHED the task holds the bare-key session,
	// so every other viewer got `Unknown session` for pane-1 while panes 2..N —
	// registered lazily on this very call — attached fine.
	it("rebinds the first pane when this app process did not launch the task, never spawning a replacement", async () => {
		mocks.hasSession.mockReturnValue(false);
		mocks.reattachNativeTaskSession.mockResolvedValue(true);

		const result = await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-1" });

		expect(mocks.reattachNativeTaskSession).toHaveBeenCalledWith(TASK_ID, "proj-1", "/tmp/wt");
		expect(result).toEqual({ url: ptyWsUrl(9999, TASK_ID) });
		expect(mocks.splitNativeTaskPane).not.toHaveBeenCalled();
		expect(mocks.ensureNativePanePtySession).not.toHaveBeenCalled();
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

	it("returns a composite-key URL for a non-first pane after ensuring its session", async () => {
		const result = await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-2" });
		expect(result).toEqual({ url: ptyWsUrl(9999, `${TASK_ID}~pane-2`) });
		expect(mocks.ensureNativePanePtySession).toHaveBeenCalledWith(TASK_ID, "pane-2", "sess-2", "proj-1", "/tmp/wt");
	});

	it("throws for a tmux task and for a pane missing from the native state", async () => {
		await expect(
			taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-99" }),
		).rejects.toThrow(/Pane pane-99 not found/);

		mocks.taskTerminalBackendIdentity.mockReturnValue("tmux");
		mocks.getTask.mockResolvedValue(tmuxTask);
		await expect(
			taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: "pane-1" }),
		).rejects.toThrow(/only available for native/);
	});
});
