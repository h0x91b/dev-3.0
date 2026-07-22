import { describe, it, expect } from "vitest";
import type { ChangelogEntry } from "../../shared/types";
import {
	deriveShortTitle,
	entryShortTitle,
	entryPriority,
	DEFAULT_CHANGELOG_PRIORITY,
	buildUpdateChangelog,
	buildReleaseNotesSections,
	renderReleaseNotesMarkdown,
	changedKeysFromPaths,
	changelogEntryKey,
	changelogKeyFromPath,
	countMergedPrs,
	resolvePrevTag,
	selectReleaseWindow,
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
		const featureTotal = MAX_POPOVER_FEATURES + 2;
		const window: ChangelogEntry[] = [
			...Array.from({ length: featureTotal }, (_, i) => entry({ type: "feature", slug: `f${i}`, short: `Feature ${i}` })),
			...Array.from({ length: 3 }, (_, i) => entry({ type: "fix", slug: `x${i}`, short: `Fix ${i}` })),
			entry({ type: "chore", slug: "c", short: "Chore" }),
		];
		const result = buildUpdateChangelog(window);
		expect(result.features).toHaveLength(MAX_POPOVER_FEATURES);
		expect(result.features[0]).toBe("Feature 0");
		expect(result.featureCount).toBe(featureTotal);
		expect(result.fixCount).toBe(3);
	});

	it("handles an empty window", () => {
		expect(buildUpdateChangelog([])).toEqual({ features: [], featureCount: 0, fixCount: 0 });
	});

	it("derives short titles for feature entries without one", () => {
		const window = [entry({ type: "feature", title: "one two three four five six seven eight" })];
		expect(buildUpdateChangelog(window).features[0]).toBe("one two three four five six…");
	});

	it("orders features by priority prefix regardless of window order", () => {
		const window: ChangelogEntry[] = [
			entry({ type: "feature", slug: "03-c", short: "C" }),
			entry({ type: "feature", slug: "00-a", short: "A" }),
			entry({ type: "feature", slug: "plain", short: "Mid" }),
			entry({ type: "feature", slug: "01-b", short: "B" }),
		];
		// Sorted by priority: 00 (A), 01 (B), 03 (C), then the unprefixed one mid-pack (50).
		expect(buildUpdateChangelog(window).features).toEqual(["A", "B", "C", "Mid"]);
	});
});

describe("entryPriority", () => {
	it("parses a two-digit prefix (00 = most prominent)", () => {
		expect(entryPriority({ slug: "00-add-dark-mode" })).toBe(0);
		expect(entryPriority({ slug: "07-mobile-key" })).toBe(7);
	});

	it("falls back to the mid-pack default without a numeric prefix", () => {
		expect(entryPriority({ slug: "add-dark-mode" })).toBe(DEFAULT_CHANGELOG_PRIORITY);
		expect(entryPriority({ slug: "v2-thing" })).toBe(DEFAULT_CHANGELOG_PRIORITY);
	});
});

describe("changelogKeyFromPath / changelogEntryKey", () => {
	it("parses a changelog file path into the entry identity key", () => {
		expect(changelogKeyFromPath("change-logs/2026/07/21/feature-foo-bar.md")).toBe("2026-07-21|feature|foo-bar");
	});

	it("accepts a leading prefix (raw git output) and matches changelogEntryKey", () => {
		const key = changelogKeyFromPath("a/b/change-logs/2026/07/21/fix-x.md");
		expect(key).toBe(changelogEntryKey({ date: "2026-07-21", type: "fix", slug: "x" }));
	});

	it("returns null for README, non-changelog, and dashless paths", () => {
		expect(changelogKeyFromPath("change-logs/2026/07/21/README.md")).toBeNull();
		expect(changelogKeyFromPath("src/foo.ts")).toBeNull();
		expect(changelogKeyFromPath("change-logs/2026/07/21/nodash.md")).toBeNull();
	});
});

