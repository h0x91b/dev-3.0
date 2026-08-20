import { describe, it, expect, vi } from "vitest";
import {
	createQualityWindow,
	verdictFor,
	percentileOf,
	RTT_BAD_MS,
	RTT_DEGRADED_MS,
	JITTER_BAD_MS,
	JITTER_DEGRADED_MS,
} from "../../shared/connection-quality";
import { createConnectionQualitySampler } from "../connection-quality";

describe("connection-quality window", () => {
	it("reports nothing until a sample answers", () => {
		const w = createQualityWindow();
		const stats = w.stats();
		expect(stats.count).toBe(0);
		expect(stats.p50).toBe(0);
		expect(stats.verdict).toBe("good");
	});

	it("takes the median as the headline, not the mean", () => {
		const w = createQualityWindow();
		// One spike must not move the headline; a mean would land near 240.
		for (const rttMs of [40, 42, 44, 46, 1200]) w.add({ rttMs, serverMs: 0 });
		expect(w.stats().p50).toBe(44);
	});

	it("splits our own time from the network using the server span", () => {
		const w = createQualityWindow();
		w.add({ rttMs: 100, serverMs: 30 });
		w.add({ rttMs: 100, serverMs: 30 });
		const stats = w.stats();
		expect(stats.serverP50).toBe(30);
		expect(stats.networkP50).toBe(70);
	});

	it("leaves the split null rather than guessing when no span arrived", () => {
		const w = createQualityWindow();
		w.add({ rttMs: 100, serverMs: null });
		const stats = w.stats();
		expect(stats.serverP50).toBeNull();
		expect(stats.networkP50).toBeNull();
	});

	it("counts a loss instead of averaging in a huge number", () => {
		const w = createQualityWindow();
		w.add({ rttMs: 50, serverMs: 0 });
		w.addLoss();
		const stats = w.stats();
		expect(stats.count).toBe(1);
		expect(stats.lost).toBe(1);
		expect(stats.p50).toBe(50);
		// 1 of 2 attempts lost is well past the bad threshold.
		expect(stats.verdict).toBe("bad");
	});

	it("calls a link with nothing but losses bad, not good", () => {
		const w = createQualityWindow();
		w.addLoss();
		expect(w.stats().verdict).toBe("bad");
	});

	it("ages losses out of the window like samples", () => {
		const w = createQualityWindow(3);
		w.addLoss();
		w.add({ rttMs: 10, serverMs: 0 });
		w.add({ rttMs: 10, serverMs: 0 });
		w.add({ rttMs: 10, serverMs: 0 });
		expect(w.stats().lost).toBe(0);
	});

	it("rejects a nonsense round trip instead of recording it", () => {
		const w = createQualityWindow();
		w.add({ rttMs: Number.NaN, serverMs: null });
		w.add({ rttMs: -5, serverMs: null });
		expect(w.stats().count).toBe(0);
	});

	it("measures jitter as deviation from the median, so a flat link reads zero", () => {
		const w = createQualityWindow();
		for (const rttMs of [50, 50, 50, 50]) w.add({ rttMs, serverMs: 0 });
		expect(w.stats().jitter).toBe(0);
	});

	it("keeps the sparkline in arrival order, newest last", () => {
		const w = createQualityWindow();
		for (const rttMs of [10, 30, 20]) w.add({ rttMs, serverMs: null });
		expect(w.stats().recent).toEqual([10, 30, 20]);
	});
});

describe("verdictFor", () => {
	it("takes the worse of latency and jitter", () => {
		expect(verdictFor(10, 5, 0)).toBe("good");
		// Steady but slow.
		expect(verdictFor(RTT_DEGRADED_MS, 0, 0)).toBe("degraded");
		expect(verdictFor(RTT_BAD_MS, 0, 0)).toBe("bad");
		// Fast but jumpy — the case a latency-only verdict would call fine.
		expect(verdictFor(20, JITTER_DEGRADED_MS, 0)).toBe("degraded");
		expect(verdictFor(20, JITTER_BAD_MS, 0)).toBe("bad");
	});

	it("calls heavy loss bad regardless of how fast the survivors were", () => {
		expect(verdictFor(5, 0, 0.5)).toBe("bad");
	});
});

describe("percentileOf", () => {
	it("uses nearest rank and survives an empty set", () => {
		expect(percentileOf([], 0.5)).toBe(0);
		expect(percentileOf([1, 2, 3, 4], 0.5)).toBe(2);
		expect(percentileOf([1, 2, 3, 4], 0.95)).toBe(4);
	});
});

