/**
 * The rules a dragged time range has to obey, tested where they live: a
 * backwards drag, a handle dragged past its partner, a band pushed off the end
 * of history, and an interval squeezed below the floor.
 */

import { describe, expect, it } from "vitest";
import {
	MIN_RANGE_MS,
	isCustomRange,
	parseRangePeriod,
	rangePeriod,
	trafficPeriodBounds,
} from "../components/agent-traffic/traffic-period";
import {
	domainHolds,
	formatRangeLabel,
	moveRange,
	normalizeRange,
	rangeFraction,
	rangeStep,
	resizeRange,
	rulerDomain,
	rulerTicks,
	timeAtFraction,
} from "../components/agent-traffic/traffic-range";

const HOUR = 3600000;
const DOMAIN = { start: 0, end: 6 * HOUR };

describe("custom range as a period value", () => {
	it("round-trips through the same state the presets use", () => {
		const period = rangePeriod(1000, 5000);
		expect(parseRangePeriod(period)).toEqual({ start: 1000, end: 5000 });
		expect(isCustomRange(period)).toBe(true);
		expect(trafficPeriodBounds(period, Date.now())).toEqual({
			start: 1000,
			end: 5000,
		});
	});

	it("leaves every preset alone", () => {
		for (const preset of ["hour", "day", "all", "2026-09-06"])
			expect(isCustomRange(preset)).toBe(false);
		expect(trafficPeriodBounds("hour", 10 * HOUR).start).toBe(9 * HOUR);
	});

	it("refuses a value that is not an interval", () => {
		expect(parseRangePeriod("range:abc-def")).toBeNull();
		expect(parseRangePeriod("range:5000-1000")).toBeNull();
		expect(parseRangePeriod("range:1000-1000")).toBeNull();
	});
});

describe("normalizeRange", () => {
	it("reads a backwards drag as the same interval", () => {
		expect(normalizeRange(4 * HOUR, HOUR, DOMAIN)).toEqual({
			start: HOUR,
			end: 4 * HOUR,
		});
	});

	it("clamps both ends into the drawn span", () => {
		expect(normalizeRange(-HOUR, 99 * HOUR, DOMAIN)).toEqual(DOMAIN);
	});

	it("grows a too-short interval away from the anchor", () => {
		const anchored = normalizeRange(3 * HOUR, 3 * HOUR - 1000, DOMAIN, 3 * HOUR);
		expect(anchored.end).toBe(3 * HOUR);
		expect(anchored.end - anchored.start).toBe(MIN_RANGE_MS);
	});

	it("keeps the floor inside the domain at its right edge", () => {
		const pinned = normalizeRange(DOMAIN.end, DOMAIN.end, DOMAIN, DOMAIN.end);
		expect(pinned.end).toBe(DOMAIN.end);
		expect(pinned.end - pinned.start).toBe(MIN_RANGE_MS);
	});
});

describe("moveRange", () => {
	const band = { start: 2 * HOUR, end: 3 * HOUR };

	it("keeps the length while sliding", () => {
		expect(moveRange(band, HOUR, DOMAIN)).toEqual({
			start: 3 * HOUR,
			end: 4 * HOUR,
		});
	});

	it("stops at the edges instead of shortening", () => {
		expect(moveRange(band, -99 * HOUR, DOMAIN)).toEqual({
			start: 0,
			end: HOUR,
		});
		expect(moveRange(band, 99 * HOUR, DOMAIN)).toEqual({
			start: 5 * HOUR,
			end: 6 * HOUR,
		});
	});

	it("survives being moved back and forth many times", () => {
		let range = band;
		for (let i = 0; i < 40; i++) range = moveRange(range, -HOUR, DOMAIN);
		for (let i = 0; i < 40; i++) range = moveRange(range, HOUR, DOMAIN);
		expect(range.end - range.start).toBe(HOUR);
		expect(range.end).toBe(DOMAIN.end);
	});
});

describe("resizeRange", () => {
	const band = { start: 2 * HOUR, end: 4 * HOUR };

	it("moves the edge it was given", () => {
		expect(resizeRange(band, "start", HOUR, DOMAIN).range).toEqual({
			start: HOUR,
			end: 4 * HOUR,
		});
	});

	it("hands the pointer the other edge when it crosses over", () => {
		const crossed = resizeRange(band, "end", HOUR, DOMAIN);
		expect(crossed.edge).toBe("start");
		expect(crossed.range).toEqual({ start: HOUR, end: 2 * HOUR });
	});

	it("never squeezes the interval below the floor", () => {
		const squeezed = resizeRange(band, "start", 4 * HOUR, DOMAIN).range;
		expect(squeezed.end - squeezed.start).toBeGreaterThanOrEqual(MIN_RANGE_MS);
	});

	it("stays inside the drawn span when dragged past its end", () => {
		const pushed = resizeRange(band, "end", 99 * HOUR, DOMAIN).range;
		expect(pushed.end).toBe(DOMAIN.end);
	});
});