describe("selectReleaseWindow", () => {
	const entries: ChangelogEntry[] = [
		entry({ date: "2026-07-21", type: "feature", slug: "new" }),
		entry({ date: "2026-07-21", type: "fix", slug: "old-touched" }),
		entry({ date: "2026-07-01", type: "feature", slug: "shipped" }),
	];

	it("returns only entries whose key is in the changed set", () => {
		const changed = new Set(["2026-07-21|feature|new", "2026-07-21|fix|old-touched"]);
		const window = selectReleaseWindow(entries, changed);
		expect(window.map((e) => e.slug)).toEqual(["new", "old-touched"]);
	});

	it("falls back to the newest-day batch when the changed set is empty", () => {
		const window = selectReleaseWindow(entries, new Set());
		expect(window.map((e) => e.slug)).toEqual(["new", "old-touched"]);
	});

	it("falls back when the changed set matches nothing", () => {
		const window = selectReleaseWindow(entries, new Set(["2020-01-01|feature|ghost"]));
		expect(window.map((e) => e.slug)).toEqual(["new", "old-touched"]);
	});

	it("returns [] for no entries", () => {
		expect(selectReleaseWindow([], new Set())).toEqual([]);
	});
});

describe("resolvePrevTag", () => {
	it("picks the newest v* tag not pointing at HEAD", () => {
		expect(resolvePrevTag("v1.5.0\nv1.4.0\nv1.3.0", "")).toBe("v1.5.0");
	});

	it("skips tags that point at HEAD (the release being cut)", () => {
		expect(resolvePrevTag("v2.0.0\nv1.9.0", "v2.0.0")).toBe("v1.9.0");
	});

	it("ignores non-v tags and returns null when none qualify", () => {
		expect(resolvePrevTag("nightly\nlatest", "")).toBeNull();
		expect(resolvePrevTag("", "")).toBeNull();
	});
});

describe("countMergedPrs", () => {
	it("counts commit subjects with a (#N) squash-merge marker", () => {
		expect(
			countMergedPrs([
				"Fix full-width PR conversation toggle (#1034)",
				"Add swipe-to-dismiss gesture (#1033)",
				"WIP local commit without a PR",
				"",
			]),
		).toBe(2);
	});

	it("returns 0 for no PR-marked subjects", () => {
		expect(countMergedPrs(["direct push", ""])).toBe(0);
	});
});

describe("changedKeysFromPaths", () => {
	it("keeps only changelog entry paths and dedupes to keys", () => {
		const keys = changedKeysFromPaths([
			"change-logs/2026/07/21/feature-a.md",
			"change-logs/2026/07/21/feature-a.md",
			"src/foo.ts",
			"change-logs/2026/07/21/README.md",
			"",
		]);
		expect([...keys]).toEqual(["2026-07-21|feature|a"]);
	});
});

describe("buildReleaseNotesSections", () => {
	it("orders sections Features → Fixes → Refactors with priority-sorted features and full titles", () => {
		const window: ChangelogEntry[] = [
			entry({ type: "fix", slug: "x1", title: "Fixed a crash" }),
			entry({ type: "refactor", slug: "r1", title: "Refactored the reducer" }),
			entry({ type: "feature", slug: "05-late", title: "Late feature" }),
			entry({ type: "feature", slug: "00-early", title: "Early feature" }),
			entry({ type: "chore", slug: "c1", title: "Bumped a dep" }),
		];
		expect(buildReleaseNotesSections(window)).toEqual([
			{ heading: "Features", titles: ["Early feature", "Late feature"] },
			{ heading: "Fixes", titles: ["Fixed a crash"] },
			{ heading: "Refactors", titles: ["Refactored the reducer"] },
		]);
	});

	it("omits empty sections and ignores non-feature/fix/refactor types", () => {
		const window: ChangelogEntry[] = [
			entry({ type: "feature", slug: "f", title: "Only feature" }),
			entry({ type: "docs", slug: "d", title: "Docs tweak" }),
		];
		expect(buildReleaseNotesSections(window)).toEqual([{ heading: "Features", titles: ["Only feature"] }]);
	});
});

describe("renderReleaseNotesMarkdown", () => {
	it("renders a versioned heading with per-section bullet lists", () => {
		const sections = buildReleaseNotesSections([
			entry({ type: "feature", slug: "f", title: "New thing" }),
			entry({ type: "fix", slug: "x", title: "Fixed thing" }),
		]);
		expect(renderReleaseNotesMarkdown(sections, "v1.2.3")).toBe(
			["## What's new in v1.2.3", "", "### Features", "", "- New thing", "", "### Fixes", "", "- Fixed thing", ""].join(
				"\n",
			),
		);
	});

	it("returns an empty string when there is nothing to show", () => {
		expect(renderReleaseNotesMarkdown([], "v1.2.3")).toBe("");
	});
});
