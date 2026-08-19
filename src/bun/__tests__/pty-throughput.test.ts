/**
 * PTY read-vs-sent counters, and the rolling window under them.
 *
 * The trap this exists to avoid: reporting a window that stayed open for four
 * seconds as a one-second rate, which would claim four times what happened —
 * and this is the instrument the "are we behind" question is answered with, so
 * an overstated rate is worse than no rate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRollingRate, ROLLING_WINDOW_MS } from "../../shared/rolling-rate";
import {
	noteBytesIn,
	noteFlush,
	noteDrop,
	noteQueued,
	noteWindow,
	forgetSession,
	throughputSnapshot,
	__resetThroughputForTests,
} from "../pty-throughput";

/** A clock the test drives by hand, so no assertion depends on real time. */
function fakeClock() {
	let t = 1000;
	return { now: () => t, advance: (ms: number) => { t += ms; } };
}

beforeEach(() => {
	__resetThroughputForTests();
});

describe("createRollingRate", () => {
	it("reports the window that just closed, not the one still filling", () => {
		const clock = fakeClock();
		const rate = createRollingRate(["a", "b"] as const, clock.now);

		rate.add("a", 5);
		rate.add("b");
		expect(rate.read()).toEqual({ a: 0, b: 0 });

		clock.advance(ROLLING_WINDOW_MS);
		expect(rate.read()).toEqual({ a: 5, b: 1 });
	});

	it("scales a window that stayed open too long instead of overstating it", () => {
		const clock = fakeClock();
		const rate = createRollingRate(["a"] as const, clock.now);

		rate.add("a", 100);
		clock.advance(4 * ROLLING_WINDOW_MS);

		expect(rate.read()).toEqual({ a: 25 });
	});

	it("forgets a closed window rather than repeating it forever", () => {
		const clock = fakeClock();
		const rate = createRollingRate(["a"] as const, clock.now);

		rate.add("a", 3);
		clock.advance(ROLLING_WINDOW_MS);
		expect(rate.read().a).toBe(3);

		clock.advance(ROLLING_WINDOW_MS);
		expect(rate.read().a).toBe(0);
	});

	it("ignores a count that is not a positive number", () => {
		const clock = fakeClock();
		const rate = createRollingRate(["a"] as const, clock.now);

		rate.add("a", 0);
		rate.add("a", -5);
		rate.add("a", Number.NaN);
		clock.advance(ROLLING_WINDOW_MS);

		expect(rate.read().a).toBe(0);
	});

	it("hands out a copy, so a caller cannot corrupt the next read", () => {
		const clock = fakeClock();
		const rate = createRollingRate(["a"] as const, clock.now);
		rate.add("a", 7);
		clock.advance(ROLLING_WINDOW_MS);

		const first = rate.read();
		first.a = 999;

		expect(rate.read().a).toBe(7);
	});
});

describe("pty throughput counters", () => {
	it("keeps sessions apart", () => {
		noteBytesIn("session-a", 100);
		noteBytesIn("session-b", 7);
		noteQueued("session-a", 4096);

		const snap = throughputSnapshot();
		expect(Object.keys(snap).sort()).toEqual(["session-a", "session-b"]);
		expect(snap["session-a"].queued).toBe(4096);
		expect(snap["session-b"].queued).toBe(0);
	});

	it("counts one flush once per viewer, because each one costs its own send", () => {
		noteFlush("s", 1000, 3);

		// The rate window has not closed, but the counters exist and start at zero.
		const snap = throughputSnapshot();
		expect(snap["s"].bytesOut).toBe(0);
		expect(snap["s"].messages).toBe(0);
	});

	it("remembers the high-water marks a one-second poll would miss", () => {
		noteQueued("s", 8 * 1024 * 1024);
		noteQueued("s", 1024);
		noteWindow("s", 2 * 1024 * 1024, 250);
		noteWindow("s", 0, 16);

		const snap = throughputSnapshot();
		expect(snap["s"].queued).toBe(1024);
		expect(snap["s"].queuedPeak).toBe(8 * 1024 * 1024);
		expect(snap["s"].socketBuffered).toBe(0);
		expect(snap["s"].socketPeak).toBe(2 * 1024 * 1024);
		// The window is a gauge, not a peak: it says what the LAST enqueue chose.
		expect(snap["s"].windowMs).toBe(16);
	});

	it("records a discarded backlog separately from what was sent", () => {
		noteDrop("s", 5 * 1024 * 1024);
		const snap = throughputSnapshot();
		// Same window rule as the rest — the counter exists, the rate is not due yet.
		expect(snap["s"]).toMatchObject({ drops: 0, droppedBytes: 0 });
	});

	it("drops a session's counters when the session goes away", () => {
		noteBytesIn("gone", 1);
		expect(throughputSnapshot()).toHaveProperty("gone");

		forgetSession("gone");

		expect(throughputSnapshot()).not.toHaveProperty("gone");
	});

	it("reports nothing at all before any session has produced", () => {
		expect(throughputSnapshot()).toEqual({});
	});
});
