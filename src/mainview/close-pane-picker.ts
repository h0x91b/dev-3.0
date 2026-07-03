/**
 * Cross-tree signal to enter the two-step "close pane" picker.
 *
 * The trigger (the red Close Pane button in `TaskTmuxControls`, and the native
 * "Close Pane" menu item) lives in the task info-panel toolbar, but the picker
 * overlay is rendered over the terminal in `TaskTerminal` — a different subtree.
 * A `window` CustomEvent (the same decoupling the app uses for `rpc:*` and
 * `KEYMAP_CHANGED_EVENT`) bridges them, scoped by `taskId` so only the matching
 * terminal reacts.
 */
export const CLOSE_PANE_PICKER_EVENT = "dev3:closePanePicker";

export interface ClosePanePickerDetail {
	taskId: string;
}

/** Ask the terminal-area overlay for `taskId` to enter "pick a pane to close" mode. */
export function startClosePanePicker(taskId: string): void {
	window.dispatchEvent(
		new CustomEvent<ClosePanePickerDetail>(CLOSE_PANE_PICKER_EVENT, { detail: { taskId } }),
	);
}
