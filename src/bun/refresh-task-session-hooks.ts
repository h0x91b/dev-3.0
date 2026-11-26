import * as data from "./data";
import { DEFAULT_TMUX_SOCKET, SESSION_OVERVIEW_FORMAT, parseDev3SessionName, tmux } from "./tmux";
import { installPaneExitedHooks } from "./pty-server";
import { createLogger } from "./logger";

const log = createLogger("task-session-hooks");

/**
 * A tmux task session outlives the app, and its pane-exited hooks name the PREVIOUS app's
 * HTTP port. Re-point every live task session at this app, so a window a CLI command opens
 * before anyone reattaches the terminal still reports its exits. Best-effort.
 */
export async function refreshTaskSessionHooks(): Promise<void> {
	const sockets = new Set([DEFAULT_TMUX_SOCKET]);
	try {
		for (const project of [...await data.loadProjects(), ...await data.loadVirtualProjects()]) {
			for (const task of await data.loadTasks(project)) if (task.tmuxSocket) sockets.add(task.tmuxSocket);
		}
	} catch (err) {
		log.warn("Could not list task tmux sockets; refreshing the default one only", { error: String(err) });
	}
	for (const socket of sockets) {
		const rows = await tmux.listSessions(SESSION_OVERVIEW_FORMAT, { socket }).catch(() => []);
		for (const { name } of rows) {
			if (parseDev3SessionName(name)?.kind === "task") await installPaneExitedHooks(name, socket);
		}
	}
}
