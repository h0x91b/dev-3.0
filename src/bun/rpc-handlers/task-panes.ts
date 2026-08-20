/**
 * Backend-neutral pane RPC handlers (seq 1311, PR2 + PR3).
 *
 * `taskPaneState`  — read current pane geometry for any backend.
 * `taskPaneAction` — execute a split/focus/zoom/close/layout/resize action.
 * `tmuxNewWindow`  — tmux-only: open a new window in the task session.
 * `getPanePtyUrl`  — native-only: return the WS URL for one native pane's viewer.
 *
 * All tmux internals are delegated to the exported helpers from tmux-pty.ts.
 * All native internals go through native-task-panes.ts.
 */
import * as pty from "../pty-server";
import * as data from "../data";
import {
	tmux,
	PANE_CWD_FORMAT,
	TmuxError,
} from "../tmux";
import { taskTerminalBackendIdentity } from "../task-terminal-backend";
import { buildTaskLifecycleEnv } from "./shared-pure";
import { auxPaneTitle, auxPurposeOfCommand } from "../task-aux-panes";
import {
	nativeTaskPaneCommandsOf,
	nativeTaskPaneLayout,
	nativeTaskPanesState,
	splitNativeTaskPane,
	closeNativeTaskPane,
	focusNativeTaskPane,
	setNativeTaskPaneLayout,
	type NativeTaskPanesState,
} from "../native-task-panes";
import {
	readPaneLayout,
	tmuxAction,
	tmuxKillPane,
} from "./tmux-pty";
import {
	paneActionToSplitOrientation,
	paneLayoutPresetToSplitPreset,
	splitPresetToPaneLayoutPreset,
} from "../../shared/pane-action-mapping";
import {
	focusPane,
	getPaneRects,
	listPaneIds,
	restoreSplitTree,
	resizeSplit,
	setSplitRatio,
	toggleZoom,
	unzoomPane,
	zoomPane,
	type SplitBranchNode,
	type SplitNode,
	type SplitOrientation,
	type SplitPaneRect,
	type SplitTree,
} from "../../shared/split-tree";
import { applySplitLayout, SPLIT_LAYOUT_PRESETS } from "../../shared/split-tree-layouts";
import {
	nextTaskPaneLayoutPreset,
	type TaskPaneAction,
	type TaskPaneCapability,
	type TaskPaneInfo,
	type TaskPaneLayoutPreset,
	type TaskPaneState,
} from "../../shared/task-panes";
import { paneSessionKey } from "../../shared/pane-session-key";
import { createLogger } from "../logger";

const log = createLogger("task-panes");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Find a task by ID across all projects (git AND virtual/Operations boards). */
async function findTaskAcrossProjects(taskId: string): Promise<{ task: import("../../shared/types").Task | null; project: import("../../shared/types").Project | null }> {
	try {
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			try {
				const task = await data.getTask(project, taskId);
				return { task, project };
			} catch {
				// task not in this project
			}
		}
	} catch (err) {
		log.error("Failed to load projects during task search", { taskId: taskId.slice(0, 8), error: String(err) });
	}
	return { task: null, project: null };
}

/** Build TaskPaneState from the live tmux layout for a task session. */
async function tmuxTaskPaneState(taskId: string): Promise<TaskPaneState> {
	const socket = pty.getSessionSocket(taskId);
	const tmuxSession = pty.getSessionTmuxName(taskId);

	const [paneLayout, tmuxLayout] = await Promise.all([
		readPaneLayout(socket, tmuxSession),
		pty.getTmuxLayout(taskId, socket),
	]);

	const activeWindow = tmuxLayout.windows.find((w) => w.active) ?? tmuxLayout.windows[0];
	const winPanes = activeWindow
		? tmuxLayout.panes.filter((p) => p.windowIndex === activeWindow.index)
		: [];

	const winW = winPanes.length > 0 ? Math.max(1, ...winPanes.map((p) => p.left + p.width)) : 1;
	const winH = winPanes.length > 0 ? Math.max(1, ...winPanes.map((p) => p.top + p.height)) : 1;

	const panes: TaskPaneInfo[] = paneLayout.paneIds.map((paneId, i) => {
		const geom = winPanes.find((p) => p.paneId === paneId);
		return {
			paneId,
			index: i,
			label: paneLayout.labels[i] ?? "",
			active: i === paneLayout.activeIndex,
			zoomed: paneLayout.zoomed && i === paneLayout.activeIndex,
			rect: geom
				? {
					x: geom.left / winW,
					y: geom.top / winH,
					width: geom.width / winW,
					height: geom.height / winH,
				}
				: { x: 0, y: 0, width: 1, height: 1 },
		};
	});

	const count = panes.length;
	const capabilities: TaskPaneCapability[] = [
		"split",
		"zoom",
		"newWindow",
	];
	if (count > 1) {
		capabilities.push("focus", "focusDirection", "close", "closePick", "layoutPreset", "layoutCycle");
	} else if (count === 1) {
		capabilities.push("close");
	}

	return {
		backend: "tmux",
		panes,
		activePaneId: panes[paneLayout.activeIndex]?.paneId ?? null,
		zoomedPaneId: paneLayout.zoomed ? (panes[paneLayout.activeIndex]?.paneId ?? null) : null,
		layout: null,
		layoutPreset: null,
		capabilities,
	};
}

