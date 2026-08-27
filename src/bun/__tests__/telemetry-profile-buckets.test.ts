import { describe, it, expect } from "vitest";
import {
	cpuArchLabel,
	daysSince,
	installAgeBucket,
	osVersionFromKernel,
	projectCountBucket,
	taskCountBucket,
} from "../../shared/telemetry-profile";

describe("projectCountBucket", () => {
	it("separates the single-repo user from everyone else", () => {
		expect(projectCountBucket(1)).toBe("1");
		expect(projectCountBucket(2)).toBe("2-5");
	});

	it("walks the whole ladder", () => {
		expect(projectCountBucket(0)).toBe("0");
		expect(projectCountBucket(5)).toBe("2-5");
		expect(projectCountBucket(6)).toBe("6-15");
		expect(projectCountBucket(15)).toBe("6-15");
		expect(projectCountBucket(16)).toBe("16-30");
		expect(projectCountBucket(30)).toBe("16-30");
		expect(projectCountBucket(31)).toBe("31+");
		expect(projectCountBucket(4000)).toBe("31+");
	});
});

describe("taskCountBucket", () => {
	it("walks the whole ladder", () => {
		expect(taskCountBucket(0)).toBe("0");
		expect(taskCountBucket(1)).toBe("1-10");
		expect(taskCountBucket(10)).toBe("1-10");
		expect(taskCountBucket(11)).toBe("11-50");
		expect(taskCountBucket(50)).toBe("11-50");
		expect(taskCountBucket(51)).toBe("51-200");
		expect(taskCountBucket(200)).toBe("51-200");
		expect(taskCountBucket(201)).toBe("201-1000");
		expect(taskCountBucket(1000)).toBe("201-1000");
		expect(taskCountBucket(1001)).toBe("1001+");
	});
});

describe("installAgeBucket", () => {
	// The reason the property exists: today's installs must be their own row, and
	// so must the ones that came back tomorrow.
	it("gives the first three days a bucket each", () => {
		expect(installAgeBucket(0)).toBe("day-0");
		expect(installAgeBucket(1)).toBe("day-1");
		expect(installAgeBucket(2)).toBe("day-2");
	});

	it("groups the rest of the first week", () => {
		expect(installAgeBucket(3)).toBe("day-3-6");
		expect(installAgeBucket(6)).toBe("day-3-6");
	});

	it("counts in weeks from day 7 up to a quarter", () => {
		expect(installAgeBucket(7)).toBe("week-01");
		expect(installAgeBucket(13)).toBe("week-01");
		expect(installAgeBucket(14)).toBe("week-02");
		expect(installAgeBucket(90)).toBe("week-12");
	});

	it("switches to months at a quarter and never comes back", () => {
		expect(installAgeBucket(91)).toBe("month-03");
		expect(installAgeBucket(120)).toBe("month-04");
		expect(installAgeBucket(365)).toBe("month-12");
		expect(installAgeBucket(1000)).toBe("month-33");
	});

	// Zero padding is what keeps a report sorted by label in order inside a family.
	it("pads week and month numbers so they sort as numbers do", () => {
		const weeks = [installAgeBucket(14), installAgeBucket(70)];
		expect(weeks).toEqual(["week-02", "week-10"]);
		expect([...weeks].sort()).toEqual(weeks);
	});

	it("never emits a negative or fractional age", () => {
		expect(installAgeBucket(-5)).toBe("day-0");
		expect(installAgeBucket(1.9)).toBe("day-1");
	});

	// The grid must stay finite in its head and grow only one value per month, or
	// GA4 rolls the tail into "(other)".
	it("produces 26 distinct values across the first year", () => {
		const seen = new Set<string>();
		for (let d = 0; d <= 365; d++) seen.add(installAgeBucket(d));
		expect(seen.size).toBe(26);
	});

	it("grows by exactly one value per month after that", () => {
		const firstYear = new Set<string>();
		for (let d = 0; d <= 365; d++) firstYear.add(installAgeBucket(d));
		const twoYears = new Set<string>();
		for (let d = 0; d <= 730; d++) twoYears.add(installAgeBucket(d));
		expect(twoYears.size - firstYear.size).toBe(12);
	});
});

describe("daysSince", () => {
	const day = 86_400_000;

	it("counts whole days only", () => {
		expect(daysSince(1000, 1000)).toBe(0);
		expect(daysSince(0, day - 1)).toBe(0);
		expect(daysSince(0, day)).toBe(1);
		expect(daysSince(0, 10 * day + 5)).toBe(10);
	});

	it("floors a clock that went backwards at zero rather than going negative", () => {
		expect(daysSince(10 * day, 0)).toBe(0);
	});
});

describe("cpuArchLabel", () => {
	it("passes a native architecture through", () => {
		expect(cpuArchLabel("arm64", false)).toBe("arm64");
		expect(cpuArchLabel("x64", false)).toBe("x64");
	});

	it("calls out a translated Intel build, which the User-Agent cannot", () => {
		expect(cpuArchLabel("x64", true)).toBe("x64-rosetta");
	});
});

describe("osVersionFromKernel", () => {
	// Darwin 20 = macOS 11 and it has tracked +9 since; the minor does NOT track
	// (Darwin 24.6 is macOS 15.7), so only the major is reported.
	it("turns a Darwin release into the macOS major version", () => {
		expect(osVersionFromKernel("darwin", "24.6.0")).toBe("15");
		expect(osVersionFromKernel("darwin", "23.0.0")).toBe("14");
		expect(osVersionFromKernel("darwin", "20.1.0")).toBe("11");
	});

	it("refuses a pre-Big-Sur Darwin rather than reporting a nonsense number", () => {
		expect(osVersionFromKernel("darwin", "19.6.0")).toBe("");
	});

	// Windows 11 kept the 10.0.x release string; only the build number moved.
	it("tells Windows 11 from Windows 10 by build number", () => {
		expect(osVersionFromKernel("win32", "10.0.26100")).toBe("11");
		expect(osVersionFromKernel("win32", "10.0.22000")).toBe("11");
		expect(osVersionFromKernel("win32", "10.0.19045")).toBe("10");
	});

	it("reports the kernel line on Linux", () => {
		expect(osVersionFromKernel("linux", "6.8.0-45-generic")).toBe("6.8");
	});

	it("returns empty for an unparseable release", () => {
		expect(osVersionFromKernel("darwin", "")).toBe("");
		expect(osVersionFromKernel("linux", "unknown")).toBe("");
	});
});
