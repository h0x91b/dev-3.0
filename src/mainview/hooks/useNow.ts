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

interface SharedClock {
	now: number;
	timer: ReturnType<typeof setInterval> | null;
	listeners: Set<() => void>;
	subscribe: (listener: () => void) => () => void;
	read: () => number;
}

/** One interval per tick length, however many components read it. */
const clocks = new Map<number, SharedClock>();

function sharedClock(intervalMs: number): SharedClock {
	const existing = clocks.get(intervalMs);
	if (existing) return existing;
	const clock: SharedClock = {
		now: Date.now(),
		timer: null,
		listeners: new Set(),
		subscribe(listener) {
			clock.listeners.add(listener);
			if (clock.timer === null) {
				clock.now = Date.now();
				clock.timer = setInterval(() => {
					clock.now = Date.now();
					for (const notify of clock.listeners) notify();
				}, intervalMs);
			}
			return () => {
				clock.listeners.delete(listener);
				if (clock.listeners.size === 0 && clock.timer !== null) {
					clearInterval(clock.timer);
					clock.timer = null;
				}
			};
		},
		read() {
			// With no subscriber the clock is not ticking, so a first render would read
			// whatever time the last subscriber left behind — refresh it once instead.
			if (clock.timer === null && Date.now() - clock.now > intervalMs) clock.now = Date.now();
			return clock.now;
		},
	};
	clocks.set(intervalMs, clock);
	return clock;
}

/**
 * A clock shared by every subscriber with the same tick — a board of 50 cards runs a
 * single interval, and only the components that call this re-render on each tick.
 */
export function useSharedNow(intervalMs = SHARED_TICK_MS): number {
	const clock = sharedClock(intervalMs);
	return useSyncExternalStore(clock.subscribe, clock.read, clock.read);
}

/**
 * Something derived from the shared clock; the caller re-renders only when it changes.
 * A list of "3m ago" badges on a 1 s tick then re-renders the few whose text moved, not all.
 */
export function useSharedClockValue<T extends string | number | boolean>(intervalMs: number, derive: (now: number) => T): T {
	const clock = sharedClock(intervalMs);
	const snapshot = () => derive(clock.read());
	return useSyncExternalStore(clock.subscribe, snapshot, snapshot);
}

/** The current reading of a shared clock, without subscribing to it. */
export function readSharedNow(intervalMs = SHARED_TICK_MS): number {
	return sharedClock(intervalMs).read();
}