const RECT_EPS = 0.001;

function rectsMatch(
	a: Map<string, SplitPaneRect>,
	b: Map<string, SplitPaneRect>,
	ids: string[],
): boolean {
	for (const id of ids) {
		const ra = a.get(id);
		const rb = b.get(id);
		if (!ra || !rb) return false;
		if (
			Math.abs(ra.x - rb.x) > RECT_EPS ||
			Math.abs(ra.y - rb.y) > RECT_EPS ||
			Math.abs(ra.width - rb.width) > RECT_EPS ||
			Math.abs(ra.height - rb.height) > RECT_EPS
		) return false;
	}
	return true;
}

function detectLayoutPreset(tree: SplitTree): TaskPaneLayoutPreset | null {
	const ids = listPaneIds(tree);
	if (ids.length < 2) return null;
	const currentRects = getPaneRects(tree);
	for (const preset of SPLIT_LAYOUT_PRESETS) {
		const testTree = applySplitLayout(tree, preset);
		const testRects = getPaneRects(testTree);
		if (rectsMatch(currentRects, testRects, ids)) {
			return splitPresetToPaneLayoutPreset(preset);
		}
	}
	return null;
}

/**
 * Titles for the native panes an action owns, so the pane pager and the
 * close-pane picker can name "Dev Server" instead of "Pane 2". Derived from each
 * pane's launch command — nothing is stored, so a label survives an app restart
 * exactly as long as the pane itself does.
 */
function nativeAuxPaneLabels(taskId: string, state: NativeTaskPanesState): Map<string, string> {
	const labels = new Map<string, string>();
	for (const pane of nativeTaskPaneCommandsOf(state)) {
		const purpose = auxPurposeOfCommand(taskId, pane.command);
		if (purpose) labels.set(pane.paneId, auxPaneTitle(purpose));
	}
	return labels;
}

/** Build TaskPaneState from a NativeTaskPanesState. */
function nativeStateToTaskPaneState(
	nativeState: import("../native-task-panes").NativeTaskPanesState,
	tree: SplitTree | null,
	labels?: Map<string, string>,
): TaskPaneState {
	const rects = tree ? getPaneRects(tree) : new Map<string, SplitPaneRect>();
	const zoomedPaneId = tree?.zoomedPaneId ?? null;
	const activePaneId = nativeState.activePaneId || null;
	const layoutPreset = tree ? detectLayoutPreset(tree) : null;

	const panes: TaskPaneInfo[] = nativeState.panes.map((p, i) => ({
		paneId: p.paneId,
		index: i,
		label: labels?.get(p.paneId) ?? "",
		active: p.paneId === activePaneId,
		zoomed: p.paneId === zoomedPaneId,
		rect: rects.get(p.paneId) ?? { x: 0, y: 0, width: 1, height: 1 },
		sessionKey: p.sessionId,
		hostPid: p.hostPid,
		shellPid: p.shellPid,
		alive: p.alive,
	}));

	const count = panes.length;
	const capabilities: TaskPaneCapability[] = ["split", "zoom", "resize"];
	if (count > 1) {
		capabilities.push("focus", "focusDirection", "close", "closePick", "layoutPreset", "layoutCycle", "resizeSplit");
	} else if (count === 1) {
		capabilities.push("close");
	}

	return {
		backend: "native",
		panes,
		activePaneId,
		zoomedPaneId,
		layout: nativeState.layout,
		layoutPreset,
		capabilities,
	};
}

