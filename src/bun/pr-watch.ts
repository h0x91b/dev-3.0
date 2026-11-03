import type { PRCheckInfo } from "../shared/types";
import type { PrStatusNotice, PrWatch } from "../shared/pr-watch";
import { ACTIVE_PROJECT_PENDING_PR_INTERVAL_MS } from "./rpc-handlers/git-poll-throttle";
import { summarizeChecks } from "./rpc-handlers/pr-status";

/** Two finished looks count as two only this far apart: one poll, less some slack. */
export const PR_WATCH_CONFIRM_GAP_MS = ACTIVE_PROJECT_PENDING_PR_INTERVAL_MS - 10_000;

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
	/** The newest remote refs disagree: no tip is authoritative, so no CI verdict is safe. */
	ambiguous: boolean;
	/** Is this commit in the local repository? A head pushed by someone else is not. */
	hasCommit(sha: string): Promise<boolean>;
	/** True when `ancestor` is an ancestor of `descendant`; false too when either commit is unknown here. */
	isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

export interface PrWatchOutcome {
	/** Watches that fired, each with what to tell its agent; empty means nothing fired. */
	fired: Array<{ watch: PrWatch; notice: PrStatusNotice }>;
	/** Watches that fired and are done. */
	removeIds: string[];
	/** Watches that stay, with the fields that moved. */
	patches: Record<string, Partial<Pick<PrWatch, "headSha" | "failedNotifiedHead" | "ciSeen" | "tipsAtSubscribe">>>;
}

/**
 * Judge a task's watches against one polled PR. A merge or close is a fact about the
 * PR whatever its head. A watch whose PR is no longer the branch's open PR ends.
 *
 * For CI the verdict is only about a head that is really the PR's now. With remote tips
 * known, a sample head this repository has must equal a tip or descend from one, else it
 * is stale (a lagging poll after a push or force-push, a pre-rebase head) and is skipped;
 * a head it does not have is someone else's push and counts as fresh, with no fetch.
 * A fresh head the watch does not have moves it, except one of the tips the branch had
 * when the watch was made: that is the push the watch was made after. Without tips only
 * a head that is an older ancestor of the watch's is skipped. When the newest remote refs
 * disagree no CI verdict is given at all. A finished-looking run
 * counts once seen again a poll later on one head with one total, because some checks
 * join the rollup late.
 */
export async function evaluatePrWatches(
	watches: readonly PrWatch[],
	sample: PrWatchSample,
	git: PrWatchGit,
	now: number = Date.now(),
): Promise<PrWatchOutcome> {
	const outcome: PrWatchOutcome = { fired: [], removeIds: [], patches: {} };
	const state = sample.state?.toUpperCase();
	if (state === "OPEN") {
		for (const watch of watches.filter((w) => w.prNumber !== sample.number)) {
			outcome.fired.push({ watch, notice: { kind: "replaced", oldNumber: watch.prNumber } });
			outcome.removeIds.push(watch.id);
		}
	}
	const mine = watches.filter((watch) => watch.prNumber === sample.number);
	if (mine.length === 0) return outcome;

	if (state === "MERGED" || state === "CLOSED") {
		const notice: PrStatusNotice = state === "MERGED" ? { kind: "merged" } : { kind: "closed" };
		for (const watch of mine) outcome.fired.push({ watch, notice });
		outcome.removeIds.push(...mine.map((watch) => watch.id));
		return outcome;
	}
	const head = sample.headRefOid;
	if (state !== "OPEN" || !head || git.ambiguous) return outcome;

	const { total, pending, failed } = summarizeChecks(sample.checks);
	const ciDone = total > 0 && pending === 0;
	if (git.tips.length > 0 && (await git.hasCommit(head))) {
		let fresh = false;
		for (const tip of git.tips) fresh ||= tip === head || (await git.isAncestor(tip, head));
		if (!fresh) return outcome;
	}
	for (const watch of mine) {
		if (watch.headSha !== head) {
			// A subscribe-time tip is the remote's old head while our rebase or amend is unpushed; a watch behind it follows it.
			if ((watch.tipsAtSubscribe ?? []).includes(head) && !(await git.isAncestor(watch.headSha, head))) continue;
			// With a known tip the freshness check above already filters lagging samples.
			if (git.tips.length === 0 && (await git.isAncestor(head, watch.headSha))) continue;
			outcome.patches[watch.id] = { headSha: head, tipsAtSubscribe: undefined };
		}
		const sameLook = watch.ciSeen?.head === head && watch.ciSeen.total === total;
		const confirmed = ciDone && sameLook && now - (watch.ciSeen?.at ?? 0) >= PR_WATCH_CONFIRM_GAP_MS;
		if (ciDone && !sameLook) {
			outcome.patches[watch.id] = { ...outcome.patches[watch.id], ciSeen: { head, total, at: now } };
		} else if (!ciDone && watch.ciSeen) {
			outcome.patches[watch.id] = { ...outcome.patches[watch.id], ciSeen: undefined };
		}
		if (!confirmed) continue;
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

/**
 * A pinned PR has no local remote refs to trust: GitHub's head is the PR's head, a
 * changed head is a new push to follow, and no commit needs to exist here.
 */
export const PINNED_PR_WATCH_GIT: PrWatchGit = {
	tips: [],
	ambiguous: false,
	hasCommit: async () => false,
	isAncestor: async () => false,
};

/** The PR a watch follows: the branch's PR (whatever its number) or one pinned number. */
function watchTarget(watch: PrWatch): number | "branch" {
	return watch.pinned ? watch.prNumber : "branch";
}

/** Add `next`, replacing any watch of the same kind on the same PR; one per kind and PR. */
export function upsertPrWatch(watches: readonly PrWatch[], next: PrWatch): PrWatch[] {
	return [...watches.filter((watch) => watch.until !== next.until || watchTarget(watch) !== watchTarget(next)), next];
}
