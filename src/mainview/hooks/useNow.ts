import { useEffect, useState, useSyncExternalStore } from "react";

/** The current time, re-read every `intervalMs`, so countdowns move without a push. */
export function useNow(intervalMs = 15_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}

const SHARED_TICK_MS = 15_000;
let sharedNow = Date.now();
let sharedTimer: ReturnType<typeof setInterval> | null = null;
const sharedListeners = new Set<() => void>();

function subscribeShared(listener: () => void): () => void {
	sharedListeners.add(listener);
	if (sharedTimer === null) {
		sharedNow = Date.now();
		sharedTimer = setInterval(() => {
			sharedNow = Date.now();
			for (const notify of sharedListeners) notify();
		}, SHARED_TICK_MS);
	}
	return () => {
		sharedListeners.delete(listener);
		if (sharedListeners.size === 0 && sharedTimer !== null) {
			clearInterval(sharedTimer);
			sharedTimer = null;
		}
	};
}

/**
 * One 15s clock shared by every subscriber — a board of 50 cards runs a single
 * interval, and only the components that call this re-render on each tick.
 */
export function useSharedNow(): number {
	return useSyncExternalStore(subscribeShared, readShared, readShared);
}

function readShared(): number {
	// With no subscriber the clock is not ticking, so a first render would read
	// whatever time the last subscriber left behind — refresh it once instead.
	if (sharedTimer === null && Date.now() - sharedNow > SHARED_TICK_MS) sharedNow = Date.now();
	return sharedNow;
}