describe("rulerDomain", () => {
	const now = 100 * HOUR;

	it("draws context around a short window instead of only the window", () => {
		const band = { start: now - HOUR, end: now };
		const domain = rulerDomain(band, now - 500 * HOUR, now);
		expect(domain.end).toBe(now);
		expect(domain.end - domain.start).toBe(3 * HOUR);
	});

	it("never draws earlier than the oldest instant loaded", () => {
		const band = { start: now - HOUR, end: now };
		const domain = rulerDomain(band, now - 2 * HOUR, now);
		expect(domain.start).toBe(now - 2 * HOUR);
	});

	it("lets a window that covers all of history fill the ruler", () => {
		const oldest = now - 20 * HOUR;
		const domain = rulerDomain({ start: oldest, end: now }, oldest, now);
		expect(domain).toEqual({ start: oldest, end: now });
	});

	it("always contains the window it was given", () => {
		const band = { start: now - 80 * HOUR, end: now - 56 * HOUR };
		const domain = rulerDomain(band, now - 200 * HOUR, now);
		expect(domain.start).toBeLessThanOrEqual(band.start);
		expect(domain.end).toBeGreaterThanOrEqual(band.end);
	});
});

describe("domainHolds", () => {
	it("keeps a scale that still shows the band big enough to grab", () => {
		expect(domainHolds(DOMAIN, { start: HOUR, end: 2 * HOUR })).toBe(true);
	});

	it("gives up when the band leaves the drawn span", () => {
		expect(domainHolds(DOMAIN, { start: -HOUR, end: HOUR })).toBe(false);
	});

	it("gives up when the band would be a sliver", () => {
		expect(domainHolds(DOMAIN, { start: 0, end: MIN_RANGE_MS })).toBe(false);
	});
});

describe("ruler geometry", () => {
	it("maps instants to the track and back", () => {
		expect(rangeFraction(3 * HOUR, DOMAIN)).toBeCloseTo(0.5);
		expect(timeAtFraction(0.5, DOMAIN)).toBe(3 * HOUR);
	});

	it("clamps anything outside the drawn span", () => {
		expect(rangeFraction(-HOUR, DOMAIN)).toBe(0);
		expect(rangeFraction(99 * HOUR, DOMAIN)).toBe(1);
		expect(timeAtFraction(2, DOMAIN)).toBe(DOMAIN.end);
	});

	it("says nothing about an empty span rather than dividing by it", () => {
		expect(rangeFraction(5, { start: 5, end: 5 })).toBe(0);
		expect(rulerTicks({ start: 5, end: 5 })).toEqual([]);
	});

	it("labels round instants, and not too many of them", () => {
		const ticks = rulerTicks({ start: 0, end: 6 * HOUR }, 4);
		expect(ticks.length).toBeLessThanOrEqual(5);
		expect(ticks.length).toBeGreaterThan(0);
	});

	it("steps by a share of what is drawn, never finer than the floor", () => {
		expect(rangeStep(DOMAIN)).toBe(Math.round((6 * HOUR) / 100));
		expect(rangeStep({ start: 0, end: 2 * MIN_RANGE_MS })).toBe(MIN_RANGE_MS);
	});
});

describe("formatRangeLabel", () => {
	const day = (iso: string) => new Date(iso).getTime();

	it("drops the date when both ends are today", () => {
		const start = day("2026-09-12T10:00:00");
		const label = formatRangeLabel(
			{ start, end: start + HOUR },
			"en-US",
			new Date(start),
		);
		expect(label).not.toMatch(/Sep/);
		expect(label).toContain("–");
	});

	it("names the day when the interval is not today", () => {
		const start = day("2026-09-10T10:00:00");
		const label = formatRangeLabel(
			{ start, end: start + HOUR },
			"en-US",
			new Date(day("2026-09-12T10:00:00")),
		);
		expect(label).toMatch(/Sep/);
	});

	it("names both days when the interval crosses midnight", () => {
		const start = day("2026-09-10T23:00:00");
		const label = formatRangeLabel(
			{ start, end: start + 2 * HOUR },
			"en-US",
			new Date(start),
		);
		expect(label.match(/Sep/g)).toHaveLength(2);
	});
});
