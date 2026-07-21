import { describe, it, expect } from "vitest";
import type { ChangelogEntry } from "../../shared/types";
import {
	deriveShortTitle,
	entryShortTitle,
	buildUpdateChangelog,
	MAX_POPOVER_FEATURES,
} from "../../shared/update-changelog";

function entry(partial: Partial<ChangelogEntry> & { type: string }): ChangelogEntry {
	return { date: "2026-07-21", slug: "s", title: "t", ...partial };
}

describe("deriveShortTitle", () => {
	it("returns the full title (trimmed, no trailing punctuation) when short enough", () => {
		expect(deriveShortTitle("Added a Tab button.")).toBe("Added a Tab button");
	});

	it("truncates to the word cap with an ellipsis", () => {
		const full = "Fixed the header Remote QR button needing several clicks to open";
		expect(deriveShortTitle(full, 6)).toBe("Fixed the header Remote QR button…");
	});

	it("honors a custom word cap", () => {
		expect(deriveShortTitle("one two three four five", 3)).toBe("one two three…");
	});
});

describe("entryShortTitle", () => {
	it("prefers an authored short title", () => {
		expect(entryShortTitle(entry({ type: "feature", short: "Nice short", title: "A very long sentence" }))).toBe(
			"Nice short",
		);
	});

	it("falls back to a derived title when short is missing or blank", () => {
		expect(entryShortTitle(entry({ type: "fix", title: "Short full" }))).toBe("Short full");
		expect(entryShortTitle(entry({ type: "fix", short: "   ", title: "Short full" }))).toBe("Short full");
	});
});

describe("buildUpdateChangelog", () => {
	it("puts features first, caps the shown list, and counts the whole window", () => {
		const window: ChangelogEntry[] = [
			...Array.from({ length: 7 }, (_, i) => entry({ type: "feature", slug: `f${i}`, short: `Feature ${i}` })),
			...Array.from({ length: 3 }, (_, i) => entry({ type: "fix", slug: `x${i}`, short: `Fix ${i}` })),
			entry({ type: "chore", slug: "c", short: "Chore" }),
		];
		const result = buildUpdateChangelog(window);
		expect(result.features).toHaveLength(MAX_POPOVER_FEATURES);
		expect(result.features[0]).toBe("Feature 0");
		expect(result.featureCount).toBe(7);
		expect(result.fixCount).toBe(3);
	});

	it("handles an empty window", () => {
		expect(buildUpdateChangelog([])).toEqual({ features: [], featureCount: 0, fixCount: 0 });
	});

	it("derives short titles for feature entries without one", () => {
		const window = [entry({ type: "feature", title: "one two three four five six seven eight" })];
		expect(buildUpdateChangelog(window).features[0]).toBe("one two three four five six…");
	});
});
