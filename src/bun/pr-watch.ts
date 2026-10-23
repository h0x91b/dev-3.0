import type { PRCheckInfo } from "../shared/types";
import type { PrStatusNotice, PrWatch } from "../shared/pr-watch";
import { summarizeChecks } from "./rpc-handlers/pr-status";

/** The slice of one polled PR that watches are judged against. */
export interface PrWatchSample {
	number: number;
	/** GitHub's `state`: OPEN, MERGED or CLOSED. */
	state?: string | null;
	headRefOid: string | null;
	checks: PRCheckInfo[];
}

/** What the verdict needs from the local repository. */
export interface PrWatchGit {
	/** What the remotes last had for the task's own branch; empty when it was never pushed. */
	tips: readonly string[];
	/** True when `ancestor` is an ancestor of `descendant`; false too when either commit is unknown here. */
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

export interface PrWatchOutcome {
	/** Watches that fired, each with what to tell its agent; empty means nothing fired. */
	fired: Array<{ watch: PrWatch; notice: PrStatusNotice }>;
	/** Watches that fired and are done. */
	removeIds: string[];
	/** Watches that stay, with the fields that moved. */
	patches: Record<string, Partial<Pick<PrWatch, "headSha" | "failedNotifiedHead">>>;
}

/**
 * Judge a task's watches against one polled PR. A merge or close is a fact about the
 * PR whatever its head. For CI the verdict is only about the head the agent pushed:
 * a head that is an older ancestor of the watch's head (the push is not visible on
 * GitHub yet) says nothing, and any other head — including one this repository has
 * not fetched — means the PR moved on, so the watch moves along.
 */
export async function evaluatePrWatches(
	watches: readonly PrWatch[],
	sample: PrWatchSample,
	git: PrWatchGit,
): Promise<PrWatchOutcome> {
	const outcome: PrWatchOutcome = { fired: [], removeIds: [], patches: {} };
	const mine = watches.filter((watch) => watch.prNumber === sample.number);
	const state = sample.state?.toUpperCase();
	if (mine.length === 0) return outcome;

	if (state === "MERGED" || state === "CLOSED") {
		const notice: PrStatusNotice = state === "MERGED" ? { kind: "merged" } : { kind: "closed" };
		for (const watch of mine) outcome.fired.push({ watch, notice });
		outcome.removeIds.push(...mine.map((watch) => watch.id));
		return outcome;
	}
	const head = sample.headRefOid;
	if (state !== "OPEN" || !head) return outcome;

	const { total, pending, failed } = summarizeChecks(sample.checks);
	const ciDone = total > 0 && pending === 0;
	// A late sample still showing a head the agent has since pushed past says nothing about the new one.
	for (const tip of git.tips) {
		if (tip !== head && (await git.isAncestor(head, tip))) return outcome;
	}
	for (const watch of mine) {
		if (watch.headSha !== head) {
			if (await git.isAncestor(head, watch.headSha)) continue;
			outcome.patches[watch.id] = { headSha: head };
		}
		if (!ciDone) continue;
		const failedNotice: PrStatusNotice = { kind: "ci-failed", sha: head, failedCount: failed.length, totalChecks: total };
		if (watch.until === "ci") {
			outcome.fired.push({ watch, notice: failed.length > 0 ? failedNotice : { kind: "ci-passed", sha: head, totalChecks: total } });
			outcome.removeIds.push(watch.id);
			delete outcome.patches[watch.id];
		} else if (failed.length > 0 && watch.failedNotifiedHead !== head) {
			outcome.fired.push({ watch, notice: failedNotice });
			outcome.patches[watch.id] = { ...outcome.patches[watch.id], failedNotifiedHead: head };
		}
	}
	return outcome;
}

/** The watch list after `outcome`, applied to whatever the task holds now. */
export function applyPrWatchOutcome(watches: readonly PrWatch[], outcome: Pick<PrWatchOutcome, "removeIds" | "patches">): PrWatch[] {
	return watches
		.filter((watch) => !outcome.removeIds.includes(watch.id))
		.map((watch) => (outcome.patches[watch.id] ? { ...watch, ...outcome.patches[watch.id] } : watch));
}

/** Add `next`, replacing any watch of the same kind; one per kind, so at most two stay. */
export function upsertPrWatch(watches: readonly PrWatch[], next: PrWatch): PrWatch[] {
	return [...watches.filter((watch) => watch.until !== next.until), next];
}
