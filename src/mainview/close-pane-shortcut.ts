import { confirm } from "./confirm";
import { getCachedGlobalSettings } from "./global-settings-cache";
import { translate } from "./i18n";
import { currentNativePaneFocus } from "./native-pane-focus";
import { fetchPaneState, runPaneAction } from "./pane-state-bus";

/**
 * The close-pane shortcut: closes the pane the keyboard is in, asking "Close pane N?"
 * first when Settings → Terminal → Confirm before closing a pane is on.
 *
 * Native focus is client-local, so the pane to close is this viewer's focused one;
 * on tmux the server's active pane already is. A lone pane is never asked about —
 * the server refuses to close it without a force anyway.
 */
export async function closeFocusedPane(taskId: string): Promise<void> {
	const ask = getCachedGlobalSettings()?.confirmClosePane === true;
	const state = await fetchPaneState(taskId).catch(() => null);
	const target = state?.backend === "native" ? currentNativePaneFocus(taskId) ?? undefined : undefined;

	if (ask && state && state.panes.length > 1) {
		const paneId = target ?? state.activePaneId;
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
	await runPaneAction(taskId, { kind: "close", paneId: target });
}
