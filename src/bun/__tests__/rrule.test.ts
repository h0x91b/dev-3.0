import { describe, expect, it } from "vitest";
import {
	RRuleParseError,
	formatRRule,
	isValidTimezone,
	nextOccurrence,
	occurrencesBetween,
	parseRRule,
	wallClockInZone,
	zonedTimeToUtc,
} from "../../shared/rrule";

const UTC = "UTC";
const NY = "America/New_York";
const anchor = new Date("2026-01-01T00:00:00Z");

describe("parseRRule", () => {
	it("parses a full weekly rule, dedupes and sorts list values, and round-trips through formatRRule", () => {
		const spec = parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30");
		expect(spec.freq).toBe("WEEKLY");
		expect(spec.interval).toBe(2);
		expect(spec.byDay).toEqual([1, 5]);
		expect(spec.byHour).toEqual([9]);
		expect(spec.byMinute).toEqual([30]);
		expect(parseRRule(formatRRule(spec))).toEqual(spec);
		expect(parseRRule("FREQ=WEEKLY;BYDAY=FR,MO,FR").byDay).toEqual([1, 5]);
	});

	it("accepts the RRULE: prefix and lowercase keys, and defaults interval=1, hour=9, minute=0", () => {
		const spec = parseRRule("rrule:freq=daily;byhour=7");
		expect(spec.freq).toBe("DAILY");
		expect(spec.byHour).toEqual([7]);

		const defaults = parseRRule("FREQ=DAILY");
		expect(defaults.interval).toBe(1);
		expect(defaults.byHour).toEqual([9]);
		expect(defaults.byMinute).toEqual([0]);
	});

	it("rejects missing/unsupported FREQ, BY* parts on the wrong freq, ordinals, unknown parts and out-of-range values", () => {
		for (const rule of [
			"INTERVAL=2",
			"FREQ=YEARLY",
			"FREQ=DAILY;BYDAY=MO",
			"FREQ=WEEKLY;BYMONTHDAY=5",
			"FREQ=WEEKLY;BYDAY=1MO",
			"FREQ=DAILY;COUNT=3",
			"FREQ=DAILY;BYHOUR=24",
			"FREQ=DAILY;BYMINUTE=60",
			"FREQ=DAILY;INTERVAL=0",
		]) {
			expect(() => parseRRule(rule), rule).toThrow(RRuleParseError);
		}
	});
});

describe("isValidTimezone", () => {
	it("accepts IANA names and rejects junk", () => {
		expect(isValidTimezone("Europe/Berlin")).toBe(true);
		expect(isValidTimezone("UTC")).toBe(true);
		expect(isValidTimezone("Not/AZone")).toBe(false);
	});
});

describe("zonedTimeToUtc / wallClockInZone", () => {
	it("converts UTC, New York summer (EDT) and winter (EST) wall time, and round-trips through wallClockInZone", () => {
		expect(zonedTimeToUtc(2026, 7, 5, 12, 30, UTC).toISOString()).toBe("2026-07-05T12:30:00.000Z");
		expect(zonedTimeToUtc(2026, 7, 5, 9, 0, NY).toISOString()).toBe("2026-07-05T13:00:00.000Z");
		expect(zonedTimeToUtc(2026, 1, 5, 9, 0, NY).toISOString()).toBe("2026-01-05T14:00:00.000Z");

		const d = zonedTimeToUtc(2026, 3, 15, 22, 45, "Asia/Tokyo");
		const w = wallClockInZone(d, "Asia/Tokyo");
		expect([w.year, w.month, w.day, w.hour, w.minute]).toEqual([2026, 3, 15, 22, 45]);
	});
});

describe("nextOccurrence — DAILY", () => {
	const spec = parseRRule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0");

	it("returns the same day while the time is ahead, and is strictly after (a passed time or exact hit rolls forward)", () => {
		expect(nextOccurrence(spec, new Date("2026-07-05T05:00:00Z"), UTC, anchor)?.toISOString()).toBe("2026-07-05T09:00:00.000Z");
		expect(nextOccurrence(spec, new Date("2026-07-05T10:00:00Z"), UTC, anchor)?.toISOString()).toBe("2026-07-06T09:00:00.000Z");
		expect(nextOccurrence(spec, new Date("2026-07-05T09:00:00Z"), UTC, anchor)?.toISOString()).toBe("2026-07-06T09:00:00.000Z");
	});

	it("respects INTERVAL=3 anchored to the automation creation day", () => {
		const spec3 = parseRRule("FREQ=DAILY;INTERVAL=3;BYHOUR=0;BYMINUTE=0");
		// anchor = Jan 1 → matching days are Jan 1, 4, 7, ...
		const next = nextOccurrence(spec3, new Date("2026-01-02T10:00:00Z"), UTC, anchor);
		expect(next?.toISOString()).toBe("2026-01-04T00:00:00.000Z");
	});

	it("fires at local time across a DST change (NY spring forward 2026-03-08)", () => {
		// 9:00 America/New_York is 14:00Z in winter, 13:00Z in summer.
		const before = nextOccurrence(spec, new Date("2026-03-07T00:00:00Z"), NY, anchor);
		expect(before?.toISOString()).toBe("2026-03-07T14:00:00.000Z");
		const after = nextOccurrence(spec, new Date("2026-03-09T00:00:00Z"), NY, anchor);
		expect(after?.toISOString()).toBe("2026-03-09T13:00:00.000Z");
	});
});

