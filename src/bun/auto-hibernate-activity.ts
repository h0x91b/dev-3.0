import type { Task } from "../shared/types";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { getNativeTaskOutputTime, getSessionTmuxName } from "./pty-server";
import { tmux, PEEK_PANE_FORMAT, DEFAULT_TMUX_SOCKET } from "./tmux";
import { nativeTaskPanesState } from "./native-task-panes";
import { discoverPeerSockets } from "./instance-broadcast";
import { isTaskBeingViewed } from "./task-activity";
import { getActiveContext, isAppForeground } from "./rpc-handlers/shared";
import { readLiveDevServerNames } from "./rpc-handlers/tmux-pty/dev-servers";

export async function readAutoHibernateOutputAt(task: Task): Promise<number | null> {
	// Instance-local clocks cannot prove idleness while another app is running.
	if (discoverPeerSockets().length > 0 || isTaskBeingViewed(task.id)
		|| (isAppForeground() && getActiveContext().taskId === task.id)) return null;
	// A browser can use a quiet server without producing terminal output.
	if ((await readLiveDevServerNames(task, task.tmuxSocket ?? DEFAULT_TMUX_SOCKET)).length > 0) return null;
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
