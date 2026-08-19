/**
 * The keystroke-to-pixel probe (seq 1575). The traps it exists to avoid: calling
 * agent output an echo, recording a shell that never answered as a huge sample,
 * and reporting an empty window every minute per pane.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	createTerminalLatencyProbe,
	isSamplableKeystroke,
	percentile,
	registerLatencyProbe,
	__resetLatencyProbesForTests,
	snapshotAllPanes,
	QUIET_BEFORE_MS,
	SAMPLE_TIMEOUT_MS,
	MAX_SAMPLES,
	RATE_WINDOW_MS,
	LONG_FRAME_MS,
	FRAME_GAP_CEILING_MS,
} from "../terminal-latency";

/** A clock the test drives by hand, so no assertion depends on real time. */
function fakeClock() {
	let t = 1000;
	return { now: () => t, advance: (ms: number) => { t += ms; } };
}

beforeEach(() => {
	__resetLatencyProbesForTests();
	delete window.__dev3TerminalLatency;
});

describe("isSamplableKeystroke", () => {
	it("takes a lone printable character", () => {
		expect(isSamplableKeystroke("a")).toBe(true);
		expect(isSamplableKeystroke(" ")).toBe(true);
		expect(isSamplableKeystroke("ю")).toBe(true);
	});

	it("refuses a paste, an escape sequence, and the control keys", () => {
		expect(isSamplableKeystroke("hello")).toBe(false);
		expect(isSamplableKeystroke("\x1b[A")).toBe(false);
		expect(isSamplableKeystroke("\r")).toBe(false);
		expect(isSamplableKeystroke("\x7f")).toBe(false);
		expect(isSamplableKeystroke("")).toBe(false);
	});
});

describe("percentile", () => {
	it("uses nearest rank, and survives an empty set", () => {
		expect(percentile([], 0.5)).toBe(0);
		expect(percentile([10], 0.95)).toBe(10);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
	});
});

describe("createTerminalLatencyProbe", () => {
	it("measures a keystroke round trip through to the frame that shows it", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteInput("a");
		clock.advance(20);
		probe.noteOutput();
		clock.advance(9);
		probe.noteFrame(1.2);

		const snap = probe.snapshot();
		expect(snap.echo).toMatchObject({ count: 1, p50: 20 });
		expect(snap.paint).toMatchObject({ count: 1, p50: 29 });
		expect(snap.frame).toMatchObject({ count: 1, p50: 1.2 });
	});

	it("refuses to call agent output an echo", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		// A stream is running: bytes landed just before the key went down.
		probe.noteOutput();
		clock.advance(QUIET_BEFORE_MS - 1);
		probe.noteInput("a");
		clock.advance(5);
		probe.noteOutput();

		expect(probe.snapshot().echo.count).toBe(0);
	});

	it("samples again once the terminal has gone quiet", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteOutput();
		clock.advance(QUIET_BEFORE_MS);
		probe.noteInput("a");
		clock.advance(7);
		probe.noteOutput();

		expect(probe.snapshot().echo).toMatchObject({ count: 1, p50: 7 });
	});

	it("abandons a keystroke the shell never answered instead of recording it", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteInput("a");
		clock.advance(SAMPLE_TIMEOUT_MS + 1);
		probe.noteOutput();

		const snap = probe.snapshot();
		expect(snap.echo.count).toBe(0);
		// And no orphan paint sample is left waiting for the next frame.
		probe.noteFrame(1);
		expect(snap.paint.count).toBe(0);
		expect(probe.snapshot().paint.count).toBe(0);
	});

	it("closes each paint sample exactly once, not on every later frame", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteInput("a");
		clock.advance(10);
		probe.noteOutput();
		clock.advance(5);
		probe.noteFrame(1);
		clock.advance(16);
		probe.noteFrame(1);
		clock.advance(16);
		probe.noteFrame(1);

		expect(probe.snapshot().paint.count).toBe(1);
		expect(probe.snapshot().frame.count).toBe(3);
	});

	it("keeps a bounded window of samples", () => {
		const probe = createTerminalLatencyProbe();
		for (let i = 0; i < MAX_SAMPLES + 50; i++) probe.noteWrite(i);
		const snap = probe.snapshot();
		expect(snap.write.count).toBe(MAX_SAMPLES);
		// The oldest were dropped: the smallest surviving sample is not 0.
		expect(snap.write.max).toBe(MAX_SAMPLES + 49);
	});

	it("ignores a negative or non-finite duration rather than poisoning the stats", () => {
		const probe = createTerminalLatencyProbe();
		probe.noteWrite(-1);
		probe.noteWrite(Number.NaN);
		probe.noteWrite(Number.POSITIVE_INFINITY);
		expect(probe.snapshot().write.count).toBe(0);
	});

	it("reports on a timer, and says nothing about a window with no activity", () => {
		vi.useFakeTimers();
		try {
			const report = vi.fn();
			const probe = createTerminalLatencyProbe({ report, reportIntervalMs: 1000 });

			vi.advanceTimersByTime(3000);
			expect(report).not.toHaveBeenCalled();

			probe.noteFrame(2);
			vi.advanceTimersByTime(1000);
			expect(report).toHaveBeenCalledTimes(1);
			expect(report.mock.calls[0][0].frame.count).toBe(1);

			probe.dispose();
			probe.noteFrame(2);
			vi.advanceTimersByTime(5000);
			expect(report).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("starts empty rather than undefined for every stage", () => {
		const snap = createTerminalLatencyProbe().snapshot();
		for (const stage of ["echo", "paint", "write", "frame", "gap"] as const) {
			expect(snap[stage]).toEqual({ count: 0, p50: 0, p95: 0, max: 0 });
		}
		expect(snap.rates).toEqual({
			fps: 0, updates: 0, bytes: 0, messages: 0, wheelEvents: 0, wheelLines: 0, longFrames: 0,
		});
		expect(snap.wheelBacklog).toBe(0);
	});
});

/**
 * The gap between frames, not the cost of one. ghostty renders on an
 * unconditional rAF loop, so a frame that took 0.4 ms and a frame that never
 * happened look identical in `frame` — only `gap` tells them apart, and it is
 * the number that reads as choppy.
 */
describe("frame gaps", () => {
	it("measures the wall-clock between painted frames, skipping the first", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteFrame(0.4);
		clock.advance(16);
		probe.noteFrame(0.4);
		clock.advance(17);
		probe.noteFrame(0.4);

		const snap = probe.snapshot();
		expect(snap.gap).toMatchObject({ count: 2, p50: 16, max: 17 });
	});

	it("counts a frame that missed its slot, and leaves a healthy one alone", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteFrame(0.4);
		clock.advance(16);
		probe.noteFrame(0.4);
		clock.advance(LONG_FRAME_MS + 1);
		probe.noteFrame(0.4);
		clock.advance(RATE_WINDOW_MS);

		expect(probe.snapshot().rates.longFrames).toBe(1);
	});

	it("does not call a hidden tab a dropped frame", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteFrame(0.4);
		clock.advance(FRAME_GAP_CEILING_MS + 1);
		probe.noteFrame(0.4);
		clock.advance(RATE_WINDOW_MS);

		const snap = probe.snapshot();
		expect(snap.gap.count).toBe(0);
		expect(snap.rates.longFrames).toBe(0);
	});
});