describe("connection-quality sampler", () => {
	it("does nothing at all without a probe (the desktop bridge)", () => {
		const setIntervalFn = vi.fn();
		const sampler = createConnectionQualitySampler({ probe: null, setIntervalFn: setIntervalFn as any });
		expect(setIntervalFn).not.toHaveBeenCalled();
		expect(sampler.stats().count).toBe(0);
	});

	it("publishes a sample and its server span", async () => {
		const onStats = vi.fn();
		const sampler = createConnectionQualitySampler({
			probe: async () => ({ rttMs: 80, serverMs: 5 }),
			setIntervalFn: (() => 0) as any,
			onStats,
		});
		await sampler.sampleNow();
		expect(sampler.stats().p50).toBe(80);
		expect(sampler.stats().networkP50).toBe(75);
		expect(onStats).toHaveBeenCalledTimes(1);
	});

	it("records a rejected probe as a loss, not as an error", async () => {
		const sampler = createConnectionQualitySampler({
			probe: async () => { throw new Error("socket not open"); },
			setIntervalFn: (() => 0) as any,
		});
		await sampler.sampleNow();
		expect(sampler.stats().lost).toBe(1);
		expect(sampler.stats().count).toBe(0);
	});

	it("records a stalled probe as a loss once the timeout wins", async () => {
		const sampler = createConnectionQualitySampler({
			// Never settles — the race must be decided by the timeout leg.
			probe: () => new Promise(() => {}),
			setIntervalFn: (() => 0) as any,
			setTimeoutFn: ((fn: () => void) => { fn(); return 0; }) as any,
		});
		await sampler.sampleNow();
		expect(sampler.stats().lost).toBe(1);
	});

	it("does not sample while the page is hidden", async () => {
		const probe = vi.fn(async () => ({ rttMs: 10, serverMs: 0 }));
		const sampler = createConnectionQualitySampler({
			probe,
			setIntervalFn: (() => 0) as any,
			isVisible: () => false,
		});
		await sampler.sampleNow();
		expect(probe).not.toHaveBeenCalled();
	});

	it("never runs two probes at once, so a slow link cannot pile up requests", async () => {
		let started = 0;
		const releases: (() => void)[] = [];
		const sampler = createConnectionQualitySampler({
			probe: () => {
				started += 1;
				return new Promise<{ rttMs: number; serverMs: number | null }>((resolve) => {
					releases.push(() => resolve({ rttMs: 10, serverMs: 0 }));
				});
			},
			setIntervalFn: (() => 0) as any,
		});
		const first = sampler.sampleNow();
		await sampler.sampleNow();
		expect(started).toBe(1);
		for (const release of releases) release();
		await first;
		expect(started).toBe(1);
	});

	it("stops sampling after stop()", async () => {
		const probe = vi.fn(async () => ({ rttMs: 10, serverMs: 0 }));
		const sampler = createConnectionQualitySampler({ probe, setIntervalFn: (() => 0) as any });
		sampler.stop();
		await sampler.sampleNow();
		expect(probe).not.toHaveBeenCalled();
	});
});

describe("connection-quality sampler housekeeping", () => {
	it("clears the deadline timer once the answer arrives", async () => {
		const cleared: unknown[] = [];
		const sampler = createConnectionQualitySampler({
			probe: async () => ({ rttMs: 12, serverMs: 1 }),
			setIntervalFn: (() => 0) as any,
			setTimeoutFn: (() => "deadline-1") as any,
			clearTimeoutFn: ((id: unknown) => cleared.push(id)) as any,
		});
		await sampler.sampleNow();
		// Left pending, one per sample, this is what hangs a fake-timer test.
		expect(cleared).toEqual(["deadline-1"]);
	});

	it("clears the deadline timer after a loss too", async () => {
		const cleared: unknown[] = [];
		const sampler = createConnectionQualitySampler({
			probe: async () => {
				throw new Error("socket gone");
			},
			setIntervalFn: (() => 0) as any,
			setTimeoutFn: (() => "deadline-2") as any,
			clearTimeoutFn: ((id: unknown) => cleared.push(id)) as any,
		});
		await sampler.sampleNow();
		expect(cleared).toEqual(["deadline-2"]);
		expect(sampler.stats().lost).toBe(1);
	});
});
