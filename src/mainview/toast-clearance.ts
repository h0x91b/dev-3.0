// The toast stack starts below whatever top chrome is on screen right now — the app
// header plus the active screen's toolbars — rather than at a fixed offset, so it
// never lands on a button (decisions/2026/10/25/toast-stack-clears-registered-toolbars.md).
// Its own module so toolbars can register without importing (or mocking) `toast.tsx`.
export const clearanceNodes = new Set<HTMLElement>();
export const clearanceListeners = new Set<() => void>();

function notifyClearance(): void {
	for (const listener of clearanceListeners) listener();
}

/**
 * Callback ref for a header or toolbar row the toast stack must never cover:
 * `<div ref={toastClearanceRef}>`. Stable, so React attaches it once per element.
 */
export function toastClearanceRef(node: HTMLElement | null): (() => void) | undefined {
	if (!node) return undefined;
	clearanceNodes.add(node);
	notifyClearance();
	return () => {
		clearanceNodes.delete(node);
		notifyClearance();
	};
}
