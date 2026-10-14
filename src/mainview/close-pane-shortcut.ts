import { confirm } from "./confirm";
import { getCachedGlobalSettings } from "./global-settings-cache";
import { translate } from "./i18n";
import { currentNativePaneFocus } from "./native-pane-focus";
import { fetchPaneState, runPaneAction } from "./pane-state-bus";
import { toast } from "./toast";
import { taskPaneSupports, type TaskPaneState } from "../shared/task-panes";

/**
 * The close-pane shortcut: closes the pane the keyboard is in, asking "Close pane N?"
 * first when Settings → Terminal → Confirm before closing a pane is on.
 *
 * The pane is resolved once, before asking, and closed by id: tmux's active pane can
 * move while the dialog is open (another viewer, an agent, an exiting process), and
 * the answer is about the pane that was named. Native focus is client-local, so there
 * the target is this viewer's focused pane.
 */
export async function closeFocusedPane(taskId: string): Promise<void> {
	const ask = getCachedGlobalSettings()?.confirmClosePane === true;
	const state = await fetchPaneState(taskId).catch(() => null);
	if (ask && !state) {
		toast.error(translate("tmux.closePaneAskFailed"));
		return;
	}
	const paneId = (state?.backend === "native" ? currentNativePaneFocus(taskId) : null) ?? state?.activePaneId ?? undefined;

	if (ask && state && closeWouldSucceed(state)) {
		const pane = state.panes.find((p) => p.paneId === paneId);
		const accepted = await confirm({
			title: translate("tmux.closePaneAskTitle", { index: String((pane?.index ?? 0) + 1) }),
			message: translate("tmux.closePaneAskMessage"),
			confirmLabel: translate("tmux.closePaneConfirmLabel"),
			danger: true,
			keyboardChoice: true,
		});
		if (!accepted) return;
	}
	await runPaneAction(taskId, { kind: "close", paneId });
}

/**
 * The server refuses only the session's last pane. On tmux `panes` lists the active
 * window alone, so a lone pane there still closes — with its window — when others exist.
 */
function closeWouldSucceed(state: TaskPaneState): boolean {
	return state.panes.length > 1 || taskPaneSupports(state, "closeWindow");
}
