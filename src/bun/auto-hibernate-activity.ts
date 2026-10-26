import type { Task } from "../shared/types";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { getNativeTaskOutputTime, getSessionTmuxName } from "./pty-server";
import { tmux, PEEK_PANE_FORMAT } from "./tmux";
import { nativeTaskPanesState } from "./native-task-panes";

export async function readAutoHibernateOutputAt(task: Task): Promise<number | null> {
	if (taskTerminalBackendIdentity(task) === "native") {
		const state = await nativeTaskPanesState(task.id);
		return state ? getNativeTaskOutputTime(task.id, state.panes.map(pane => pane.paneId)) : null;
	}
	const panes = await tmux.listPanes(PEEK_PANE_FORMAT, {
		target: getSessionTmuxName(task.id), scope: "session", socket: task.tmuxSocket ?? undefined,
	});
	if (!panes.length || panes.some(pane => !Number.isFinite(pane.windowActivity) || pane.windowActivity <= 0)) return null;
	return Math.max(...panes.map(pane => pane.windowActivity * 1000));
}
