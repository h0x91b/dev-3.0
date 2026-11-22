import { describe, it, expect } from "vitest";
import { ageParts, compactAge, freshness, relativeAge } from "../statusAge";

const NOW = new Date("2026-06-15T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("ageParts", () => {
	it("returns null without a timestamp", () => {
		expect(ageParts(undefined, NOW)).toBeNull();
		expect(ageParts(null, NOW)).toBeNull();
	});

	it("returns null for an invalid timestamp", () => {
		expect(ageParts("not-a-date", NOW)).toBeNull();
	});

	it("clamps future timestamps to 0s", () => {
		expect(ageParts(ago(-5 * SEC), NOW)).toEqual({ value: 0, unit: "s" });
	});

	it("reports seconds below a minute", () => {
		expect(ageParts(ago(0), NOW)).toEqual({ value: 0, unit: "s" });
		expect(ageParts(ago(25 * SEC), NOW)).toEqual({ value: 25, unit: "s" });
		expect(ageParts(ago(59 * SEC), NOW)).toEqual({ value: 59, unit: "s" });
	});

	it("reports minutes below an hour", () => {
		expect(ageParts(ago(MIN), NOW)).toEqual({ value: 1, unit: "m" });
		expect(ageParts(ago(59 * MIN), NOW)).toEqual({ value: 59, unit: "m" });
	});

	it("reports hours below a day", () => {
		expect(ageParts(ago(HOUR), NOW)).toEqual({ value: 1, unit: "h" });
		expect(ageParts(ago(7 * HOUR), NOW)).toEqual({ value: 7, unit: "h" });
		expect(ageParts(ago(23 * HOUR), NOW)).toEqual({ value: 23, unit: "h" });
	});

	it("reports days below a month", () => {
		expect(ageParts(ago(DAY), NOW)).toEqual({ value: 1, unit: "d" });
		expect(ageParts(ago(13 * DAY), NOW)).toEqual({ value: 13, unit: "d" });
		expect(ageParts(ago(29 * DAY), NOW)).toEqual({ value: 29, unit: "d" });
	});

	it("reports months below a year", () => {
		expect(ageParts(ago(30 * DAY), NOW)).toEqual({ value: 1, unit: "M" });
		expect(ageParts(ago(7 * 30 * DAY), NOW)).toEqual({ value: 7, unit: "M" });
	});

	it("reports years past 12 months", () => {
		expect(ageParts(ago(365 * DAY), NOW)).toEqual({ value: 1, unit: "y" });
		expect(ageParts(ago(3 * 365 * DAY), NOW)).toEqual({ value: 3, unit: "y" });
	});

	it("does not report 0y in the 360–364 day gap between 12 months and a 365-day year", () => {
		// 12 * 30-day months = 360 days, but a year was 365 days: the 360–364 day
		// window fell through to `floor(days / 365) = 0` and rendered "0y".
		for (let d = 360; d <= 364; d++) {
			const part = ageParts(ago(d * DAY), NOW);
			expect(part).toEqual({ value: 1, unit: "y" });
		}
	});
});

describe("compactAge", () => {
	it("returns an empty string without a timestamp", () => {
		expect(compactAge(undefined, NOW)).toBe("");
	});

	it("formats each tier as digit(s)+letter", () => {
		expect(compactAge(ago(25 * SEC), NOW)).toBe("25s");
		expect(compactAge(ago(5 * MIN), NOW)).toBe("5m");
		expect(compactAge(ago(7 * HOUR), NOW)).toBe("7h");
		expect(compactAge(ago(13 * DAY), NOW)).toBe("13d");
		expect(compactAge(ago(7 * 30 * DAY), NOW)).toBe("7mo");
		expect(compactAge(ago(3 * 365 * DAY), NOW)).toBe("3y");
	});
});

describe("freshness", () => {
	it("returns null without a usable timestamp", () => {
		expect(freshness(undefined, NOW)).toBeNull();
		expect(freshness("not-a-date", NOW)).toBeNull();
	});

	it("splits elapsed time into live / recent / today / stale at 15m, 2h and 24h", () => {
		expect(freshness(ago(0), NOW)).toBe("live");
		expect(freshness(ago(15 * MIN - SEC), NOW)).toBe("live");
		expect(freshness(ago(15 * MIN), NOW)).toBe("recent");
		expect(freshness(ago(2 * HOUR - SEC), NOW)).toBe("recent");
		expect(freshness(ago(2 * HOUR), NOW)).toBe("today");
		expect(freshness(ago(DAY - SEC), NOW)).toBe("today");
		expect(freshness(ago(DAY), NOW)).toBe("stale");
	});

	it("treats a future timestamp as live", () => {
		expect(freshness(ago(-5 * MIN), NOW)).toBe("live");
	});
});

describe("relativeAge", () => {
	it("returns null without a usable timestamp", () => {
		expect(relativeAge(undefined, NOW)).toBeNull();
		expect(relativeAge("not-a-date", NOW)).toBeNull();
	});

	it("reads under a minute, and the future, as now", () => {
		expect(relativeAge(ago(30 * SEC), NOW)).toEqual({ unit: "now" });
		expect(relativeAge(ago(-5 * MIN), NOW)).toEqual({ unit: "now" });
	});

	it("speaks minutes and hours", () => {
		expect(relativeAge(ago(MIN), NOW)).toEqual({ unit: "minute", value: 1 });
		expect(relativeAge(ago(2 * HOUR), NOW)).toEqual({ unit: "hour", value: 2 });
	});

	it("reads one day as yesterday and 2–6 days in days", () => {
		expect(relativeAge(ago(DAY + HOUR), NOW)).toEqual({ unit: "yesterday" });
		expect(relativeAge(ago(6 * DAY), NOW)).toEqual({ unit: "day", value: 6 });
	});

	it("switches to weeks at seven days, then months and years", () => {
		expect(relativeAge(ago(7 * DAY), NOW)).toEqual({ unit: "week", value: 1 });
		expect(relativeAge(ago(29 * DAY), NOW)).toEqual({ unit: "week", value: 4 });
		expect(relativeAge(ago(60 * DAY), NOW)).toEqual({ unit: "month", value: 2 });
		expect(relativeAge(ago(800 * DAY), NOW)).toEqual({ unit: "year", value: 2 });
	});
});
