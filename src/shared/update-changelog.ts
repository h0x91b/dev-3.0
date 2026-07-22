import type { ChangelogEntry, UpdateChangelog } from "./types";

/** How many feature titles the update popover shows before the "+N more" rollup. */
export const MAX_POPOVER_FEATURES = 7;

/**
 * Fallback short title for entries without an authored `short:` line. Recent
 * entries carry a hand-written short title; older ones fall back to the first
 * few words of the full sentence. This is deliberately crude — it exists only
 * so a missing short never breaks the popover, not to produce great copy.
 */
export function deriveShortTitle(full: string, maxWords = 6): string {
	const words = full.trim().split(/\s+/);
	if (words.length <= maxWords) return full.trim().replace(/[.:;,]+$/, "");
	return words.slice(0, maxWords).join(" ").replace(/[.:;,]+$/, "") + "…";
}

/** Short title for a popover entry: authored `short` wins, else derived. */
export function entryShortTitle(entry: ChangelogEntry): string {
	const authored = entry.short?.trim();
	return authored && authored.length > 0 ? authored : deriveShortTitle(entry.title);
}

/** Stable identity key for an entry: `date|type|slug`. */
export function changelogEntryKey(e: Pick<ChangelogEntry, "date" | "type" | "slug">): string {
	return `${e.date}|${e.type}|${e.slug}`;
}

/**
 * `change-logs/2026/07/21/feature-foo.md` → `2026-07-21|feature|foo` (matches
 * {@link changelogEntryKey}), or `null` for non-entry paths (README, malformed).
 * Accepts a leading path prefix so raw `git diff`/`ls-files` output works.
 */
export function changelogKeyFromPath(path: string): string | null {
	const m = path.match(/change-logs\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\.md$/);
	if (!m) return null;
	const basename = m[4];
	if (basename === "README") return null;
	const dashIdx = basename.indexOf("-");
	if (dashIdx === -1) return null;
	return changelogEntryKey({ date: `${m[1]}-${m[2]}-${m[3]}`, type: basename.slice(0, dashIdx), slug: basename.slice(dashIdx + 1) });
}

/**
 * Previous release tag = newest `v*` tag (creator-date desc, merged into HEAD)
 * that is NOT already pointing at HEAD. Takes the raw stdout of
 * `git tag --sort=-creatordate --merged HEAD` and `git tag --points-at HEAD`.
 */
export function resolvePrevTag(tagsMergedDesc: string, tagsPointingAtHead: string): string | null {
	const pointsAt = new Set(tagsPointingAtHead.split("\n").filter(Boolean));
	return tagsMergedDesc.split("\n").find((t) => /^v/.test(t) && !pointsAt.has(t)) ?? null;
}

/**
 * Count squash-merged PRs from a list of commit subjects (`git log --pretty=%s`).
 * PRs squash-merge with a trailing `(#123)` in the subject, so that marker is the
 * signal — direct pushes without a PR number are not counted.
 */
export function countMergedPrs(subjects: string[]): number {
	return subjects.filter((s) => /\(#\d+\)/.test(s)).length;
}

/** Map raw git path lines (diff / ls-files output) to the set of entry keys. */
export function changedKeysFromPaths(paths: string[]): Set<string> {
	const keys = new Set<string>();
	for (const p of paths) {
		const key = changelogKeyFromPath(p);
		if (key) keys.add(key);
	}
	return keys;
}

/**
 * Scope all changelog entries (newest-first) to one release window: the entries
 * whose identity key is in {@link changedKeys} (files changed since the previous
 * release, from git). Falls back to the most-recent day's batch — then the
 * newest 10 — when the changed set matches nothing (shallow checkout, no tags).
 * Single source of truth shared by the release build and the in-app simulator.
 */
export function selectReleaseWindow(entries: ChangelogEntry[], changedKeys: Set<string>): ChangelogEntry[] {
	if (changedKeys.size > 0) {
		const windowEntries = entries.filter((e) => changedKeys.has(changelogEntryKey(e)));
		if (windowEntries.length > 0) return windowEntries;
	}
	if (entries.length === 0) return [];
	const newestDate = entries[0].date;
	const batch = entries.filter((e) => e.date === newestDate);
	return batch.length > 0 ? batch : entries.slice(0, 10);
}

/** Priority for entries with no `NN-` prefix in the slug — sits mid-pack. */
export const DEFAULT_CHANGELOG_PRIORITY = 50;

/**
 * Popover ordering priority parsed from a `<type>-<NN>-<slug>` filename
 * (`NN` = 00..99, 00 = most prominent). Entries without the numeric segment
 * fall back to {@link DEFAULT_CHANGELOG_PRIORITY}. This is what lets a handful
 * of hand-picked "sexy" features win the limited popover slots instead of
 * whatever happens to sort first alphabetically.
 */
export function entryPriority(entry: Pick<ChangelogEntry, "slug">): number {
	const m = entry.slug.match(/^(\d{1,2})(?:-|$)/);
	return m ? parseInt(m[1], 10) : DEFAULT_CHANGELOG_PRIORITY;
}

/**
 * Build the compact "what's new" payload from a release window of changelog
 * entries (already scoped to the new version). Features-first, ordered by
 * {@link entryPriority} (ties keep window order); feature titles are capped at
 * {@link MAX_POPOVER_FEATURES}, counts reflect the whole window.
 */
export function buildUpdateChangelog(windowEntries: ChangelogEntry[]): UpdateChangelog {
	const features = windowEntries
		.filter((e) => e.type === "feature")
		.sort((a, b) => entryPriority(a) - entryPriority(b));
	const fixes = windowEntries.filter((e) => e.type === "fix");
	return {
		features: features.slice(0, MAX_POPOVER_FEATURES).map(entryShortTitle),
		featureCount: features.length,
		fixCount: fixes.length,
	};
}

/** Sections rendered into the GitHub Release body, in display order. */
export const RELEASE_NOTES_SECTIONS: ReadonlyArray<{ type: string; heading: string }> = [
	{ type: "feature", heading: "Features" },
	{ type: "fix", heading: "Fixes" },
	{ type: "refactor", heading: "Refactors" },
];

export interface ReleaseNotesSection {
	heading: string;
	titles: string[];
}

/**
 * Group a release window into the GitHub Release "what's new" sections —
 * Features (priority-ordered, same as the popover), then Fixes, then Refactors,
 * using full entry titles. Empty sections are omitted. Shares the release window
 * with {@link buildUpdateChangelog} so the popover and the release page describe
 * the same set of changes.
 */
export function buildReleaseNotesSections(windowEntries: ChangelogEntry[]): ReleaseNotesSection[] {
	const sections: ReleaseNotesSection[] = [];
	for (const { type, heading } of RELEASE_NOTES_SECTIONS) {
		let entries = windowEntries.filter((e) => e.type === type);
		if (type === "feature") entries = [...entries].sort((a, b) => entryPriority(a) - entryPriority(b));
		if (entries.length > 0) sections.push({ heading, titles: entries.map((e) => e.title) });
	}
	return sections;
}

/**
 * Render {@link buildReleaseNotesSections} as Markdown for the GitHub Release
 * body. Returns "" when there is nothing to show so the release job can skip the
 * whole section instead of emitting an empty heading.
 */
export function renderReleaseNotesMarkdown(sections: ReleaseNotesSection[], version?: string): string {
	if (sections.length === 0) return "";
	const lines: string[] = [version ? `## What's new in ${version}` : "## What's new", ""];
	for (const section of sections) {
		lines.push(`### ${section.heading}`, "");
		for (const title of section.titles) lines.push(`- ${title}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd() + "\n";
}
