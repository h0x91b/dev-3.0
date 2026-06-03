import { useSyncExternalStore } from "react";

/**
 * Width below which the top header and task toolbar switch to a compact
 * layout (icon-only buttons + overflow menu). 1600px cleanly separates a
 * 14" MacBook (≤1512pt at default scaling) from a 16" one (1728pt), and
 * also fires when the window is shrunk on any display.
 */
export const COMPACT_MAX_WIDTH = 1600;

const QUERY = `(max-width: ${COMPACT_MAX_WIDTH}px)`;

function hasMatchMedia(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

function subscribe(onChange: () => void): () => void {
	if (!hasMatchMedia()) return () => {};
	const mql = window.matchMedia(QUERY);
	mql.addEventListener("change", onChange);
	return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
	if (!hasMatchMedia()) return false;
	return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
	return false;
}

/** True when the viewport is narrow enough to warrant the compact layout. */
export function useCompact(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
