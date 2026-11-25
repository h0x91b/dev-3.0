import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	DEFAULT_LOG_RETENTION_DAYS,
	isShorterRetention,
	logRetentionChoice,
	logUsageBeyondRetention,
	resolveLogRetentionDays,
	retentionCutoff,
	sanitizeLogRetention,
	storedLogRetention,
} from "../../shared/log-retention";

describe("log retention setting", () => {
	it("resolves an absent field to the 30-day default, forever to null, and a day count to itself", () => {
		expect(resolveLogRetentionDays({})).toBe(DEFAULT_LOG_RETENTION_DAYS);
		expect(DEFAULT_LOG_RETENTION_DAYS).toBe(30);
		expect(resolveLogRetentionDays({ logRetentionDays: 730 })).toBe(730);
		expect(resolveLogRetentionDays({ logRetentionDays: "forever" })).toBeNull();
	});

	it("stores 30 as an absent field and every other choice as itself", () => {
		expect(storedLogRetention(30)).toBeUndefined();
		expect(storedLogRetention(90)).toBe(90);
		expect(storedLogRetention(45)).toBe(45);
		expect(storedLogRetention("forever")).toBe("forever");
		expect(logRetentionChoice({})).toBe(30);
		expect(logRetentionChoice({ logRetentionDays: 730 })).toBe(730);
		expect(logRetentionChoice({ logRetentionDays: "forever" })).toBe("forever");
	});

	it("keeps any positive whole day count and forever; 30 and anything else mean the default", () => {
		expect([1, 45, 90, 730, "forever"].map(sanitizeLogRetention)).toEqual([1, 45, 90, 730, "forever"]);
		expect([30, 0, -7, 1.5, "90", "never", null, undefined, true].map(sanitizeLogRetention)).toEqual(Array(9).fill(undefined));
	});

	it("treats only a strictly shorter window as lowering, with forever as the longest", () => {
		expect(isShorterRetention(365, 90)).toBe(true);
		expect(isShorterRetention(null, 365)).toBe(true);
		expect(isShorterRetention(90, 365)).toBe(false);
		expect(isShorterRetention(90, 90)).toBe(false);
		expect(isShorterRetention(90, null)).toBe(false);
		expect(isShorterRetention(null, null)).toBe(false);
	});
});

describe("logUsageBeyondRetention", () => {
	const now = new Date(2026, 10, 15, 12);
	const days = [
		{ day: "2026-11-15", bytes: 100 },
		{ day: "2026-10-17", bytes: 10 },
		{ day: "2026-10-16", bytes: 1 },
		{ day: "2026-01-01", bytes: 1000 },
	];

	it("counts the days and bytes older than the window; today is day one", () => {
		// 30 days keeps 2026-10-17 through today.
		expect(logUsageBeyondRetention(days, 30, now)).toEqual({ days: 2, bytes: 1001 });
		expect(logUsageBeyondRetention(days, 365, now)).toEqual({ days: 0, bytes: 0 });
		// Beyond the Date range there is no valid cutoff: nothing counts, like the prune.
		expect(logUsageBeyondRetention([{ day: "2001-01-01", bytes: 5 }], 1e9, now)).toEqual({ days: 0, bytes: 0 });
	});
});

describe("retentionCutoff across a DST change", () => {
	const originalTz = process.env.TZ;
	beforeAll(() => {
		process.env.TZ = "Europe/Berlin";
	});
	afterAll(() => {
		if (originalTz === undefined) delete process.env.TZ;
		else process.env.TZ = originalTz;
	});

	it("is the local midnight of the first kept day when the window spans the end of summer time", () => {
		// Clocks went back on 2026-10-25, so the 30-day window of 2026-10-26 crosses it.
		expect(new Date(2026, 9, 25, 12).getTimezoneOffset()).toBe(-60);
		expect(new Date(2026, 8, 27, 12).getTimezoneOffset()).toBe(-120);
		const now = new Date(2026, 9, 26, 12);
		expect(retentionCutoff(now, 30)).toBe(new Date(2026, 8, 27).getTime());
		const days = [
			{ day: "2026-09-26", bytes: 1 },
			{ day: "2026-09-27", bytes: 10 },
		];
		expect(logUsageBeyondRetention(days, 30, now)).toEqual({ days: 1, bytes: 1 });
	});
});
