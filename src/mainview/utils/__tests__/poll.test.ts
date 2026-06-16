import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeJitteredDelay, startVisibilityAwarePoll } from "../poll";

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
	document.dispatchEvent(new Event("visibilitychange"));
}

describe("computeJitteredDelay", () => {
	it("returns the base interval with no jitter", () => {
		expect(computeJitteredDelay(1000, 0, () => 0.5)).toBe(1000);
	});

	it("applies symmetric jitter at the extremes", () => {
		expect(computeJitteredDelay(1000, 0.2, () => 0)).toBe(800); // -20%
		expect(computeJitteredDelay(1000, 0.2, () => 1)).toBe(1200); // +20%
	});

	it("clamps the jitter ratio to [0,1] and never goes negative", () => {
		expect(computeJitteredDelay(1000, 5, () => 0)).toBeGreaterThanOrEqual(0);
	});
});

describe("startVisibilityAwarePoll", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setVisibility("visible");
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs once on start and then on the interval", async () => {
		const fn = vi.fn().mockResolvedValue(undefined);
		const stop = startVisibilityAwarePoll({ fn, intervalMs: 1000, jitterRatio: 0, random: () => 0.5 });

		await vi.advanceTimersByTimeAsync(0); // start tick
		expect(fn).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1000);
		expect(fn).toHaveBeenCalledTimes(2);

		stop();
	});

	it("stops ticking while hidden and resumes with one refresh on visible", async () => {
		const fn = vi.fn().mockResolvedValue(undefined);
		const stop = startVisibilityAwarePoll({ fn, intervalMs: 1000, jitterRatio: 0, random: () => 0.5 });

		await vi.advanceTimersByTimeAsync(0);
		expect(fn).toHaveBeenCalledTimes(1);

		setVisibility("hidden");
		await vi.advanceTimersByTimeAsync(5000); // no ticks while hidden
		expect(fn).toHaveBeenCalledTimes(1);

		setVisibility("visible"); // one immediate refresh
		await vi.advanceTimersByTimeAsync(0);
		expect(fn).toHaveBeenCalledTimes(2);

		stop();
	});

	it("does not run on start when hidden", async () => {
		setVisibility("hidden");
		const fn = vi.fn().mockResolvedValue(undefined);
		const stop = startVisibilityAwarePoll({ fn, intervalMs: 1000, jitterRatio: 0, random: () => 0.5 });

		await vi.advanceTimersByTimeAsync(2000);
		expect(fn).not.toHaveBeenCalled();

		stop();
	});

	it("stops firing after cleanup", async () => {
		const fn = vi.fn().mockResolvedValue(undefined);
		const stop = startVisibilityAwarePoll({ fn, intervalMs: 1000, jitterRatio: 0, random: () => 0.5 });

		await vi.advanceTimersByTimeAsync(0);
		expect(fn).toHaveBeenCalledTimes(1);
		stop();

		await vi.advanceTimersByTimeAsync(5000);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
