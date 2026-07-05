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
	it("parses a full weekly rule", () => {
		const spec = parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30");
		expect(spec.freq).toBe("WEEKLY");
		expect(spec.interval).toBe(2);
		expect(spec.byDay).toEqual([1, 5]);
		expect(spec.byHour).toEqual([9]);
		expect(spec.byMinute).toEqual([30]);
	});

	it("accepts the RRULE: prefix and lowercase keys", () => {
		const spec = parseRRule("rrule:freq=daily;byhour=7");
		expect(spec.freq).toBe("DAILY");
		expect(spec.byHour).toEqual([7]);
	});

	it("defaults interval=1, hour=9, minute=0", () => {
		const spec = parseRRule("FREQ=DAILY");
		expect(spec.interval).toBe(1);
		expect(spec.byHour).toEqual([9]);
		expect(spec.byMinute).toEqual([0]);
	});

	it("dedupes and sorts list values", () => {
		const spec = parseRRule("FREQ=WEEKLY;BYDAY=FR,MO,FR");
		expect(spec.byDay).toEqual([1, 5]);
	});

	it("rejects missing FREQ", () => {
		expect(() => parseRRule("INTERVAL=2")).toThrow(RRuleParseError);
	});

	it("rejects unsupported FREQ", () => {
		expect(() => parseRRule("FREQ=YEARLY")).toThrow(RRuleParseError);
	});

	it("rejects BYDAY with non-weekly freq", () => {
		expect(() => parseRRule("FREQ=DAILY;BYDAY=MO")).toThrow(RRuleParseError);
	});

	it("rejects BYMONTHDAY with non-monthly freq", () => {
		expect(() => parseRRule("FREQ=WEEKLY;BYMONTHDAY=5")).toThrow(RRuleParseError);
	});

	it("rejects ordinal BYDAY values", () => {
		expect(() => parseRRule("FREQ=WEEKLY;BYDAY=1MO")).toThrow(RRuleParseError);
	});

	it("rejects unknown parts and out-of-range values", () => {
		expect(() => parseRRule("FREQ=DAILY;COUNT=3")).toThrow(RRuleParseError);
		expect(() => parseRRule("FREQ=DAILY;BYHOUR=24")).toThrow(RRuleParseError);
		expect(() => parseRRule("FREQ=DAILY;BYMINUTE=60")).toThrow(RRuleParseError);
		expect(() => parseRRule("FREQ=DAILY;INTERVAL=0")).toThrow(RRuleParseError);
	});

	it("round-trips through formatRRule", () => {
		const spec = parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30");
		expect(parseRRule(formatRRule(spec))).toEqual(spec);
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
	it("converts UTC wall time trivially", () => {
		const d = zonedTimeToUtc(2026, 7, 5, 12, 30, UTC);
		expect(d.toISOString()).toBe("2026-07-05T12:30:00.000Z");
	});

	it("converts New York summer time (EDT, UTC-4)", () => {
		const d = zonedTimeToUtc(2026, 7, 5, 9, 0, NY);
		expect(d.toISOString()).toBe("2026-07-05T13:00:00.000Z");
	});

	it("converts New York winter time (EST, UTC-5)", () => {
		const d = zonedTimeToUtc(2026, 1, 5, 9, 0, NY);
		expect(d.toISOString()).toBe("2026-01-05T14:00:00.000Z");
	});

	it("round-trips through wallClockInZone", () => {
		const d = zonedTimeToUtc(2026, 3, 15, 22, 45, "Asia/Tokyo");
		const w = wallClockInZone(d, "Asia/Tokyo");
		expect([w.year, w.month, w.day, w.hour, w.minute]).toEqual([2026, 3, 15, 22, 45]);
	});
});

describe("nextOccurrence — DAILY", () => {
	const spec = parseRRule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0");

	it("returns the same day when the time is still ahead", () => {
		const next = nextOccurrence(spec, new Date("2026-07-05T05:00:00Z"), UTC, anchor);
		expect(next?.toISOString()).toBe("2026-07-05T09:00:00.000Z");
	});

	it("rolls to the next day when the time has passed", () => {
		const next = nextOccurrence(spec, new Date("2026-07-05T10:00:00Z"), UTC, anchor);
		expect(next?.toISOString()).toBe("2026-07-06T09:00:00.000Z");
	});

	it("is strictly after (an exact hit rolls forward)", () => {
		const next = nextOccurrence(spec, new Date("2026-07-05T09:00:00Z"), UTC, anchor);
		expect(next?.toISOString()).toBe("2026-07-06T09:00:00.000Z");
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
	it("finds the next matching weekday", () => {
		const spec = parseRRule("FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0");
		// 2026-07-05 is a Sunday → next Friday is 2026-07-10.
		const next = nextOccurrence(spec, new Date("2026-07-05T00:00:00Z"), UTC, anchor);
		expect(next?.toISOString()).toBe("2026-07-10T17:00:00.000Z");
	});

	it("supports multiple BYDAY values", () => {
		const spec = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=0");
		const mon = nextOccurrence(spec, new Date("2026-07-05T00:00:00Z"), UTC, anchor);
		expect(mon?.toISOString()).toBe("2026-07-06T08:00:00.000Z"); // Monday
		const wed = nextOccurrence(spec, mon!, UTC, anchor);
		expect(wed?.toISOString()).toBe("2026-07-08T08:00:00.000Z"); // Wednesday
	});

	it("defaults BYDAY to the anchor's weekday", () => {
		const spec = parseRRule("FREQ=WEEKLY;BYHOUR=12;BYMINUTE=0");
		// anchor 2026-01-01 is a Thursday.
		const next = nextOccurrence(spec, new Date("2026-07-05T00:00:00Z"), UTC, anchor);
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
	it("fires on BYMONTHDAY", () => {
		const spec = parseRRule("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=6;BYMINUTE=0");
		const next = nextOccurrence(spec, new Date("2026-07-05T00:00:00Z"), UTC, anchor);
		expect(next?.toISOString()).toBe("2026-08-01T06:00:00.000Z");
	});

	it("skips months without the day (BYMONTHDAY=31)", () => {
		const spec = parseRRule("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=0;BYMINUTE=0");
		const next = nextOccurrence(spec, new Date("2026-04-01T00:00:00Z"), UTC, anchor);
		// April has 30 days → next 31st is May 31.
		expect(next?.toISOString()).toBe("2026-05-31T00:00:00.000Z");
	});

	it("defaults to the anchor's day of month", () => {
		const spec = parseRRule("FREQ=MONTHLY;BYHOUR=0;BYMINUTE=0");
		// anchor day = 1.
		const next = nextOccurrence(spec, new Date("2026-07-05T00:00:00Z"), UTC, anchor);
		expect(next?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
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
	it("lists missed daily occurrences in an offline window", () => {
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
	});

	it("caps the scan at the limit", () => {
		const spec = parseRRule("FREQ=HOURLY;BYMINUTE=0");
		const occ = occurrencesBetween(
			spec,
			new Date("2026-01-01T00:00:00Z"),
			new Date("2026-03-01T00:00:00Z"),
			UTC,
			anchor,
			10,
		);
		expect(occ).toHaveLength(10);
	});
});
