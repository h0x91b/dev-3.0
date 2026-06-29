import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function getSnapshot(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(QUERY).matches;
}

function subscribe(cb: () => void): () => void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
	const mq = window.matchMedia(QUERY);
	mq.addEventListener("change", cb);
	return () => mq.removeEventListener("change", cb);
}

/**
 * Tracks the user's `prefers-reduced-motion` setting. When true, callers must
 * skip non-essential animations and render the final state immediately.
 */
export function useReducedMotion(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
