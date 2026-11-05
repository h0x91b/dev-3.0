// ---- Changelog ----

export interface ChangelogEntry {
	date: string; // "2026-03-01"
	type: string; // "feature" | "fix" | "refactor" | "docs" | "chore"
	slug: string; // "system-requirements-check"
	title: string; // First sentence of content (truncated to ~120 chars) — collapsed teaser
	body?: string; // Full cleaned content, present only when it has more than the title (expandable)
	short?: string; // Optional ≤6-word title for the update popover (from a "Short:" line)
	suggestedBy?: string; // GitHub username without @ (e.g. "roiros")
	issueUrl?: string; // Full GitHub issue URL (e.g. "https://github.com/h0x91b/dev-3.0/issues/191")
	issueRef?: string; // Short issue ref (e.g. "#191")
	contributedBy?: string; // GitHub username of an external PR author, without @ (from "Contributed by @login")
	prUrl?: string; // Full GitHub pull request URL (e.g. "https://github.com/h0x91b/dev-3.0/pull/191")
	prRef?: string; // Short pull request ref (e.g. "#191")
}

/**
 * Compact "what's new" summary embedded in the release `update.json` and pushed
 * to the renderer with `updateAvailable`. Features-first: the update popover
 * shows the feature titles + a rollup count and links to the full Changelog
 * screen. Absent for cross-channel updates or pre-changelog `update.json`.
 */
export interface UpdateChangelog {
	features: string[]; // Short feature titles, newest first, already capped for display
	featureCount: number; // Total new features in the release window
	fixCount: number; // Total new fixes in the release window
}

/**
 * Result of the dev-only update-popover simulator (`previewUpdatePopover` RPC).
 * Runs the release-time release-window logic against the local `change-logs/`
 * dir + git tags so a developer can preview the next release's "what's new"
 * popover before shipping. Unavailable on production bundles (no change-logs
 * dir / not a git checkout).
 */
export interface UpdatePopoverPreview {
	available: boolean; // false when there is no change-logs dir or the app is not running from a git checkout
	reason?: string; // machine-readable why-unavailable code, when available === false
	changelog: UpdateChangelog | null; // exactly what the real popover would render
	diagnostics: {
		prevTag: string | null; // release tag the window is measured from (null → fallback / no tags)
		usedFallback: boolean; // git window empty → fell back to the newest-day batch
		windowFiles: string[]; // "<type>-<slug>" of each entry in the window
		totalEntries: number; // total parsed changelog entries (whole history)
		includesUncommitted: boolean; // window counts working-tree + untracked files, not just committed
		mergedPRs: number; // squash-merged PRs (commits with a "(#N)" subject) since prevTag
	};
}
