import {
	collectWorktreeReport,
	prune,
	type PruneOutcome,
	type WorktreeScanDeps,
} from "../cli/commands/doctor-worktrees";
import { BUNDLE_RETENTION_DAYS, collectMediaReport, MEDIA_RETENTION_DAYS, pruneMedia } from "../cli/commands/doctor-media";

/**
 * The daily cleanup is literally `dev3 doctor --worktrees --prune-older-than 14d`:
 * the same scan and the same `prune()`, with no orphan pruning and no
 * `--force-unmerged`, so it only ever deletes diffs/logs of finished tasks —
 * plus `--prune-media-older-than 60d --prune-bundles-older-than 30d` for large
 * shared media and stored artifact ZIPs no open task holds.
 */
export const DAILY_PRUNE_OLDER_THAN_DAYS = 14;

export interface WorktreeCleanupResult {
	scannedDirs: number;
	bytesBefore: number;
	removedDirs: number;
	/** Worktree prune plus large-media prune. */
	freedBytes: number;
	removedMediaFiles: number;
	skipped: number;
	failed: number;
	/** Removed or failed entries only — what the log names. */
	outcomes: PruneOutcome[];
	/** Whatever {@link WorktreeCleanupSteps.afterPrune} returned, when one ran. */
	afterPrune?: unknown;
}

export interface WorktreeCleanupSteps {
	/** Runs on what the prune kept: the worker gzips the remaining diff snapshots here. */
	afterPrune?: (taskDirs: string[]) => unknown;
}

export function runWorktreeCleanup(deps: WorktreeScanDeps, steps: WorktreeCleanupSteps = {}): WorktreeCleanupResult {
	const report = collectWorktreeReport(deps);
	const outcomes = prune(
		report,
		{ orphans: false, olderThanDays: DAILY_PRUNE_OLDER_THAN_DAYS, forceUnmerged: false },
		deps,
	);
	const mediaOutcomes = pruneMedia(
		collectMediaReport(deps),
		{ mediaDays: MEDIA_RETENTION_DAYS, bundleDays: BUNDLE_RETENTION_DAYS },
		deps,
	);
	const afterPrune = steps.afterPrune ? steps.afterPrune(report.entries.map((e) => e.dir)) : undefined;
	return {
		afterPrune,
		scannedDirs: report.entries.length,
		bytesBefore: report.totalBytes,
		removedDirs: outcomes.filter((o) => o.action === "removed-dir").length,
		freedBytes: [...outcomes, ...mediaOutcomes].reduce((sum, o) => sum + o.freedBytes, 0),
		removedMediaFiles: mediaOutcomes.filter((o) => o.action === "removed").length,
		skipped: outcomes.filter((o) => o.action === "skipped").length,
		failed: [...outcomes, ...mediaOutcomes].filter((o) => o.action === "failed").length,
		outcomes: outcomes.filter((o) => o.action !== "skipped"),
	};
}
