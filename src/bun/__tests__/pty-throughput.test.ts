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

		// Each read is a copy, so a caller cannot corrupt the next one.
		const first = rate.read();
		first.a = 999;
		expect(rate.read().a).toBe(5);
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

	it("creates flush and drop counters at zero until their rate window closes", () => {
		noteFlush("s", 1000, 3);
		noteDrop("s", 5 * 1024 * 1024);

		// The rate window has not closed, but the counters exist and start at zero.
		expect(throughputSnapshot()["s"]).toMatchObject({ bytesOut: 0, messages: 0, drops: 0, droppedBytes: 0 });
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

	it("reports nothing before any session produced, and drops a session's counters when it goes away", () => {
		expect(throughputSnapshot()).toEqual({});
		noteBytesIn("gone", 1);
		expect(throughputSnapshot()).toHaveProperty("gone");

		forgetSession("gone");

		expect(throughputSnapshot()).not.toHaveProperty("gone");
	});
});