describe("nextOccurrence — WEEKLY", () => {
	it("walks multiple BYDAY values in order, and defaults BYDAY to the anchor's weekday", () => {
		const spec = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=0");
		// 2026-07-05 is a Sunday.
		const mon = nextOccurrence(spec, new Date("2026-07-05T00:00:00Z"), UTC, anchor);
		expect(mon?.toISOString()).toBe("2026-07-06T08:00:00.000Z"); // Monday
		const wed = nextOccurrence(spec, mon!, UTC, anchor);
		expect(wed?.toISOString()).toBe("2026-07-08T08:00:00.000Z"); // Wednesday

		const anchored = parseRRule("FREQ=WEEKLY;BYHOUR=12;BYMINUTE=0");
		// anchor 2026-01-01 is a Thursday.
		const next = nextOccurrence(anchored, new Date("2026-07-05T00:00:00Z"), UTC, anchor);
		expect(next?.toISOString()).toBe("2026-07-09T12:00:00.000Z"); // Thursday
	});

	it("respects INTERVAL=2 week phase from the anchor", () => {
		const spec = parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=0;BYMINUTE=0");
		// anchor week (Mon 2025-12-29) is even-phase → matching Mondays: Jan 12, Jan 26...
		const next = nextOccurrence(spec, new Date("2026-01-06T00:00:00Z"), UTC, anchor);
		expect(next?.toISOString()).toBe("2026-01-12T00:00:00.000Z");
		const after = nextOccurrence(spec, next!, UTC, anchor);
		expect(after?.toISOString()).toBe("2026-01-26T00:00:00.000Z");
	});
});

describe("nextOccurrence — MONTHLY", () => {
	it("fires on BYMONTHDAY, defaulting to the anchor's day of month", () => {
		const spec = parseRRule("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=6;BYMINUTE=0");
		expect(nextOccurrence(spec, new Date("2026-07-05T00:00:00Z"), UTC, anchor)?.toISOString()).toBe("2026-08-01T06:00:00.000Z");

		// anchor day = 1.
		const anchored = parseRRule("FREQ=MONTHLY;BYHOUR=0;BYMINUTE=0");
		expect(nextOccurrence(anchored, new Date("2026-07-05T00:00:00Z"), UTC, anchor)?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
	});

	it("skips months without the day (BYMONTHDAY=31)", () => {
		const spec = parseRRule("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=0;BYMINUTE=0");
		const next = nextOccurrence(spec, new Date("2026-04-01T00:00:00Z"), UTC, anchor);
		// April has 30 days → next 31st is May 31.
		expect(next?.toISOString()).toBe("2026-05-31T00:00:00.000Z");
	});
});

describe("nextOccurrence — HOURLY", () => {
	it("fires every N hours at the aligned minute", () => {
		const spec = parseRRule("FREQ=HOURLY;INTERVAL=6;BYMINUTE=15");
		const next = nextOccurrence(spec, new Date("2026-01-01T01:00:00Z"), UTC, anchor);
		// anchor hour = 00:00Z → matching hours 00, 06, 12...
		expect(next?.toISOString()).toBe("2026-01-01T06:15:00.000Z");
	});
});

describe("occurrencesBetween", () => {
	it("lists missed daily occurrences in an offline window, and caps the scan at the limit", () => {
		const spec = parseRRule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
		const occ = occurrencesBetween(
			spec,
			new Date("2026-07-01T09:00:00Z"),
			new Date("2026-07-04T10:00:00Z"),
			UTC,
			anchor,
		);
		expect(occ.map((d) => d.toISOString())).toEqual([
			"2026-07-02T09:00:00.000Z",
			"2026-07-03T09:00:00.000Z",
			"2026-07-04T09:00:00.000Z",
		]);

		const hourly = parseRRule("FREQ=HOURLY;BYMINUTE=0");
		const capped = occurrencesBetween(
			hourly,
			new Date("2026-01-01T00:00:00Z"),
			new Date("2026-03-01T00:00:00Z"),
			UTC,
			anchor,
			10,
		);
		expect(capped).toHaveLength(10);
	});
});
