import { useEffect, useState } from "react";
import { api } from "./rpc";
import { confirm } from "./confirm";
import type { TFunction } from "./i18n";

/**
 * How the desktop task terminal shows its tmux windows when there are two or
 * more: a vertical rail on the left (default — it costs width, not a terminal
 * row) or a tab row on top. A per-device rendering preference, like zoom, so it
 * lives in localStorage and applies live through a change event.
 */
export type WindowNavStyle = "rail" | "tabs";

export const WINDOW_NAV_STYLES: readonly WindowNavStyle[] = ["rail", "tabs"];
export const DEFAULT_WINDOW_NAV_STYLE: WindowNavStyle = "rail";
const STORAGE_KEY = "dev3-window-nav-style";
const CHANGED_EVENT = "dev3:windowNavStyleChanged";

export function getWindowNavStyle(): WindowNavStyle {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "rail" || saved === "tabs") return saved;
	} catch {
		// localStorage unavailable — fall back to the default.
	}
	return DEFAULT_WINDOW_NAV_STYLE;
}

export function setWindowNavStyle(style: WindowNavStyle): void {
	try {
		localStorage.setItem(STORAGE_KEY, style);
	} catch {
		// localStorage unavailable — the change still applies for this session via the event.
	}
	window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: style }));
}

export function useWindowNavStyle(): WindowNavStyle {
	const [style, setStyle] = useState(getWindowNavStyle);
	useEffect(() => {
		const onChange = (e: Event) => setStyle((e as CustomEvent<WindowNavStyle>).detail ?? getWindowNavStyle());
		window.addEventListener(CHANGED_EVENT, onChange);
		return () => window.removeEventListener(CHANGED_EVENT, onChange);
	}, []);
	return style;
}

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
