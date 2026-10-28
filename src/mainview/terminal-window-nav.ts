import { api } from "./rpc";
import { confirm } from "./confirm";
import type { TFunction } from "./i18n";

const WINDOWS_CHANGED_EVENT = "dev3:tmuxWindowsChanged";

/** Tell every window navigator of `taskId` to re-read now (the app just changed its windows). */
export function notifyTmuxWindowsChanged(taskId: string): void {
	window.dispatchEvent(new CustomEvent(WINDOWS_CHANGED_EVENT, { detail: { taskId } }));
}

export function subscribeTmuxWindowsChanged(taskId: string, onChange: () => void): () => void {
	const listener = (e: Event) => {
		if ((e as CustomEvent<{ taskId: string }>).detail?.taskId === taskId) onChange();
	};
	window.addEventListener(WINDOWS_CHANGED_EVENT, listener);
	return () => window.removeEventListener(WINDOWS_CHANGED_EVENT, listener);
}

/** Open a new tmux window in the task's session and refresh its navigators at once. */
export async function openTmuxWindow(taskId: string): Promise<void> {
	try {
		await api.request.tmuxNewWindow({ taskId });
	} catch {
		// Same contract as before: a failed new-window is silent; the poll stays truthful.
	}
	notifyTmuxWindowsChanged(taskId);
}

/** Give a window a sticky name; "" hands it back to automatic naming. Refreshes its navigators. */
export async function renameTmuxWindow(taskId: string, windowId: string, name: string): Promise<void> {
	try {
		await api.request.tmuxRenameWindow({ taskId, windowId, name });
	} finally {
		notifyTmuxWindowsChanged(taskId);
	}
}

/**
 * Close one tmux window — `windowId`, or the active one when omitted. The agent's
 * window only goes after the user agreed, to that same window; the backend never
 * closes the last window. The one close path for the header button and the tabs.
 */
export async function closeTmuxWindow(taskId: string, windowId: string | undefined, t: TFunction): Promise<void> {
	try {
		const first = await api.request.tmuxCloseWindow({ taskId, windowId });
		if (first.closed || first.reason !== "agentWindow") return;
		const agreed = await confirm({
			title: t("tmux.closeAgentWindowConfirmTitle"),
			message: t("tmux.closeAgentWindowConfirmMessage"),
			confirmLabel: t("tmux.closeAgentWindowConfirmLabel"),
			danger: true,
		});
		if (agreed) await api.request.tmuxCloseWindow({ taskId, windowId: first.windowId, force: true });
	} finally {
		notifyTmuxWindowsChanged(taskId);
	}
}
