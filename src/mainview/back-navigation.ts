/**
 * Android-style hardware Back support for the mobile remote UI.
 *
 * Mechanism: a sentinel entry is pushed onto browser history on load. A
 * hardware/gesture Back pops the sentinel and fires `popstate`; the handler
 * decides Android-style — close the topmost layered surface (modal, bottom
 * sheet, popover) first, else navigate the in-app route history back, else
 * arm double-back-to-exit: show a toast and leave the sentinel consumed for
 * ~2s so that a second press performs the real browser navigation (leaves
 * the app). If no second press comes, the sentinel is re-armed.
 *
 * Layered surfaces register close callbacks in a stack via `useBackLayer` /
 * `useEscapeKey` (any Esc-closable overlay is Back-closable); the stack lives
 * here, module-level, so it is reachable from the popstate handler without
 * React context. Pure logic — history/timers are injected for tests; the
 * React wiring lives in `hooks/useAndroidBackGuard.ts`.
 */

/** History state object marking our sentinel entry. */
export const BACK_SENTINEL_STATE = { dev3BackSentinel: true } as const;

/** True when a popstate/history state is our sentinel (forward-nav into it). */
export function isBackSentinelState(state: unknown): boolean {
	return !!state && typeof state === "object" && (state as { dev3BackSentinel?: unknown }).dev3BackSentinel === true;
}

// ── Back-layer stack ─────────────────────────────────────────────────

let layers: { id: number; close: () => void }[] = [];
let nextLayerId = 1;

/**
 * Register a layered surface's close callback. Returns the unregister
 * function. Mount order = stacking order: the most recently registered layer
 * is the topmost and closes first.
 */
export function registerBackLayer(close: () => void): () => void {
	const id = nextLayerId++;
	layers.push({ id, close });
	return () => {
		layers = layers.filter((layer) => layer.id !== id);
	};
}

/** Close the topmost registered layer. Returns false when the stack is empty. */
export function closeTopBackLayer(): boolean {
	const top = layers[layers.length - 1];
	if (!top) return false;
	top.close();
	return true;
}

/** Number of currently registered layers. */
export function backLayerCount(): number {
	return layers.length;
}

/** Reset the stack. Tests only. */
export function __resetBackLayersForTests(): void {
	layers = [];
}

// ── Back press decisions ─────────────────────────────────────────────

export type BackPressOutcome = "layer-closed" | "route-back" | "exit-armed";

export interface BackPressDeps {
	/** Close the topmost layered surface; false when none is open. */
	closeTopLayer: () => boolean;
	/** Navigate the in-app route history back; false when already at the root. */
	routeBack: () => boolean;
	/** Show the "press Back again to exit" toast. */
	showExitToast: () => void;
	/** Push the sentinel entry back onto browser history (re-arm the guard). */
	armSentinel: () => void;
	/** Schedule the delayed re-arm after the exit window closes. */
	scheduleRearm: (cb: () => void, ms: number) => void;
	/** How long the second press may exit for real; ~2s. */
	exitWindowMs?: number;
}

export const DEFAULT_EXIT_WINDOW_MS = 2_000;

/**
 * Build the popstate-side decision function. Call it whenever a Back press
 * consumed the sentinel entry.
 *
 * On "exit-armed" the sentinel is deliberately NOT re-armed right away: with
 * the sentinel gone, a second hardware Back within the window performs the
 * real browser navigation natively (no JS involved) — exactly the "press Back
 * again to exit" contract. The scheduled re-arm restores the guard if the
 * user stays.
 */
export function createBackPressHandler(deps: BackPressDeps): () => BackPressOutcome {
	const exitWindowMs = deps.exitWindowMs ?? DEFAULT_EXIT_WINDOW_MS;
	return function handleBackPress(): BackPressOutcome {
		if (deps.closeTopLayer()) {
			deps.armSentinel();
			return "layer-closed";
		}
		if (deps.routeBack()) {
			deps.armSentinel();
			return "route-back";
		}
		deps.showExitToast();
		deps.scheduleRearm(deps.armSentinel, exitWindowMs);
		return "exit-armed";
	};
}
