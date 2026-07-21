import type { ChangelogEntry, UpdateChangelog } from "./types";

/** How many feature titles the update popover shows before the "+N more" rollup. */
export const MAX_POPOVER_FEATURES = 5;

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

/**
 * Build the compact "what's new" payload from a release window of changelog
 * entries (already scoped to the new version). Features-first; feature titles
 * are capped at {@link MAX_POPOVER_FEATURES}, counts reflect the whole window.
 */
export function buildUpdateChangelog(windowEntries: ChangelogEntry[]): UpdateChangelog {
	const features = windowEntries.filter((e) => e.type === "feature");
	const fixes = windowEntries.filter((e) => e.type === "fix");
	return {
		features: features.slice(0, MAX_POPOVER_FEATURES).map(entryShortTitle),
		featureCount: features.length,
		fixCount: fixes.length,
	};
}
