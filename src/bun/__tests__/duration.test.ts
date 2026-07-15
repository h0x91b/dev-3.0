import { describe, expect, it } from "vitest";

import {
	formatCountdown,
	isValidNotificationDurationMs,
	NOTIFICATION_MAX_DURATION_MS,
	NOTIFICATION_MIN_DURATION_MS,
	parseDelay,
	parseNotificationDuration,
} from "../../shared/duration";

const M = 60_000;
const S = 1_000;
const H = 3_600_000;
const D = 86_400_000;

describe("parseDelay", () => {
	it("parses bare numbers as minutes", () => {
		expect(parseDelay("90")).toBe(90 * M);
		expect(parseDelay("1")).toBe(M);
	});

	it("parses single-unit segments", () => {
		expect(parseDelay("2s")).toBe(2 * S);
		expect(parseDelay("45m")).toBe(45 * M);
		expect(parseDelay("2h")).toBe(2 * H);
		expect(parseDelay("1d")).toBe(D);
	});

	it("parses compound segments", () => {
		expect(parseDelay("1h30m")).toBe(H + 30 * M);
		expect(parseDelay("1d2h")).toBe(D + 2 * H);
		expect(parseDelay("1d2h15m")).toBe(D + 2 * H + 15 * M);
	});

	it("ignores whitespace and case", () => {
		expect(parseDelay(" 1H 30M ")).toBe(H + 30 * M);
		expect(parseDelay("2 h")).toBe(2 * H);
	});

	it("rejects a repeated unit", () => {
		expect(parseDelay("1h2h")).toBeNull();
		expect(parseDelay("10m5m")).toBeNull();
	});

	it("rejects zero and non-positive delays", () => {
		expect(parseDelay("0")).toBeNull();
		expect(parseDelay("0m")).toBeNull();
		expect(parseDelay("0h0m")).toBeNull();
	});

	it("rejects garbage", () => {
		expect(parseDelay("")).toBeNull();
		expect(parseDelay("abc")).toBeNull();
		expect(parseDelay("5x")).toBeNull();
		expect(parseDelay("h30")).toBeNull();
		expect(parseDelay("-5m")).toBeNull();
		expect(parseDelay("1.5h")).toBeNull();
	});
});

describe("formatCountdown", () => {
	it("clamps below one minute (including negatives)", () => {
		expect(formatCountdown(0)).toBe("<1m");
		expect(formatCountdown(59_999)).toBe("<1m");
		expect(formatCountdown(-5 * M)).toBe("<1m");
	});

	it("formats minutes only", () => {
		expect(formatCountdown(12 * M)).toBe("12m");
		expect(formatCountdown(M)).toBe("1m");
	});

	it("formats hours with zero-padded minutes", () => {
		expect(formatCountdown(H + 5 * M)).toBe("1h 05m");
		expect(formatCountdown(2 * H)).toBe("2h");
	});

	it("formats days with hours, dropping minutes", () => {
		expect(formatCountdown(2 * D + 3 * H + 40 * M)).toBe("2d 3h");
		expect(formatCountdown(D)).toBe("1d");
	});

	it("round-trips parseDelay output", () => {
		expect(formatCountdown(parseDelay("1h30m")!)).toBe("1h 30m");
		expect(formatCountdown(parseDelay("2d3h")!)).toBe("2d 3h");
	});
});

describe("notification duration", () => {
	it("accepts whole seconds from 2s through 30s", () => {
		expect(parseNotificationDuration("2s")).toBe(NOTIFICATION_MIN_DURATION_MS);
		expect(parseNotificationDuration("30s")).toBe(NOTIFICATION_MAX_DURATION_MS);
		expect(parseNotificationDuration("15S")).toBe(15 * S);
	});

	it("rejects values outside the notification range or grammar", () => {
		expect(parseNotificationDuration("1s")).toBeNull();
		expect(parseNotificationDuration("31s")).toBeNull();
		expect(parseNotificationDuration("2m")).toBeNull();
		expect(parseNotificationDuration("2")).toBeNull();
	});

	it("validates socket durations in milliseconds", () => {
		expect(isValidNotificationDurationMs(NOTIFICATION_MIN_DURATION_MS)).toBe(true);
		expect(isValidNotificationDurationMs(NOTIFICATION_MAX_DURATION_MS)).toBe(true);
		expect(isValidNotificationDurationMs(1_000)).toBe(false);
		expect(isValidNotificationDurationMs(31_000)).toBe(false);
	});
});
