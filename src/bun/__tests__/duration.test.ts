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
	it("parses bare minutes, single and compound unit segments, ignoring whitespace and case", () => {
		expect(parseDelay("90")).toBe(90 * M);
		expect(parseDelay("2s")).toBe(2 * S);
		expect(parseDelay("45m")).toBe(45 * M);
		expect(parseDelay("2h")).toBe(2 * H);
		expect(parseDelay("1d")).toBe(D);
		expect(parseDelay("1d2h15m")).toBe(D + 2 * H + 15 * M);
		expect(parseDelay(" 1H 30M ")).toBe(H + 30 * M);
		expect(parseDelay("2 h")).toBe(2 * H);
	});

	it("rejects a repeated unit, a non-positive delay, and garbage", () => {
		for (const input of ["1h2h", "10m5m", "0", "0m", "0h0m", "", "abc", "5x", "h30", "-5m", "1.5h"]) {
			expect(parseDelay(input), JSON.stringify(input)).toBeNull();
		}
	});
});

describe("formatCountdown", () => {
	it("clamps below a minute, pads minutes under hours, drops minutes under days, and round-trips parseDelay", () => {
		expect(formatCountdown(59_999)).toBe("<1m");
		expect(formatCountdown(-5 * M)).toBe("<1m");
		expect(formatCountdown(12 * M)).toBe("12m");
		expect(formatCountdown(H + 5 * M)).toBe("1h 05m");
		expect(formatCountdown(2 * H)).toBe("2h");
		expect(formatCountdown(2 * D + 3 * H + 40 * M)).toBe("2d 3h");
		expect(formatCountdown(D)).toBe("1d");
		expect(formatCountdown(parseDelay("1h30m")!)).toBe("1h 30m");
	});
});

describe("notification duration", () => {
	it("accepts whole seconds from 2s through 30s with an optional suffix, and nothing else", () => {
		expect(parseNotificationDuration("2s")).toBe(NOTIFICATION_MIN_DURATION_MS);
		expect(parseNotificationDuration("2")).toBe(NOTIFICATION_MIN_DURATION_MS);
		expect(parseNotificationDuration("30s")).toBe(NOTIFICATION_MAX_DURATION_MS);
		expect(parseNotificationDuration("15S")).toBe(15 * S);
		for (const input of ["1s", "31s", "2m", "15.0"]) {
			expect(parseNotificationDuration(input), input).toBeNull();
		}
	});

	it("validates socket durations in milliseconds", () => {
		expect(isValidNotificationDurationMs(NOTIFICATION_MIN_DURATION_MS)).toBe(true);
		expect(isValidNotificationDurationMs(NOTIFICATION_MAX_DURATION_MS)).toBe(true);
		expect(isValidNotificationDurationMs(1_000)).toBe(false);
		expect(isValidNotificationDurationMs(31_000)).toBe(false);
	});
});
