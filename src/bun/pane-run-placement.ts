/**
 * Which existing pane a `dev3 pane run` splits, on each backend (seq 2124).
 *
 * The decision itself is the pure {@link planPaneSplit}; this module only reads
 * the live layout and names the panes. Two identities matter and NEITHER comes
 * from focus: the protected MAIN pane (the caller's own pane, else the task's
 * agent pane) and the AUXILIARY panes — panes dev3 opened for output, recognised
 * by their launch command exactly as every other dev3 pane is re-found. Every
 * other pane (a second agent, a pane the user opened) is neither split nor sized.
 */

import type { Task } from "../shared/types";
import { createSplitTree, getPaneRects, listPaneIds, restoreSplitTree, type SplitOrientation } from "../shared/split-tree";
import { planAuxiliarySplit, planPaneSplit, type PaneSplitCandidate, type PaneSplitPlan } from "../shared/pane-split-plan";
import { auxPurposeOfCommand } from "./task-aux-panes";
import { nativeTaskPaneCommands, nativeTaskPanesState } from "./native-task-panes";
import { PANE_RUN_VERB } from "./pane-run-store";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { PANE_SPLIT_LAYOUT_FORMAT, taskSessionName, tmux, TmuxError } from "./tmux";

export interface PaneRunSplitTarget {
	/** The pane to split; on tmux a `%N` id, on native a SplitTree pane id. */
	paneId: string;
	orientation: SplitOrientation;
	plan: Extract<PaneSplitPlan, { kind: "split" }>;
}

export type PaneRunSplitDecision =
	| { kind: "split"; target: PaneRunSplitTarget }
	| { kind: "no-room"; plan: Extract<PaneSplitPlan, { kind: "no-room" }> }
	/** tmux only: no window has room, so the run gets a window of its own. */
	| { kind: "new-window"; plan: Extract<PaneSplitPlan, { kind: "no-room" }> }
	/** The layout could not be read; the caller keeps the legacy split. */
	| { kind: "unplanned"; reason: string };

export interface PaneRunPlacementRequest {
	task: Task;
	socket: string;
	/** The pane the CLI was called from (`TMUX_PANE` / `DEV3_PANE_ID`), when any. */
	selfPaneId: string | null;
	/** `--below`: the caller allows a vertical split only. */
	below: boolean;
}

/**
 * dev3's own output panes: pane runs, dev servers, git operations, a setup
 * re-run. A column agent is an AGENT and is never auxiliary space.
 */
export function isAuxiliaryOutputCommand(taskId: string, command: string): boolean {
	if (command.includes(PANE_RUN_VERB) && /run-[0-9a-f]{12}/.test(command)) return true;
	const purpose = auxPurposeOfCommand(taskId, [command]);
	return purpose !== null && purpose !== "columnAgent";
}

/**
 * The pane a native task's agent runs in: the first pane of its SplitTree
 * (`NATIVE_AGENT_PANE_ID`). Derived here because importing that constant pulls
 * the whole pty-server graph into a module the RPC layer imports.
 */
const NATIVE_FIRST_PANE_ID = createSplitTree().root.id;

function orientationsFor(below: boolean): SplitOrientation[] {
	return below ? ["vertical"] : ["horizontal", "vertical"];
}

