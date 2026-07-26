// Wheel-report pacer — keeps a fast flick from overrunning the PTY's
// 1022-byte read window (decision 175).
import { describe, expect, it } from "vitest";
import {
	createWheelPacer,
	WHEEL_REPORT_BURST,
	WHEEL_REPORTS_PER_SECOND,
} from "../wheel-pacer";

describe("createWheelPacer", () => {
	it("passes a small scroll through untouched", () => {
		const pacer = createWheelPacer();
		expect(pacer.take(3, 0)).toBe(3);
	});

	it("caps a single flush at the burst size", () => {
		const pacer = createWheelPacer();
		expect(pacer.take(500, 0)).toBe(WHEEL_REPORT_BURST);
	});

	it("drops the excess instead of queueing it", () => {
		const pacer = createWheelPacer();
		pacer.take(500, 0);
		// Same instant, bucket empty — nothing coasts on afterwards.
		expect(pacer.take(500, 0)).toBe(0);
	});

	it("refills at the configured rate", () => {
		const pacer = createWheelPacer(100, 16);
		pacer.take(16, 0);
		expect(pacer.take(16, 50)).toBe(5);
		expect(pacer.take(16, 150)).toBe(10);
	});

	it("never refills beyond the burst ceiling", () => {
		const pacer = createWheelPacer(100, 16);
		pacer.take(16, 0);
		expect(pacer.take(500, 10_000)).toBe(16);
	});

	it("keeps a one-second flood under the PTY read window", () => {
		const pacer = createWheelPacer();
		let sent = 0;
		// 120 Hz trackpad flick asking for far more than it can get.
		for (let ms = 0; ms <= 1000; ms += 8) sent += pacer.take(40, ms);
		expect(sent).toBeLessThanOrEqual(WHEEL_REPORTS_PER_SECOND + WHEEL_REPORT_BURST);
		// ~14 bytes per SGR report must stay well below 1022 bytes per read.
		expect(sent * 14).toBeLessThan(3000);
	});

	it("ignores non-positive requests and time going backwards", () => {
		const pacer = createWheelPacer();
		expect(pacer.take(0, 100)).toBe(0);
		expect(pacer.take(-5, 100)).toBe(0);
		pacer.take(WHEEL_REPORT_BURST, 100);
		expect(pacer.take(5, 50)).toBe(0);
	});
});