/** Walk the tree to find the closest ancestor split of the given orientation containing paneId. */
function findSplitForResize(root: SplitNode, paneId: string, orientation: SplitOrientation): string | null {
	function walk(node: SplitNode): { found: boolean; splitId: string | null } {
		if (node.type === "pane") return { found: node.id === paneId, splitId: null };
		const first = walk(node.first);
		const second = walk(node.second);
		if (!first.found && !second.found) return { found: false, splitId: null };
		if (first.found && first.splitId) return { found: true, splitId: first.splitId };
		if (second.found && second.splitId) return { found: true, splitId: second.splitId };
		if ((node as SplitBranchNode).orientation === orientation) return { found: true, splitId: node.id };
		return { found: true, splitId: null };
	}
	return walk(root).splitId;
}

// ── Handler: taskPaneState ────────────────────────────────────────────────────

async function taskPaneState(params: { taskId: string }): Promise<TaskPaneState> {
	const { task } = await findTaskAcrossProjects(params.taskId);
	if (!task) {
		// Fallback: assume tmux (legacy task not found)
		return tmuxTaskPaneState(params.taskId);
	}

	const identity = taskTerminalBackendIdentity(task);

	if (identity === "native") {
		const nativeState = await nativeTaskPanesState(params.taskId);
		if (!nativeState) {
			return {
				backend: "native",
				panes: [],
				activePaneId: null,
				zoomedPaneId: null,
				layout: null,
				layoutPreset: null,
				capabilities: ["split"],
				sessionAbsent: true,
			};
		}
		const tree = nativeState.layout ? restoreSplitTree(nativeState.layout) : null;
		return nativeStateToTaskPaneState(nativeState, tree, nativeAuxPaneLabels(params.taskId, nativeState));
	}

	return tmuxTaskPaneState(params.taskId);
}

// ── Handler: taskPaneAction ───────────────────────────────────────────────────

async function taskPaneAction(params: { taskId: string; action: TaskPaneAction }): Promise<TaskPaneState> {
	const { action, taskId } = params;

	const { task } = await findTaskAcrossProjects(taskId);
	if (!task) throw new Error(`Task ${taskId.slice(0, 8)} not found`);

	const identity = taskTerminalBackendIdentity(task);

	if (identity === "native") {
		return nativePaneAction(taskId, action);
	}
	return tmuxPaneAction(taskId, action);
}

// ── tmux pane action dispatch ─────────────────────────────────────────────────

async function tmuxPaneAction(taskId: string, action: TaskPaneAction): Promise<TaskPaneState> {
	const socket = pty.getSessionSocket(taskId);
	const tmuxSession = pty.getSessionTmuxName(taskId);

	switch (action.kind) {
		case "splitH":
		case "splitV": {
			await tmuxAction({ taskId, action: action.kind });
			break;
		}
		case "focus": {
			try {
				await tmux.selectPane(action.paneId, { socket });
			} catch (err) {
				if (!(err instanceof TmuxError)) throw err;
			}
			break;
		}
		case "focusStep": {
			const target = action.step === "next"
				? `${tmuxSession}:.+`
				: `${tmuxSession}:.-`;
			await tmux.selectPane(target, { socket, bestEffort: true });
			break;
		}
		case "focusDirection": {
			await tmux.selectPaneDirection(tmuxSession, action.direction, { socket, bestEffort: true });
			break;
		}
		case "zoom": {
			if (!action.mode || action.mode === "toggle") {
				await tmux.toggleZoom(tmuxSession, { socket });
			} else {
				// on/off: read current zoom, toggle only on mismatch
				const paneLayout = await readPaneLayout(socket, tmuxSession);
				const wantZoomed = action.mode === "on";
				if (paneLayout.zoomed !== wantZoomed) {
					await tmux.toggleZoom(tmuxSession, { socket });
				}
			}
			break;
		}
		case "close": {
			if (action.paneId) {
				await tmuxKillPane({ taskId, paneId: action.paneId, force: action.force });
			} else {
				await tmuxAction({ taskId, action: "killPane", force: action.force });
			}
			break;
		}
		case "resize": {
			await tmux.resizePaneDirection(tmuxSession, action.direction, action.amount ?? 5, { socket });
			break;
		}
		case "layoutPreset": {
			const layout = paneLayoutPresetToSplitPreset(action.preset);
			// paneLayoutPresetToSplitPreset returns the SplitTree name which is also the tmux name
			await tmux.selectLayout(tmuxSession, layout, { socket });
			break;
		}
		case "layoutCycle": {
			await tmux.nextLayout(tmuxSession, { socket });
			break;
		}
	}

	return tmuxTaskPaneState(taskId);
}

// ── native pane action dispatch ───────────────────────────────────────────────

/**
 * Where a new native pane's shell starts. Resolved from the task on every split
 * so it survives an app restart, unlike anything cached in this process.
 */
