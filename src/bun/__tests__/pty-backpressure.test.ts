import { describe, it, expect } from "vitest";
import {
	batchWindowMs,
	isBackedUp,
	PTY_BACKPRESSURE_HIGH_WATER_BYTES,
	PTY_BACKPRESSURE_LOW_WATER_BYTES,
	PTY_BATCH_INTERVAL_MAX_MS,
} from "../pty-backpressure";

const BASE = 16;

describe("batchWindowMs", () => {
	it("keeps the normal cadence while the socket is draining", () => {
		expect(batchWindowMs(0, BASE)).toBe(BASE);
		expect(batchWindowMs(PTY_BACKPRESSURE_LOW_WATER_BYTES - 1, BASE)).toBe(BASE);
	});

	it("caps at the maximum window once the socket is saturated", () => {
		expect(batchWindowMs(PTY_BACKPRESSURE_HIGH_WATER_BYTES, BASE)).toBe(PTY_BATCH_INTERVAL_MAX_MS);
		expect(batchWindowMs(PTY_BACKPRESSURE_HIGH_WATER_BYTES * 10, BASE)).toBe(PTY_BATCH_INTERVAL_MAX_MS);
	});

	it("interpolates between the water marks", () => {
		const mid = (PTY_BACKPRESSURE_LOW_WATER_BYTES + PTY_BACKPRESSURE_HIGH_WATER_BYTES) / 2;
		const window = batchWindowMs(mid, BASE);
		expect(window).toBeGreaterThan(BASE);
		expect(window).toBeLessThan(PTY_BATCH_INTERVAL_MAX_MS);
		expect(window).toBe(Math.round(BASE + (PTY_BATCH_INTERVAL_MAX_MS - BASE) / 2));
	});

	it("never shrinks below the base window as pressure grows", () => {
		let previous = 0;
		for (let bytes = 0; bytes <= PTY_BACKPRESSURE_HIGH_WATER_BYTES; bytes += 32 * 1024) {
			const window = batchWindowMs(bytes, BASE);
			expect(window).toBeGreaterThanOrEqual(previous);
			previous = window;
		}
	});
});

describe("isBackedUp", () => {
	it("is false below the low water mark and true at or above it", () => {
		expect(isBackedUp(0)).toBe(false);
		expect(isBackedUp(PTY_BACKPRESSURE_LOW_WATER_BYTES - 1)).toBe(false);
		expect(isBackedUp(PTY_BACKPRESSURE_LOW_WATER_BYTES)).toBe(true);
	});
});
