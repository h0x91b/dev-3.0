import { describe, it, expect, vi } from "vitest";
import { displaySignature, startDisplayWatch, DISPLAY_WATCH_INTERVAL_MS } from "../display-watch";
import type { DisplayLike } from "../window-state";
import type { LateTickCause } from "../host-sleep-probe";

const laptop: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, scaleFactor: 2 };
const laptopLowRes: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 2 };
const laptopScaled: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, scaleFactor: 1 };

/** Drives the watcher tick by tick with a clock the test owns. */
async function harness(
	displaysPerTick: DisplayLike[][],
	clockPerTick?: number[],
	sleepCause: LateTickCause = "slept",
) {
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
		sleepProbe: async () => sleepCause,
	});

	for (let i = 1; i < displaysPerTick.length; i++) {
		tick = i;
		clock += clockPerTick?.[i] ?? DISPLAY_WATCH_INTERVAL_MS;
		timer.fire?.();
	}
	// The sleep probe answers asynchronously; let its verdict land.
	await new Promise((resolve) => setTimeout(resolve, 0));
	return { events, stop, isRunning: () => timer.fire !== null };
}

describe("displaySignature", () => {
	it("changes with resolution or scale factor, and is order-independent so enumeration order cannot fake a change", () => {
		expect(displaySignature([laptop])).not.toBe(displaySignature([laptopLowRes]));
		expect(displaySignature([laptop])).not.toBe(displaySignature([laptopScaled]));
		const second: DisplayLike = { id: 2, bounds: { x: 1728, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 };
		expect(displaySignature([laptop, second])).toBe(displaySignature([second, laptop]));
	});
});

describe("startDisplayWatch", () => {
	it("stays silent while stable and reports a resolution change once, not on every tick after it", async () => {
		expect((await harness([[laptop], [laptop], [laptop]])).events).toEqual([]);
		const { events } = await harness([[laptop], [laptopLowRes], [laptopLowRes]]);
		expect(events).toHaveLength(1);
		expect(events[0]!.reason).toBe("displays");
	});

	it("reports a long gap as a wake when the host slept or cannot tell, but not a starved host or a stalled event loop", async () => {
		const long = [0, DISPLAY_WATCH_INTERVAL_MS * 60];
		for (const [cause, expected] of [["slept", ["wake"]], ["unknown", ["wake"]], ["starved", []]] as const) {
			const { events } = await harness([[laptop], [laptop]], long, cause);
			expect(events.map((e) => e.reason), cause).toEqual(expected);
		}
		{
		const { events } = await harness([[laptop], [laptop]], [0, DISPLAY_WATCH_INTERVAL_MS * 2]);
		expect(events).toEqual([]);
		}
	});

	it("reports a real layout change over a wake on the same tick, even from a starved host", async () => {
		const { events } = await harness([[laptop], [laptopLowRes]], [0, DISPLAY_WATCH_INTERVAL_MS * 60], "starved");
		expect(events.map((e) => e.reason)).toEqual(["displays"]);
		{
		const { events } = await harness([[laptop], [laptopLowRes]], [0, DISPLAY_WATCH_INTERVAL_MS * 60]);
		expect(events).toHaveLength(1);
		expect(events[0]!.reason).toBe("displays");
		}
	});

	it("stops polling when stopped", async () => {
		const h = await harness([[laptop], [laptop]]);
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