async function splitContext(taskId: string): Promise<{ cwd: string; env: Record<string, string> }> {
	const { task, project } = await findTaskAcrossProjects(taskId);
	const cwd = task?.worktreePath;
	if (!task || !project || !cwd) {
		throw new Error(`Cannot split: no worktree on record for task ${taskId.slice(0, 8)}`);
	}
	return { cwd, env: buildTaskLifecycleEnv(project, task, cwd) };
}

async function nativePaneAction(taskId: string, action: TaskPaneAction): Promise<TaskPaneState> {
	// Every action decides from the tree, so read the layout only: the per-pane
	// ownership sweep the full state carries would be a second `ps` pass per pane
	// that nothing here reads (seq 1382).
	const tree = await nativeTaskPaneLayout(taskId);
	if (!tree) throw new Error(`No native pane set for task ${taskId.slice(0, 8)}`);
	const activePaneId = tree.activePaneId ?? "";
	let updatedState: NativeTaskPanesState | null = null;

	switch (action.kind) {
		case "splitH":
		case "splitV": {
			const orientation = paneActionToSplitOrientation(action.kind);
			const fromPaneId = action.paneId ?? activePaneId;
			if (!fromPaneId) throw new Error("No active pane to split from");
			const { state } = await splitNativeTaskPane(taskId, fromPaneId, orientation, await splitContext(taskId));
			updatedState = state;
			break;
		}
		case "focus": {
			updatedState = await focusNativeTaskPane(taskId, action.paneId);
			break;
		}
		case "focusStep": {
			const ids = listPaneIds(tree);
			if (ids.length < 2) break;
			const activeIdx = ids.indexOf(activePaneId);
			let nextIdx: number;
			if (action.step === "next") {
				nextIdx = (activeIdx + 1) % ids.length;
			} else {
				nextIdx = (activeIdx - 1 + ids.length) % ids.length;
			}
			updatedState = await focusNativeTaskPane(taskId, ids[nextIdx]);
			break;
		}
		case "focusDirection": {
			const focused = focusPane(tree, action.direction);
			if (focused.activePaneId !== tree.activePaneId) {
				updatedState = await focusNativeTaskPane(taskId, focused.activePaneId);
			}
			break;
		}
		case "zoom": {
			let newTree: SplitTree;
			if (!action.mode || action.mode === "toggle") {
				newTree = toggleZoom(tree, action.paneId ?? tree.activePaneId);
			} else if (action.mode === "on") {
				newTree = zoomPane(tree, action.paneId ?? tree.activePaneId);
			} else {
				newTree = unzoomPane(tree);
			}
			updatedState = await setNativeTaskPaneLayout(taskId, newTree);
			break;
		}
		case "close": {
			const paneId = action.paneId ?? activePaneId;
			if (!paneId) throw new Error("No pane to close");

			if (listPaneIds(tree).length <= 1 && !action.force) {
				// Refuse to close the last pane without force — report state unchanged.
				break;
			}

			const { state } = await closeNativeTaskPane(taskId, paneId);
			if (!state) {
				// Session torn down — return empty state
				return {
					backend: "native",
					panes: [],
					activePaneId: null,
					zoomedPaneId: null,
					layout: null,
					layoutPreset: null,
					capabilities: ["split"],
				};
			}
			updatedState = state;
			break;
		}
		case "resize": {
			// left/right → horizontal split axis; up/down → vertical split axis
			const orientation: SplitOrientation =
				action.direction === "left" || action.direction === "right" ? "horizontal" : "vertical";
			const splitId = findSplitForResize(tree.root, action.paneId ?? activePaneId, orientation);
			if (!splitId) break;
			const delta =
				action.direction === "right" || action.direction === "down"
					? (action.amount ?? 5) / 100
					: -(action.amount ?? 5) / 100;
			const newTree = resizeSplit(tree, splitId, delta);
			updatedState = await setNativeTaskPaneLayout(taskId, newTree);
			break;
		}
		case "setSplitRatio": {
			// setSplitRatio clamps to MIN/MAX_SPLIT_RATIO and no-ops on an unknown id,
			// so a stale divider from a layout that changed mid-drag cannot corrupt the tree.
			const newTree = setSplitRatio(tree, action.splitId, action.ratio);
			if (newTree === tree) break;
			updatedState = await setNativeTaskPaneLayout(taskId, newTree);
			break;
		}
		case "layoutPreset": {
			const splitPreset = paneLayoutPresetToSplitPreset(action.preset);
			const newTree = applySplitLayout(tree, splitPreset);
			updatedState = await setNativeTaskPaneLayout(taskId, newTree);
			break;
		}
		case "layoutCycle": {
			const currentPreset = detectLayoutPreset(tree);
			const nextPreset = nextTaskPaneLayoutPreset(currentPreset);
			const splitPreset = paneLayoutPresetToSplitPreset(nextPreset);
			const newTree = applySplitLayout(tree, splitPreset);
			updatedState = await setNativeTaskPaneLayout(taskId, newTree);
			break;
		}
	}

	// A no-op action (nothing to focus, last pane refused) still owes the caller the
	// current state, and that one DOES carry per-pane liveness.
	const finalState = updatedState ?? (await nativeTaskPanesState(taskId));
	if (!finalState) throw new Error(`No native pane set for task ${taskId.slice(0, 8)}`);
	const updatedTree = finalState.layout ? restoreSplitTree(finalState.layout) : null;
	return nativeStateToTaskPaneState(finalState, updatedTree, nativeAuxPaneLabels(taskId, finalState));
}

