/**
 * What the PTY server reads versus what it manages to hand a viewer.
 *
 * The renderer's own probe can only count what it already processed, so it
 * cannot tell "the shell produced little" from "the shell produced a lot and we
 * are behind". That blind spot is exactly the question behind the slow-motion
 * report in seq 1575: a viewer showing content from forty seconds ago.
 *
 * `bytesIn` against `bytesOut` answers it. When `in` outruns `out` for any
 * length of time the difference is sitting in a queue, and the gauges say which
 * one: `queued` is this module's own accumulator, `socketBuffered` is what the
 * sockets still owe, and `outstanding` is what a viewer has been sent but not
 * acknowledged — the only one that can see a backlog living in the renderer's
 * own receive path, which is where it actually turned out to be.
 */
import { createRollingRate } from "../shared/rolling-rate";
import type { PtyThroughputStats } from "../shared/types";

const RATE_KEYS = ["bytesIn", "bytesOut", "messages", "drops", "droppedBytes"] as const;
export type PtyRateKey = (typeof RATE_KEYS)[number];

interface Counters {
	rate: ReturnType<typeof createRollingRate<PtyRateKey>>;
	queued: number;
	socketBuffered: number;
	windowMs: number;
	queuedPeak: number;
	socketPeak: number;
	outstanding: number;
	outstandingPeak: number;
	dropping: boolean;
}

const bySession = new Map<string, Counters>();

function countersFor(key: string): Counters {
	let counters = bySession.get(key);
	if (!counters) {
		counters = {
			rate: createRollingRate(RATE_KEYS),
			queued: 0,
			socketBuffered: 0,
			windowMs: 0,
			queuedPeak: 0,
			socketPeak: 0,
			outstanding: 0,
			outstandingPeak: 0,
			dropping: false,
		};
		bySession.set(key, counters);
	}
	return counters;
}

/** Bytes the PTY handed us, before any batching. */
export function noteBytesIn(key: string, bytes: number): void {
	countersFor(key).rate.add("bytesIn", bytes);
}

/** One flush left for `clients` viewers, carrying `bytes` each. */
export function noteFlush(key: string, bytes: number, clients: number): void {
	const counters = countersFor(key);
	counters.rate.add("messages", Math.max(1, clients));
	counters.rate.add("bytesOut", bytes * Math.max(1, clients));
}

/** A backlog was discarded rather than replayed. */
export function noteDrop(key: string, bytes: number): void {
	const counters = countersFor(key);
	counters.rate.add("drops", 1);
	counters.rate.add("droppedBytes", bytes);
}

/** How much this module is holding. Sampled on every chunk, not just on a flush. */
export function noteQueued(key: string, queued: number): void {
	const counters = countersFor(key);
	counters.queued = queued;
	if (queued > counters.queuedPeak) counters.queuedPeak = queued;
}

/** What the sockets still owe, and the window that reading it produced. */
export function noteWindow(key: string, socketBuffered: number, windowMs: number): void {
	const counters = countersFor(key);
	counters.socketBuffered = socketBuffered;
	counters.windowMs = windowMs;
	if (socketBuffered > counters.socketPeak) counters.socketPeak = socketBuffered;
}

/**
 * How far the slowest viewer is behind by its own admission, and whether that
 * is currently costing it output. The one gauge that can see a queue living
 * past our sockets, so it is what proves the drop policy is working.
 */
export function noteOutstanding(key: string, outstanding: number, dropping: boolean): void {
	const counters = countersFor(key);
	counters.outstanding = outstanding;
	counters.dropping = dropping;
	if (outstanding > counters.outstandingPeak) counters.outstandingPeak = outstanding;
}

export function forgetSession(key: string): void {
	bySession.delete(key);
}

/** Every session the server is currently pumping, keyed the way it registered. */
export function throughputSnapshot(): Record<string, PtyThroughputStats> {
	const out: Record<string, PtyThroughputStats> = {};
	for (const [key, counters] of bySession) {
		out[key] = {
			...counters.rate.read(),
			queued: counters.queued,
			socketBuffered: counters.socketBuffered,
			windowMs: counters.windowMs,
			queuedPeak: counters.queuedPeak,
			socketPeak: counters.socketPeak,
			outstanding: counters.outstanding,
			outstandingPeak: counters.outstandingPeak,
			dropping: counters.dropping,
		};
	}
	return out;
}

/** Test-only: drop every session's counters. */
export function __resetThroughputForTests(): void {
	bySession.clear();
}
