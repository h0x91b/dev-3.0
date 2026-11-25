import { describe, it, expect } from "vitest";
import { getISOWeek, formatDateTime, makeTitle, composeWindowTitle, buildSourceLabel } from "../app-utils";

describe("getISOWeek", () => {
	it("follows ISO 8601: week 1 rules, week 52/53 at year end, mid-year, Sunday, and the previous-year boundary", () => {
		expect(getISOWeek(new Date(2024, 0, 1)), "returns week 1 for Jan 1 2024 (Monday)").toBe(1);
		expect(getISOWeek(new Date(2024, 0, 4)), "returns week 1 for Jan 4 (always in week 1 per ISO 8601)").toBe(1);
		// 2024-12-31 is a Tuesday → ISO week 1 of 2025
		expect(getISOWeek(new Date(2024, 11, 31)), "returns week 52 or 53 for Dec 31").toBe(1);
		// 2023-12-31 is a Sunday → ISO week 52 of 2023
		// Actually Dec 31 2023 is a Sunday → ISO week 52
		expect(getISOWeek(new Date(2023, 11, 31)), "returns week 52 or 53 for Dec 31").toBe(52);
		// 2020-12-31 is a Thursday → ISO week 53
		expect(getISOWeek(new Date(2020, 11, 31)), "handles week 53 in long years").toBe(53);
		// 2024-03-04 (Monday) should be week 10
		expect(getISOWeek(new Date(2024, 2, 4)), "returns correct week for mid-year dates").toBe(10);
		// 2024-01-07 is a Sunday → still week 1
		expect(getISOWeek(new Date(2024, 0, 7)), "handles Sunday correctly (last day of ISO week)").toBe(1);
		// 2024-01-08 is a Monday → week 2
		expect(getISOWeek(new Date(2024, 0, 8)), "handles Sunday correctly (last day of ISO week)").toBe(2);
		// 2021-01-01 is a Friday → ISO week 53 of 2020
		expect(getISOWeek(new Date(2021, 0, 1)), "handles year boundary where Jan 1 is in previous year's week").toBe(53);
	});
});

describe("formatDateTime", () => {
	it("shows the zero-padded ISO week, the year, and 24h time separated by ·", () => {
		const result = formatDateTime(new Date(2024, 2, 4, 14, 30, 5));
		expect(result, "ISO week").toContain("W10");
		expect(result.split(" · "), "three · separated parts").toHaveLength(3);
		expect(result, "24h time").toContain("14:30:05");
		expect(result, "year").toContain("2024");
		expect(formatDateTime(new Date(2024, 0, 2, 10, 0, 0)), "single-digit week is zero-padded").toContain("W01");
	});
});

describe("makeTitle", () => {
	it("builds the title from version, build source and build time, tolerating an empty time and complex versions", () => {
		expect(makeTitle("1.63.0", "now", "stable", "local@be3c8cea"), "puts the build source between the version and the build time").toBe("dev-3.0 v1.63.0 · local@be3c8cea [now]");
		expect(makeTitle("1.2.3", "Mon, 4 Mar 2024"), "builds window title with version and build time").toBe(
			"dev-3.0 v1.2.3 [Mon, 4 Mar 2024]",
		);
		expect(makeTitle("0.1.0", ""), "handles empty build time").toBe("dev-3.0 v0.1.0 []");
		expect(makeTitle("0.3.6-beta.1", "now"), "handles complex version strings").toBe(
			"dev-3.0 v0.3.6-beta.1 [now]",
		);
	});

	it("prefixes only dev builds with [DEV from src]", () => {
		expect(makeTitle("1.2.3", "Mon, 4 Mar 2024", "dev"), "prefixes dev builds with [DEV from src]").toBe(
			"[DEV from src] dev-3.0 v1.2.3 [Mon, 4 Mar 2024]",
		);
		expect(makeTitle("1.2.3", "now", "prod"), "does not prefix non-dev channels").toBe("dev-3.0 v1.2.3 [now]");
		expect(makeTitle("1.2.3", "now", "stable"), "does not prefix non-dev channels").toBe("dev-3.0 v1.2.3 [now]");
		expect(makeTitle("1.2.3", "now", undefined), "does not prefix non-dev channels").toBe("dev-3.0 v1.2.3 [now]");
	});
});

describe("composeWindowTitle", () => {
	it("puts a trimmed route context in front of the base title, or keeps the base title alone", () => {
		expect(composeWindowTitle("dev-3.0 v1.2.3 [now]", "Fix auth race"), "puts the route context in front of the base title").toBe(
			"Fix auth race · dev-3.0 v1.2.3 [now]",
		);
		expect(composeWindowTitle("dev-3.0 v1.2.3 [now]", null), "keeps the base title alone when there is no context").toBe("dev-3.0 v1.2.3 [now]");
		expect(composeWindowTitle("dev-3.0", undefined), "keeps the base title alone when there is no context").toBe("dev-3.0");
		expect(composeWindowTitle("dev-3.0", "   "), "keeps the base title alone when there is no context").toBe("dev-3.0");
		expect(composeWindowTitle("dev-3.0", "  My Project  "), "trims a padded context").toBe("My Project · dev-3.0");
	});
});

describe("buildSourceLabel", () => {
	it("names branch and commit, falls back to the commit for a detached HEAD, stays empty for releases", () => {
		expect(buildSourceLabel("local", "be3c8cea", true), "names branch and commit for a self-built install").toBe("local@be3c8cea");
		expect(buildSourceLabel("", "be3c8cea", true), "falls back to the commit alone for a detached HEAD").toBe("be3c8cea");
		expect(buildSourceLabel("main", "be3c8cea", false), "stays empty for a released build or an unknown commit").toBe("");
		expect(buildSourceLabel("local", "unknown", true), "stays empty for a released build or an unknown commit").toBe("");
	});
});