// ── Handler: tmuxNewWindow ────────────────────────────────────────────────────

async function tmuxNewWindow(params: { taskId: string }): Promise<void> {
	const { task } = await findTaskAcrossProjects(params.taskId);
	// No-op for native tasks — newWindow is tmux-only
	if (task && taskTerminalBackendIdentity(task) === "native") return;

	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);
	try {
		await tmux.newWindow({ target: tmuxSession, cwd: PANE_CWD_FORMAT, socket });
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		throw new Error(`tmux new-window failed: ${err.stderr || "unknown error"}`);
	}
}

// ── Handler: getPanePtyUrl ────────────────────────────────────────────────────

async function getPanePtyUrl(params: { taskId: string; paneId: string }): Promise<{ url: string } | { gone: true }> {
	log.info("→ getPanePtyUrl", { taskId: params.taskId.slice(0, 8), paneId: params.paneId });
	const { task: foundTask, project: foundProject } = await findTaskAcrossProjects(params.taskId);
	if (!foundTask || !foundProject) {
		throw new Error(`Task ${params.taskId.slice(0, 8)} not found`);
	}
	const identity = taskTerminalBackendIdentity(foundTask);
	if (identity !== "native") {
		throw new Error(`getPanePtyUrl is only available for native tasks (got: ${identity})`);
	}
	const nativeState = await nativeTaskPanesState(params.taskId);
	if (!nativeState) {
		throw new Error(`No native pane state for task ${params.taskId.slice(0, 8)}`);
	}
	const pane = nativeState.panes.find((p) => p.paneId === params.paneId);
	if (!pane) {
		throw new Error(`Pane ${params.paneId} not found in task ${params.taskId.slice(0, 8)}`);
	}
	// First pane is registered under the bare taskId; additional panes use a composite key.
	const isFirstPane = nativeState.panes[0]?.paneId === params.paneId;
	const sessionKey = isFirstPane
		? params.taskId
		: paneSessionKey(params.taskId, params.paneId);

	if (!foundTask.worktreePath) {
		throw new Error(`Task ${params.taskId.slice(0, 8)} has no worktree path`);
	}

	if (isFirstPane) {
		// The bare key is registered by the launch path, which only ever ran in the
		// app process that STARTED the task. Any other viewer — a second app
		// instance, or this one after a restart — finds nothing in the sessions map
		// and the socket is refused as an unknown session, while panes 2..N attach
		// fine because they are registered lazily right here. Rebind on demand so
		// every pane is discoverable from every process. Never spawns.
		if (!pty.hasSession(params.taskId)) {
			const reattached = await pty.reattachNativeTaskSession(
				params.taskId,
				foundProject.id,
				foundTask.worktreePath,
			);
			if (!reattached) {
				log.info("← getPanePtyUrl: first pane host is gone", { taskId: params.taskId.slice(0, 8) });
				return { gone: true };
			}
		}
	} else {
		await pty.ensureNativePanePtySession(
			params.taskId,
			params.paneId,
			pane.sessionId,
			foundProject.id,
			foundTask.worktreePath,
		);
		if (!pty.hasSession(sessionKey)) {
			log.info("← getPanePtyUrl: pane host is gone", { paneId: params.paneId });
			return { gone: true };
		}
	}

	const url = `ws://localhost:${pty.getPtyPort()}?session=${sessionKey}`;
	log.info("← getPanePtyUrl", { url, paneId: params.paneId, isFirstPane });
	return { url };
}

// ── Export ────────────────────────────────────────────────────────────────────

export const taskPanesHandlers = {
	taskPaneState,
	taskPaneAction,
	tmuxNewWindow,
	getPanePtyUrl,
};
