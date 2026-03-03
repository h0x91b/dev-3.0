import { describe, it, expect } from "vitest";
import { getISOWeek, formatDateTime, makeTitle } from "../app-utils";

describe("getISOWeek", () => {
	it("returns week 1 for Jan 1 2024 (Monday)", () => {
		expect(getISOWeek(new Date(2024, 0, 1))).toBe(1);
	});

	it("returns week 1 for Jan 4 (always in week 1 per ISO 8601)", () => {
		expect(getISOWeek(new Date(2024, 0, 4))).toBe(1);
	});

	it("returns week 52 or 53 for Dec 31", () => {
		// 2024-12-31 is a Tuesday → ISO week 1 of 2025
		expect(getISOWeek(new Date(2024, 11, 31))).toBe(1);
		// 2023-12-31 is a Sunday → ISO week 52 of 2023
		// Actually Dec 31 2023 is a Sunday → ISO week 52
		expect(getISOWeek(new Date(2023, 11, 31))).toBe(52);
	});

	it("handles week 53 in long years", () => {
		// 2020-12-31 is a Thursday → ISO week 53
		expect(getISOWeek(new Date(2020, 11, 31))).toBe(53);
	});

	it("returns correct week for mid-year dates", () => {
		// 2024-03-04 (Monday) should be week 10
		expect(getISOWeek(new Date(2024, 2, 4))).toBe(10);
	});

	it("handles Sunday correctly (last day of ISO week)", () => {
		// 2024-01-07 is a Sunday → still week 1
		expect(getISOWeek(new Date(2024, 0, 7))).toBe(1);
		// 2024-01-08 is a Monday → week 2
		expect(getISOWeek(new Date(2024, 0, 8))).toBe(2);
	});

	it("handles year boundary where Jan 1 is in previous year's week", () => {
		// 2021-01-01 is a Friday → ISO week 53 of 2020
		expect(getISOWeek(new Date(2021, 0, 1))).toBe(53);
	});
});

describe("formatDateTime", () => {
	it("contains ISO week number", () => {
		const result = formatDateTime(new Date(2024, 2, 4, 14, 30, 5));
		expect(result).toContain("W10");
	});

	it("pads single-digit week numbers with zero", () => {
		// Week 1
		const result = formatDateTime(new Date(2024, 0, 2, 10, 0, 0));
		expect(result).toContain("W01");
	});

	it("contains date and time parts separated by ·", () => {
		const result = formatDateTime(new Date(2024, 2, 4, 14, 30, 5));
		const parts = result.split(" · ");
		expect(parts).toHaveLength(3);
	});

	it("formats time in 24h format", () => {
		const result = formatDateTime(new Date(2024, 2, 4, 14, 30, 5));
		expect(result).toContain("14:30:05");
	});

	it("includes year in date portion", () => {
		const result = formatDateTime(new Date(2024, 2, 4));
		expect(result).toContain("2024");
	});
});

describe("makeTitle", () => {
	it("builds window title with version and build time", () => {
		expect(makeTitle("1.2.3", "Mon, 4 Mar 2024")).toBe(
			"dev-3.0 v1.2.3 [Mon, 4 Mar 2024]",
		);
	});

	it("handles empty build time", () => {
		expect(makeTitle("0.1.0", "")).toBe("dev-3.0 v0.1.0 []");
	});

	it("handles complex version strings", () => {
		expect(makeTitle("0.3.6-beta.1", "now")).toBe(
			"dev-3.0 v0.3.6-beta.1 [now]",
		);
	});
});