/** `%12` → 12; creation order on one tmux server. */
function tmuxPaneOrdinal(paneId: string): number {
	const n = Number(paneId.replace(/^%/, ""));
	return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** `pane-7` → 7; creation order inside one SplitTree. */
function nativePaneOrdinal(paneId: string): number {
	const n = Number(paneId.replace(/^pane-/, ""));
	return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

export async function decidePaneRunSplit(request: PaneRunPlacementRequest): Promise<PaneRunSplitDecision> {
	return taskTerminalBackendIdentity(request.task) === "native"
		? decideNative(request)
		: decideTmux(request);
}

async function decideTmux({ task, socket, selfPaneId, below }: PaneRunPlacementRequest): Promise<PaneRunSplitDecision> {
	let rows;
	try {
		rows = await tmux.listPanes(PANE_SPLIT_LAYOUT_FORMAT, { target: taskSessionName(task.id), scope: "session", socket });
	} catch (err) {
		if (err instanceof TmuxError) return { kind: "unplanned", reason: `tmux could not list the session's panes: ${err.stderr || err.message}` };
		throw err;
	}
	const aux = new Set(rows.filter((row) => isAuxiliaryOutputCommand(task.id, row.startCommand)).map((row) => row.paneId));
	const nonAux = rows.filter((row) => !aux.has(row.paneId) && !row.dead);
	const byAge = [...nonAux].sort((a, b) => tmuxPaneOrdinal(a.paneId) - tmuxPaneOrdinal(b.paneId));
	const registered = (task.sessionState?.panes ?? []).map((pane) => pane.paneId).filter((id): id is string => !!id);

	const main =
		nonAux.find((row) => row.paneId === selfPaneId) ??
		registered.map((id) => nonAux.find((row) => row.paneId === id)).find((row) => row !== undefined) ??
		byAge.find((row) => row.agentTag === "1") ??
		byAge[0];
	if (!main) return { kind: "unplanned", reason: "the session has no pane that is not dev3 output" };

	// Only the main pane's window: a split never lands on a tab the user is not
	// looking at because some older output pane happens to live there.
	const candidates: PaneSplitCandidate[] = rows
		.filter((row) => aux.has(row.paneId) && !row.dead && row.windowId === main.windowId)
		.map((row) => ({ paneId: row.paneId, cols: row.width, rows: row.height, order: tmuxPaneOrdinal(row.paneId) }));

	const inMainWindow = planPaneSplit({
		main: { paneId: main.paneId, cols: main.width, rows: main.height, order: tmuxPaneOrdinal(main.paneId) },
		auxiliary: candidates,
		orientations: orientationsFor(below),
		separator: 1,
	});
	if (inMainWindow.kind === "split") return decision(inMainWindow);

	// Overflow: a window holding nothing but dev3 output is a window dev3 opened for
	// it, so its panes are fair game. A window with any other pane in it is not.
	const windowsWithOthers = new Set(rows.filter((row) => !aux.has(row.paneId)).map((row) => row.windowId));
	const overflow: PaneSplitCandidate[] = rows
		.filter((row) => aux.has(row.paneId) && !row.dead && row.windowId !== main.windowId && !windowsWithOthers.has(row.windowId))
		.map((row) => ({ paneId: row.paneId, cols: row.width, rows: row.height, order: tmuxPaneOrdinal(row.paneId) }));
	const inOverflow = planAuxiliarySplit(overflow, orientationsFor(below), 1);
	if (inOverflow.kind === "split") return decision(inOverflow);
	return { kind: "new-window", plan: inMainWindow };
}

async function decideNative({ task, selfPaneId, below }: PaneRunPlacementRequest): Promise<PaneRunSplitDecision> {
	const state = await nativeTaskPanesState(task.id);
	const tree = state ? restoreSplitTree(state.layout) : null;
	if (!state || !tree) return { kind: "unplanned", reason: "the native pane set could not be read" };
	const commands = await nativeTaskPaneCommands(task.id);
	const commandOf = (paneId: string) => commands.find((entry) => entry.paneId === paneId)?.command.join(" ") ?? "";
	const rects = getPaneRects(tree);
	const order = listPaneIds(tree);
	const live = state.panes.filter((pane) => rects.has(pane.paneId));
	const aux = new Set(live.filter((pane) => isAuxiliaryOutputCommand(task.id, commandOf(pane.paneId))).map((pane) => pane.paneId));
	const nonAux = live.filter((pane) => !aux.has(pane.paneId));

	const main =
		nonAux.find((pane) => pane.paneId === selfPaneId) ??
		nonAux.find((pane) => pane.paneId === NATIVE_FIRST_PANE_ID) ??
		order.map((id) => nonAux.find((pane) => pane.paneId === id)).find((pane) => pane !== undefined);
	if (!main) return { kind: "unplanned", reason: "the pane set has no pane that is not dev3 output" };

	// The SplitTree is the exact geometry; a pane's own cols/rows can be stale (a
	// pane no view has attached to keeps its spawn size). The grid is scaled from
	// the main pane, the one the user is actually looking at.
	const mainRect = rects.get(main.paneId)!;
	const gridCols = mainRect.width > 0 ? main.cols / mainRect.width : main.cols;
	const gridRows = mainRect.height > 0 ? main.rows / mainRect.height : main.rows;
	const cellsOf = (paneId: string) => {
		const rect = rects.get(paneId)!;
		return { cols: Math.round(rect.width * gridCols), rows: Math.round(rect.height * gridRows) };
	};

	const candidates: PaneSplitCandidate[] = live
		.filter((pane) => aux.has(pane.paneId) && pane.alive)
		.map((pane) => ({ paneId: pane.paneId, ...cellsOf(pane.paneId), order: nativePaneOrdinal(pane.paneId) }));

	return decision(
		planPaneSplit({
			main: { paneId: main.paneId, ...cellsOf(main.paneId), order: nativePaneOrdinal(main.paneId) },
			auxiliary: candidates,
			orientations: orientationsFor(below),
			separator: 0,
		}),
	);
}

function decision(plan: PaneSplitPlan): PaneRunSplitDecision {
	if (plan.kind === "no-room") return { kind: "no-room", plan };
	return { kind: "split", target: { paneId: plan.paneId, orientation: plan.orientation, plan } };
}
