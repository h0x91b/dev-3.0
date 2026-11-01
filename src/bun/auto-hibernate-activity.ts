import type { Task } from "../shared/types";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { getNativeTaskOutputTime, getSessionTmuxName } from "./pty-server";
import { tmux, PEEK_PANE_FORMAT, PANE_SPLIT_LAYOUT_FORMAT, DEFAULT_TMUX_SOCKET } from "./tmux";
import { nativeTaskPanesState } from "./native-task-panes";
import { discoverPeerSockets } from "./instance-broadcast";
import { readLiveDevServerNames } from "./rpc-handlers/tmux-pty/dev-servers";

export async function readAutoHibernateOutputAt(task: Task): Promise<number | null> {
	// Instance-local clocks cannot prove idleness while another app is running.
	if (discoverPeerSockets().length > 0) return null;
	// A browser can use a quiet server without producing terminal output.
	if ((await readLiveDevServerNames(task, task.tmuxSocket ?? DEFAULT_TMUX_SOCKET)).length > 0) return null;
	if (taskTerminalBackendIdentity(task) === "native") {
		const state = await nativeTaskPanesState(task.id);
		if (!state || state.panes.length !== 1 || !state.panes[0].alive) return null;
		const pane = state.panes[0];
		if (!task.sessionState?.panes.some(entry => entry.paneId === pane.paneId && entry.agentCmd && !entry.parked)) return null;
		return getNativeTaskOutputTime(task.id, [pane.paneId]);
	}
	const target = { target: getSessionTmuxName(task.id), scope: "session" as const, socket: task.tmuxSocket ?? undefined };
	const layout = await tmux.listPanes(PANE_SPLIT_LAYOUT_FORMAT, target);
	if (layout.length !== 1 || layout[0].dead || layout[0].agentTag !== "1") return null;
	const panes = await tmux.listPanes(PEEK_PANE_FORMAT, {
		target: getSessionTmuxName(task.id), scope: "session", socket: task.tmuxSocket ?? undefined,
	});
	if (panes.length !== 1 || panes[0].paneId !== layout[0].paneId || panes.some(pane => !Number.isFinite(pane.windowActivity) || pane.windowActivity <= 0)) return null;
	return Math.max(...panes.map(pane => pane.windowActivity * 1000));
}
