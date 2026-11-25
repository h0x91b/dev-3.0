import { describe, expect, it } from "vitest";
import { resolveScheduleTarget, scheduleDayOffset, toTimeInputValue } from "../../shared/schedule";

// A fixed reference instant: 2026-07-11 10:00:00 local.
const NOW = new Date(2026, 6, 11, 10, 0, 0, 0).getTime();

describe("resolveScheduleTarget — in mode", () => {
	it("resolves a relative delay (minutes-only too) to now + hours + minutes, and treats a zero delay as invalid", () => {
		const target = resolveScheduleTarget({ mode: "in", delayHours: 2, delayMinutes: 30, atTime: "" }, NOW);
		expect(target?.getTime()).toBe(NOW + 2 * 3_600_000 + 30 * 60_000);
		const minutes = resolveScheduleTarget({ mode: "in", delayHours: 0, delayMinutes: 5, atTime: "" }, NOW);
		expect(minutes?.getTime()).toBe(NOW + 5 * 60_000);
		expect(resolveScheduleTarget({ mode: "in", delayHours: 0, delayMinutes: 0, atTime: "" }, NOW)).toBeNull();
	});
});

describe("resolveScheduleTarget — at mode", () => {
	it("resolves a time still ahead today to today, and rolls one already passed over to tomorrow", () => {
		const target = resolveScheduleTarget({ mode: "at", delayHours: 0, delayMinutes: 0, atTime: "14:30" }, NOW);
		expect(target?.getDate()).toBe(11);
		expect(target?.getHours()).toBe(14);
		expect(target?.getMinutes()).toBe(30);

		const passed = resolveScheduleTarget({ mode: "at", delayHours: 0, delayMinutes: 0, atTime: "08:00" }, NOW);
		expect(passed?.getDate()).toBe(12); // next day
		expect(passed?.getHours()).toBe(8);
	});

	it("rejects an unparseable or out-of-range time", () => {
		expect(resolveScheduleTarget({ mode: "at", delayHours: 0, delayMinutes: 0, atTime: "nope" }, NOW)).toBeNull();
		expect(resolveScheduleTarget({ mode: "at", delayHours: 0, delayMinutes: 0, atTime: "" }, NOW)).toBeNull();
		expect(resolveScheduleTarget({ mode: "at", delayHours: 0, delayMinutes: 0, atTime: "25:00" }, NOW)).toBeNull();
		expect(resolveScheduleTarget({ mode: "at", delayHours: 0, delayMinutes: 0, atTime: "12:99" }, NOW)).toBeNull();
	});
});

describe("scheduleDayOffset", () => {
	it("returns the whole-day distance: 0 later today, 1 tomorrow, 3 for a far target", () => {
		expect(scheduleDayOffset(new Date(2026, 6, 11, 23, 0, 0), NOW)).toBe(0);
		expect(scheduleDayOffset(new Date(2026, 6, 12, 1, 0, 0), NOW)).toBe(1);
		expect(scheduleDayOffset(new Date(2026, 6, 14, 10, 0, 0), NOW)).toBe(3);
	});
});

describe("toTimeInputValue", () => {
	it("formats HH:MM zero-padded", () => {
		expect(toTimeInputValue(new Date(2026, 6, 11, 9, 5))).toBe("09:05");
		expect(toTimeInputValue(new Date(2026, 6, 11, 14, 30))).toBe("14:30");
	});
});
