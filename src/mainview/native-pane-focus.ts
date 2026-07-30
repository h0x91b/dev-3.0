/**
 * Which native pane the viewer is looking at, shared between the terminal and the
 * pane controls in the info panel — two sibling components with no common owner.
 *
 * Focus is client-local by design (see decision 179), so it cannot live on the
 * server; the last value is kept here so controls mounted after the terminal can
 * still target the right pane.
 */

const EVENT = "dev3:nativePaneFocus";

const lastFocus = new Map<string, string>();

export function publishNativePaneFocus(taskId: string, paneId: string): void {
	if (lastFocus.get(taskId) === paneId) return;
	lastFocus.set(taskId, paneId);
	window.dispatchEvent(new CustomEvent(EVENT, { detail: { taskId, paneId } }));
}

export function currentNativePaneFocus(taskId: string): string | null {
	return lastFocus.get(taskId) ?? null;
}

export function subscribeNativePaneFocus(taskId: string, onFocus: (paneId: string) => void): () => void {
	const listener = (event: Event) => {
		const detail = (event as CustomEvent<{ taskId: string; paneId: string }>).detail;
		if (detail?.taskId === taskId) onFocus(detail.paneId);
	};
	window.addEventListener(EVENT, listener);
	return () => window.removeEventListener(EVENT, listener);
}

/** Test-only: drop remembered focus so suites do not leak state into each other. */
export function _resetNativePaneFocus(): void {
	lastFocus.clear();
}