describe("per-second counters", () => {
	it("reports what happened in the window that just closed", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		for (let i = 0; i < 60; i++) probe.noteFrame(0.4);
		probe.noteOutput();
		probe.noteBytes(2048);
		probe.noteWrite(0.1);
		probe.noteWrite(0.1);

		// The window is still open: nothing is claimed yet.
		expect(probe.snapshot().rates.fps).toBe(0);

		clock.advance(RATE_WINDOW_MS);
		const snap = probe.snapshot();
		expect(snap.rates).toMatchObject({ fps: 60, updates: 2, bytes: 2048, messages: 1 });
	});

	it("scales a window that stayed open longer than a second instead of overstating it", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		// 120 frames spread over four seconds is 30 fps, not 120.
		for (let i = 0; i < 120; i++) probe.noteFrame(0.4);
		clock.advance(4 * RATE_WINDOW_MS);

		expect(probe.snapshot().rates.fps).toBe(30);
	});

	it("forgets the previous window rather than repeating it forever", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteWrite(0.1);
		clock.advance(RATE_WINDOW_MS);
		expect(probe.snapshot().rates.updates).toBe(1);

		clock.advance(RATE_WINDOW_MS);
		expect(probe.snapshot().rates.updates).toBe(0);
	});

	it("separates wheel events the browser sent from lines the pacer let through", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteWheelEvent();
		probe.noteWheelEvent();
		probe.noteWheelSent(3, 0);
		probe.noteWheelSent(0, 12);
		clock.advance(RATE_WINDOW_MS);

		const snap = probe.snapshot();
		expect(snap.rates).toMatchObject({ wheelEvents: 2, wheelLines: 3 });
		// The backlog is a gauge, not a rate: it survives the window closing.
		expect(snap.wheelBacklog).toBe(12);
	});

	it("ignores a byte count that is not a positive number", () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });

		probe.noteBytes(0);
		probe.noteBytes(-5);
		probe.noteBytes(Number.NaN);
		clock.advance(RATE_WINDOW_MS);

		expect(probe.snapshot().rates.bytes).toBe(0);
	});
});

describe("registerLatencyProbe", () => {
	it("exposes every live pane through one global, and drops a pane on unregister", () => {
		const probe = createTerminalLatencyProbe();
		probe.noteWrite(3);
		const off = registerLatencyProbe("pane-a", probe);

		expect(window.__dev3TerminalLatency?.()).toHaveProperty("pane-a");
		expect(window.__dev3TerminalLatency?.()["pane-a"].write.count).toBe(1);

		off();
		expect(window.__dev3TerminalLatency?.()).toEqual({});
	});

	it("hands the overlay the same panes as the devtools global", () => {
		const probe = createTerminalLatencyProbe();
		probe.noteWrite(3);
		registerLatencyProbe("pane-a", probe);

		expect(snapshotAllPanes()["pane-a"].write.count).toBe(1);
		expect(Object.keys(snapshotAllPanes())).toEqual(Object.keys(window.__dev3TerminalLatency?.() ?? {}));
	});

	it("does not let a stale unregister evict the pane that replaced it", () => {
		const first = createTerminalLatencyProbe();
		const off = registerLatencyProbe("pane-a", first);
		const second = createTerminalLatencyProbe();
		registerLatencyProbe("pane-a", second);

		off();

		expect(window.__dev3TerminalLatency?.()).toHaveProperty("pane-a");
	});
});
