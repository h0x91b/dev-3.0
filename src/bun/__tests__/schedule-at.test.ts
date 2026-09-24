import { describe, expect, it } from "vitest";
import { describeScheduledTime, parseScheduleAt } from "../../shared/schedule-at";

const utc = (iso: string) => new Date(iso).getTime();

describe("parseScheduleAt — explicit zones are independent of the machine's TZ", () => {
	it("HH:MMZ is the next occurrence in UTC, today when still ahead", () => {
		expect(parseScheduleAt("06:00Z", utc("2026-09-24T05:59:00Z"))?.toISOString()).toBe("2026-09-24T06:00:00.000Z");
	});

	it("HH:MMZ rolls to tomorrow once that UTC time has passed (and at exactly now)", () => {
		expect(parseScheduleAt("06:00Z", utc("2026-09-24T06:00:00Z"))?.toISOString()).toBe("2026-09-25T06:00:00.000Z");
		expect(parseScheduleAt("06:00 UTC", utc("2026-09-24T07:00:00Z"))?.toISOString()).toBe("2026-09-25T06:00:00.000Z");
	});

	it("a positive offset whose local day is already tomorrow picks that day's wall time", () => {
		// 22:30Z is 01:30 next day at +03:00; 06:00+03:00 that day is 03:00Z.
		expect(parseScheduleAt("06:00+03:00", utc("2026-09-24T22:30:00Z"))?.toISOString()).toBe("2026-09-25T03:00:00.000Z");
	});

	it("a negative offset across the UTC midnight boundary", () => {
		// 02:00Z is 22:00 the previous day at -04:00; 23:00-0400 that evening is 03:00Z.
		expect(parseScheduleAt("23:00-0400", utc("2026-09-25T02:00:00Z"))?.toISOString()).toBe("2026-09-25T03:00:00.000Z");
	});

	it("a half-hour offset", () => {
		expect(parseScheduleAt("09:00+05:30", utc("2026-09-24T00:00:00Z"))?.toISOString()).toBe("2026-09-24T03:30:00.000Z");
	});

	it("a full ISO instant with a zone is taken exactly, past or future", () => {
		expect(parseScheduleAt("2026-09-25T06:00Z", 0)?.toISOString()).toBe("2026-09-25T06:00:00.000Z");
		expect(parseScheduleAt("2026-09-25 06:00:30+03:00", 0)?.toISOString()).toBe("2026-09-25T03:00:30.000Z");
		expect(parseScheduleAt("2020-01-01T00:00Z", utc("2026-01-01T00:00:00Z"))?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
	});

	it("rejects out-of-range values instead of letting Date roll them over", () => {
		for (const bad of ["24:00Z", "12:60Z", "06:00+15:00", "2026-02-31T06:00Z", "2026-13-01T06:00Z", "6pm", "06:00 IDT", ""]) {
			expect(parseScheduleAt(bad, utc("2026-09-24T00:00:00Z")), bad).toBeNull();
		}
	});
});

describe("parseScheduleAt — bare and zoneless forms are this machine's clock", () => {
	it("bare HH:MM matches the local wall clock (today, else tomorrow)", () => {
		const now = new Date(2026, 8, 24, 10, 0).getTime();
		const today = parseScheduleAt("14:00", now)!;
		expect([today.getHours(), today.getMinutes(), today.getDate()]).toEqual([14, 0, 24]);
		const tomorrow = parseScheduleAt("09:00", now)!;
		expect([tomorrow.getHours(), tomorrow.getDate()]).toEqual([9, 25]);
	});

	it("a zoneless ISO date-time is local", () => {
		expect(parseScheduleAt("2026-09-25T06:00", 0)?.getTime()).toBe(new Date(2026, 8, 25, 6, 0).getTime());
		expect(parseScheduleAt("2026-02-30T06:00", 0)).toBeNull();
	});
});

describe("describeScheduledTime", () => {
	it("shows local and UTC side by side, so a zone mistake is visible at once", () => {
		const now = utc("2026-09-24T08:00:00Z");
		expect(describeScheduledTime(new Date("2026-09-24T11:00:00Z"), now, "Asia/Jerusalem"))
			.toBe("14:00 local (Asia/Jerusalem) = 11:00 UTC");
	});

	it("adds the date on whichever side is not today", () => {
		// 22:30Z on the 24th is 01:30 on the 25th in Jerusalem.
		const now = utc("2026-09-24T20:00:00Z");
		expect(describeScheduledTime(new Date("2026-09-24T22:30:00Z"), now, "Asia/Jerusalem"))
			.toBe("2026-09-25 01:30 local (Asia/Jerusalem) = 22:30 UTC");
	});
});
