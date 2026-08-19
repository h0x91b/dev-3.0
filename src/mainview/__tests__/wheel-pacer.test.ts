// Wheel-report pacer — keeps a fast flick from overrunning the PTY's
// 1022-byte read window (decision 175) while still delivering the whole flick:
// what the pace holds back is queued and drained, not thrown away.
import { describe, expect, it } from "vitest";
import {
	createWheelPacer,
	WHEEL_BACKLOG_MAX,
	WHEEL_REPORT_BURST,
	WHEEL_REPORTS_PER_SECOND,
} from "../wheel-pacer";

const DOWN = 1;
const UP = -1;

describe("createWheelPacer", () => {
	it("passes a small scroll through untouched", () => {
		const pacer = createWheelPacer();
		expect(pacer.take(3, DOWN, 0)).toBe(3);
		expect(pacer.pending()).toBe(0);
	});

	it("caps a single flush at the burst size", () => {
		const pacer = createWheelPacer();
		expect(pacer.take(500, DOWN, 0)).toBe(WHEEL_REPORT_BURST);
	});

	it("queues what the burst could not pass instead of dropping it", () => {
		const pacer = createWheelPacer();
		pacer.take(40, DOWN, 0);
		expect(pacer.pending()).toBe(40 - WHEEL_REPORT_BURST);
		expect(pacer.direction()).toBe(DOWN);
	});

	it("delivers the whole flick over time — the point of the backlog", () => {
		const pacer = createWheelPacer();
		let sent = pacer.take(60, DOWN, 0);
		for (let ms = 12; ms <= 1000 && pacer.pending() > 0; ms += 12) {
			sent += pacer.drain(ms);
		}
		expect(sent).toBe(60);
		expect(pacer.pending()).toBe(0);
		expect(pacer.direction()).toBe(0);
	});

	it("bounds the backlog so a scroll cannot coast for seconds", () => {
		const pacer = createWheelPacer();
		for (let i = 0; i < 20; i++) pacer.take(200, DOWN, 0);
		expect(pacer.pending()).toBeLessThanOrEqual(WHEEL_BACKLOG_MAX);
	});

	it("clears the backlog when the finger reverses", () => {
		const pacer = createWheelPacer();
		pacer.take(60, DOWN, 0);
		expect(pacer.pending()).toBeGreaterThan(0);
		pacer.take(2, UP, 0);
		expect(pacer.direction()).toBe(UP);
		// Only the two new upward lines can be outstanding, never the stale downs.
		expect(pacer.pending()).toBeLessThanOrEqual(2);
	});

	it("empties the backlog before the newest lines, keeping scroll order", () => {
		const pacer = createWheelPacer(100, 4);
		pacer.take(10, DOWN, 0); // 4 out, 6 queued
		expect(pacer.pending()).toBe(6);
		// A second later the bucket is full again: the queue goes first.
		expect(pacer.take(2, DOWN, 1000)).toBe(4);
		expect(pacer.pending()).toBe(4);
	});

	it("refills at the configured rate", () => {
		const pacer = createWheelPacer(100, 16);
		pacer.take(16, DOWN, 0);
		pacer.reset();
		expect(pacer.take(16, DOWN, 50)).toBe(5);
		pacer.reset();
		expect(pacer.take(16, DOWN, 150)).toBe(10);
	});

	it("never refills beyond the burst ceiling", () => {
		const pacer = createWheelPacer(100, 16);
		pacer.take(16, DOWN, 0);
		pacer.reset();
		expect(pacer.take(500, DOWN, 10_000)).toBe(16);
	});

	it("keeps a one-second flood under the PTY read window", () => {
		const pacer = createWheelPacer();
		let sent = 0;
		// 120 Hz trackpad flick asking for far more than it can get.
		for (let ms = 0; ms <= 1000; ms += 8) sent += pacer.take(40, DOWN, ms);
		expect(sent).toBeLessThanOrEqual(WHEEL_REPORTS_PER_SECOND + WHEEL_REPORT_BURST);
		// ~14 bytes per SGR report must stay well below 1022 bytes per read.
		expect(sent * 14).toBeLessThan(3000);
	});

	it("keeps a drained backlog under the same rate ceiling", () => {
		const pacer = createWheelPacer();
		let sent = pacer.take(WHEEL_BACKLOG_MAX * 2, DOWN, 0);
		for (let ms = 1; ms <= 1000; ms += 1) sent += pacer.drain(ms);
		expect(sent).toBeLessThanOrEqual(WHEEL_REPORTS_PER_SECOND + WHEEL_REPORT_BURST);
	});

	it("ignores non-positive requests, a zero direction, and time going backwards", () => {
		const pacer = createWheelPacer();
		expect(pacer.take(0, DOWN, 100)).toBe(0);
		expect(pacer.take(-5, DOWN, 100)).toBe(0);
		expect(pacer.take(5, 0, 100)).toBe(0);
		pacer.take(WHEEL_REPORT_BURST, DOWN, 100);
		pacer.reset();
		expect(pacer.take(5, DOWN, 50)).toBe(0);
	});

	it("drains nothing when nothing is queued", () => {
		const pacer = createWheelPacer();
		expect(pacer.drain(0)).toBe(0);
		expect(pacer.drain(10_000)).toBe(0);
	});

	it("forgets the backlog on reset — a new gesture starts clean", () => {
		const pacer = createWheelPacer();
		pacer.take(60, DOWN, 0);
		pacer.reset();
		expect(pacer.pending()).toBe(0);
		expect(pacer.direction()).toBe(0);
		expect(pacer.drain(1000)).toBe(0);
	});
});
