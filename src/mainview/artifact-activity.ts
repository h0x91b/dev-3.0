/**
 * Was this window doing artifacts when it went quiet?
 *
 * Module-level for the same reason as `terminal-session-stats`: the heartbeat has
 * to answer for the whole page, not for one component, and a frozen window cannot
 * be asked anything afterwards.
 *
 * Deliberately coarse — a count and two timestamps. No document, no title, no task
 * id, nothing about what the artifact contains; this travels into a local
 * diagnostic record, and there is nothing in it worth reading about a person.
 */
export const artifactActivity = {
	/** Artifact viewers mounted right now (docked, popup or offscreen alike). */
	open: 0,
	/** Last open or close, epoch ms. 0 = no artifact in this page load at all. */
	lastActivityAt: 0,
};

export function artifactViewerOpened(now = Date.now()): void {
	artifactActivity.open += 1;
	artifactActivity.lastActivityAt = now;
}

export function artifactViewerClosed(now = Date.now()): void {
	artifactActivity.open = Math.max(0, artifactActivity.open - 1);
	artifactActivity.lastActivityAt = now;
}

/** Age of the last artifact event, or null when this page load never had one. */
export function artifactIdleMs(now = Date.now()): number | null {
	return artifactActivity.lastActivityAt === 0 ? null : Math.max(0, now - artifactActivity.lastActivityAt);
}

/** Test seam: each suite starts from a page that has never opened an artifact. */
export function resetArtifactActivity(): void {
	artifactActivity.open = 0;
	artifactActivity.lastActivityAt = 0;
}
