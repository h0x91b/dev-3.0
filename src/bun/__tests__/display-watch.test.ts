import { describe, it, expect, vi } from "vitest";
import { displaySignature, startDisplayWatch, DISPLAY_WATCH_INTERVAL_MS } from "../display-watch";
import type { DisplayLike } from "../window-state";

const laptop: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, scaleFactor: 2 };
const laptopLowRes: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 2 };
const laptopScaled: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, scaleFactor: 1 };

/** Drives the watcher tick by tick with a clock the test owns. */
function harness(displaysPerTick: DisplayLike[][], clockPerTick?: number[]) {
	const events: { reason: string; signature: string }[] = [];
	let tick = -1;
	// A holder, not a bare `let`: TS cannot see that the mocked setInterval assigns
	// it, and narrows a plain variable to `null` at the call below.
	const timer: { fire: (() => void) | null } = { fire: null };
	let clock = 0;

	const stop = startDisplayWatch({
		getDisplays: () => (tick < 0 ? displaysPerTick[0]! : displaysPerTick[Math.min(tick, displaysPerTick.length - 1)]!),
		onChange: ({ reason, signature }) => events.push({ reason, signature }),
		now: () => clock,
		setInterval: (fn) => {
			timer.fire = fn;
			return 1;
		},
		clearInterval: () => {
			timer.fire = null;
		},
	});

	for (let i = 1; i < displaysPerTick.length; i++) {
		tick = i;
		clock += clockPerTick?.[i] ?? DISPLAY_WATCH_INTERVAL_MS;
		timer.fire?.();
	}
	return { events, stop, isRunning: () => timer.fire !== null };
}

describe("displaySignature", () => {
	it("changes when a display's resolution changes", () => {
		expect(displaySignature([laptop])).not.toBe(displaySignature([laptopLowRes]));
	});

	it("changes when only the scale factor changes", () => {
		expect(displaySignature([laptop])).not.toBe(displaySignature([laptopScaled]));
	});

	it("is order-independent, so display enumeration order cannot fake a change", () => {
		const second: DisplayLike = { id: 2, bounds: { x: 1728, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
		expect(displaySignature([laptop, second])).toBe(displaySignature([second, laptop]));
	});
});

describe("startDisplayWatch", () => {
	it("reports a resolution change once, not on every tick after it", () => {
		const { events } = harness([[laptop], [laptopLowRes], [laptopLowRes]]);
		expect(events).toHaveLength(1);
		expect(events[0]!.reason).toBe("displays");
	});

	it("stays silent while the layout is stable", () => {
		const { events } = harness([[laptop], [laptop], [laptop]]);
		expect(events).toEqual([]);
	});

	it("reports a wake even when the layout came back identical", () => {
		const { events } = harness([[laptop], [laptop]], [0, DISPLAY_WATCH_INTERVAL_MS * 60]);
		expect(events).toHaveLength(1);
		expect(events[0]!.reason).toBe("wake");
	});

	it("does not call a stalled event loop a wake", () => {
		const { events } = harness([[laptop], [laptop]], [0, DISPLAY_WATCH_INTERVAL_MS * 2]);
		expect(events).toEqual([]);
	});

	it("prefers the layout change over the wake when both land on one tick", () => {
		const { events } = harness([[laptop], [laptopLowRes]], [0, DISPLAY_WATCH_INTERVAL_MS * 60]);
		expect(events).toHaveLength(1);
		expect(events[0]!.reason).toBe("displays");
	});

	it("stops polling when stopped", () => {
		const h = harness([[laptop], [laptop]]);
		h.stop();
		expect(h.isRunning()).toBe(false);
	});

	it("never lets a display read crash the caller's timer setup", () => {
		const onChange = vi.fn();
		expect(() =>
			startDisplayWatch({
				getDisplays: () => [],
				onChange,
				setInterval: () => 1,
				clearInterval: () => {},
			}),
		).not.toThrow();
		expect(onChange).not.toHaveBeenCalled();
	});
});
