import { describe, expect, it } from "vitest";
import type { PRCheckInfo } from "../../shared/types";
import type { PrWatch } from "../../shared/pr-watch";
import { applyPrWatchOutcome, evaluatePrWatches, PINNED_PR_WATCH_GIT, upsertPrWatch, type PrWatchGit, type PrWatchSample } from "../pr-watch";

const OLD = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const NEWER = "3333333333333333333333333333333333333333";
const REBASED = "4444444444444444444444444444444444444444";
const NOW = 1_800_000_000_000;
const seenOn = (head: string, total = 2, at = 0) => ({ head, total, at });

const check = (name: string, status: string, conclusion: string | null): PRCheckInfo => ({ name, status, conclusion, detailsUrl: null });
const green = [check("lint", "COMPLETED", "SUCCESS"), check("test", "COMPLETED", "SUCCESS")];
const red = [check("lint", "COMPLETED", "FAILURE"), check("test", "COMPLETED", "SUCCESS")];

function watch(until: PrWatch["until"], overrides: Partial<PrWatch> = {}): PrWatch {
	// Already seen finished once on HEAD, so the next finished sample confirms it.
	return { id: `w-${until}`, until, prNumber: 7, headSha: HEAD, createdAt: "2026-10-22T10:00:00.000Z", ciSeen: seenOn(HEAD), ...overrides };
}

function sample(overrides: Partial<PrWatchSample> = {}): PrWatchSample {
	return { number: 7, state: "OPEN", headRefOid: HEAD, checks: green, ...overrides };
}

/** Local repo facts: which head is an ancestor of which (any unlisted pair is not, an unknown commit included), and what the remotes have for the branch. */
function fakeGit(opts: { ancestors?: Array<[string, string]>; tips?: string[]; missing?: string[]; ambiguous?: boolean } = {}): PrWatchGit {
	const ancestors = opts.ancestors ?? [];
	return {
		tips: opts.tips ?? [],
		ambiguous: opts.ambiguous ?? false,
		hasCommit: async (sha) => !(opts.missing ?? []).includes(sha),
		isAncestor: async (a, d) => ancestors.some(([x, y]) => x === a && y === d),
	};
}

const notices = (out: { fired: Array<{ notice: unknown }> }) => out.fired.map(({ notice }) => notice);
const EMPTY = { fired: [], removeIds: [], patches: {} };

describe("evaluatePrWatches", () => {
	it("fires an `until ci` watch green once every check finished passing", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample(), fakeGit());
		expect(notices(out)).toEqual([{ kind: "ci-passed", sha: HEAD, totalChecks: 2 }]);
		expect(out.removeIds).toEqual(["w-ci"]);
	});

	it("fires an `until ci` watch red with the failed check names", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample({ checks: red }), fakeGit());
		expect(notices(out)).toEqual([{ kind: "ci-failed", sha: HEAD, failedCount: 1, totalChecks: 2 }]);
		expect(out.removeIds).toEqual(["w-ci"]);
	});

	it("keeps waiting while any check is pending, even when another already failed, and forgets the earlier finished look", async () => {
		const checks = [check("lint", "COMPLETED", "FAILURE"), check("test", "IN_PROGRESS", null)];
		const out = await evaluatePrWatches([watch("ci")], sample({ checks }), fakeGit());
		expect(out).toEqual({ fired: [], removeIds: [], patches: { "w-ci": { ciSeen: undefined } } });
	});

	it("keeps waiting on a null or empty rollup", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample({ checks: [] }), fakeGit());
		expect(notices(out)).toEqual([]);
	});

	it("fires `until ci` with `merged` when the PR merged before CI finished", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample({ state: "MERGED", checks: [] }), fakeGit());
		expect(notices(out)).toEqual([{ kind: "merged" }]);
		expect(out.removeIds).toEqual(["w-ci"]);
	});

	it("fires `until ci` with `closed` when the PR was closed", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample({ state: "CLOSED" }), fakeGit());
		expect(notices(out)).toEqual([{ kind: "closed" }]);
	});

	it("fires `until merged` on merge and on close, and removes the watch", async () => {
		const merged = await evaluatePrWatches([watch("merged")], sample({ state: "MERGED" }), fakeGit());
		const closed = await evaluatePrWatches([watch("merged")], sample({ state: "CLOSED" }), fakeGit());
		expect(notices(merged)).toEqual([{ kind: "merged" }]);
		expect(notices(closed)).toEqual([{ kind: "closed" }]);
		expect(merged.removeIds).toEqual(["w-merged"]);
	});

	it("does not fire `until merged` on a green CI", async () => {
		const out = await evaluatePrWatches([watch("merged")], sample(), fakeGit());
		expect(out).toEqual(EMPTY);
	});

	it("reports a red CI to an `until merged` watch, keeps it, and remembers the head", async () => {
		const out = await evaluatePrWatches([watch("merged")], sample({ checks: red }), fakeGit());
		expect(notices(out)).toHaveLength(1);
		expect(out.removeIds).toEqual([]);
		expect(out.patches).toEqual({ "w-merged": { failedNotifiedHead: HEAD } });
	});

	it("reports a red CI to an `until merged` watch once per head", async () => {
		const seen = watch("merged", { failedNotifiedHead: HEAD });
		const again = await evaluatePrWatches([seen], sample({ checks: red }), fakeGit());
		expect(notices(again)).toEqual([]);
		const pushed = await evaluatePrWatches(
			[{ ...seen, headSha: HEAD, ciSeen: seenOn(NEWER) }],
			sample({ headRefOid: NEWER, checks: red }),
			fakeGit({ ancestors: [] }),
		);
		expect(notices(pushed)).toHaveLength(1);
		expect(pushed.patches["w-merged"]).toEqual({ headSha: NEWER, failedNotifiedHead: NEWER });
	});

	it("turns two watches firing on one sample into notices the message builder can merge", async () => {
		const out = await evaluatePrWatches([watch("ci"), watch("merged")], sample({ checks: red }), fakeGit());
		expect(notices(out)).toHaveLength(2);
		expect(notices(out)[0]).toEqual(notices(out)[1]);
		expect(out.removeIds).toEqual(["w-ci"]);
	});

	it("moves the watch to a new head the agent pushed, and judges that head", async () => {
		const out = await evaluatePrWatches([watch("merged", { headSha: OLD })], sample({ checks: red }), fakeGit());
		expect(out.patches["w-merged"]).toMatchObject({ headSha: HEAD });
	});

	it("retargets without a notice while the new head's CI is still running", async () => {
		const checks = [check("lint", "QUEUED", null)];
		const out = await evaluatePrWatches([watch("ci", { headSha: OLD })], sample({ checks }), fakeGit());
		expect(notices(out)).toEqual([]);
		expect(out.patches).toEqual({ "w-ci": { headSha: HEAD, ciSeen: undefined } });
	});

	it("ignores a sample whose head is an older ancestor of the watch's head", async () => {
		const out = await evaluatePrWatches(
			[watch("ci", { headSha: NEWER })],
			sample({ headRefOid: HEAD, checks: red }),
			fakeGit({ ancestors: [[HEAD, NEWER]] }),
		);
		expect(out).toEqual(EMPTY);
	});

	it("fires merged whether or not this repository ever fetched the PR's head", async () => {
		const unknownHead = await evaluatePrWatches([watch("merged")], sample({ state: "MERGED", headRefOid: NEWER }), fakeGit());
		const noHead = await evaluatePrWatches([watch("ci")], sample({ state: "MERGED", headRefOid: null }), fakeGit());
		expect(notices(unknownHead)).toEqual([{ kind: "merged" }]);
		expect(notices(noHead)).toEqual([{ kind: "merged" }]);
	});

	it("treats an open sample whose head is unknown here as a moved head and judges it", async () => {
		const out = await evaluatePrWatches([watch("ci", { ciSeen: seenOn(NEWER) })], sample({ headRefOid: NEWER, checks: red }), fakeGit());
		expect(notices(out)).toEqual([{ kind: "ci-failed", sha: NEWER, failedCount: 1, totalChecks: 2 }]);
	});

	it("says nothing about an open sample without a head", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample({ headRefOid: null }), fakeGit());
		expect(out).toEqual(EMPTY);
	});

	it("ignores a late sample of the old head after the agent pushed a new one, then judges the new head", async () => {
		const git = fakeGit({ tips: [NEWER], ancestors: [[HEAD, NEWER]] });

		const late = await evaluatePrWatches([watch("ci")], sample({ headRefOid: HEAD }), git);
		expect(late).toEqual(EMPTY);

		const current = await evaluatePrWatches([watch("ci", { ciSeen: seenOn(NEWER) })], sample({ headRefOid: NEWER }), git);
		expect(notices(current)).toEqual([{ kind: "ci-passed", sha: NEWER, totalChecks: 2 }]);
	});

	it("judges the head when the branch has no remote ref to be behind", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample({ headRefOid: HEAD }), fakeGit({ tips: [] }));
		expect(notices(out)).toEqual([{ kind: "ci-passed", sha: HEAD, totalChecks: 2 }]);
	});

	it("ignores the old head after a force-push and leaves the watch on the rebased head", async () => {
		const out = await evaluatePrWatches([watch("ci", { headSha: REBASED })], sample({ headRefOid: HEAD }), fakeGit({ tips: [REBASED] }));
		expect(out).toEqual(EMPTY);
	});

	it("still follows a push someone else made on top of a known tip", async () => {
		const git = fakeGit({ tips: [HEAD], ancestors: [[HEAD, NEWER]] });
		const out = await evaluatePrWatches([watch("ci", { ciSeen: seenOn(NEWER) })], sample({ headRefOid: NEWER }), git);
		expect(notices(out)).toEqual([{ kind: "ci-passed", sha: NEWER, totalChecks: 2 }]);

		const moved = await evaluatePrWatches([watch("merged")], sample({ headRefOid: NEWER, checks: [check("a", "QUEUED", null)] }), git);
		expect(moved.patches["w-merged"]).toMatchObject({ headSha: NEWER });
	});

	it("still reports a merge from a sample of an older head", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample({ state: "MERGED" }), fakeGit({ tips: [NEWER], ancestors: [[HEAD, NEWER]] }));
		expect(notices(out)).toEqual([{ kind: "merged" }]);
	});

	it("ignores a sample of a different PR number", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample({ number: 8, state: "MERGED" }), fakeGit());
		expect(out).toEqual(EMPTY);
	});
});

describe("a finished run is confirmed by a second sample", () => {
	const first = (until: PrWatch["until"] = "ci") => watch(until, { ciSeen: undefined });

	it("notes the first finished look and fires nothing", async () => {
		const out = await evaluatePrWatches([first()], sample(), fakeGit(), NOW);
		expect(out).toEqual({ fired: [], removeIds: [], patches: { "w-ci": { ciSeen: seenOn(HEAD, 2, NOW) } } });
	});

	it("fires on the second finished look at the same head and total", async () => {
		const out = await evaluatePrWatches([watch("ci", { ciSeen: seenOn(HEAD) })], sample(), fakeGit());
		expect(notices(out)).toEqual([{ kind: "ci-passed", sha: HEAD, totalChecks: 2 }]);
	});

	it("starts over when a check joined late and the total changed", async () => {
		const out = await evaluatePrWatches([watch("ci", { ciSeen: seenOn(HEAD, 1) })], sample(), fakeGit());
		expect(out.fired).toEqual([]);
		expect(out.patches["w-ci"]).toMatchObject({ ciSeen: { head: HEAD, total: 2 } });
	});

	it("starts over when the head changed", async () => {
		const out = await evaluatePrWatches([watch("ci", { ciSeen: seenOn(OLD) })], sample(), fakeGit());
		expect(out.fired).toEqual([]);
	});

	it("holds an `until merged` red CI notice back until it is confirmed too", async () => {
		const unconfirmed = await evaluatePrWatches([first("merged")], sample({ checks: red }), fakeGit(), NOW);
		expect(unconfirmed.fired).toEqual([]);
		expect(unconfirmed.patches["w-merged"]).toEqual({ ciSeen: seenOn(HEAD, 2, NOW) });

		const confirmed = await evaluatePrWatches([watch("merged", { ciSeen: seenOn(HEAD) })], sample({ checks: red }), fakeGit());
		expect(notices(confirmed)).toHaveLength(1);
	});
});

describe("a second look counts only a poll later", () => {
	const seenAt = (at: number) => watch("ci", { ciSeen: seenOn(HEAD, 2, at) });

	it("does not fire on a second sample two seconds after the first, and keeps the first look", async () => {
		const out = await evaluatePrWatches([seenAt(NOW)], sample(), fakeGit(), NOW + 2_000);
		expect(out).toEqual(EMPTY);
	});

	it("fires on a second sample a poll later", async () => {
		const out = await evaluatePrWatches([seenAt(NOW)], sample(), fakeGit(), NOW + 60_000);
		expect(notices(out)).toEqual([{ kind: "ci-passed", sha: HEAD, totalChecks: 2 }]);
	});
});

describe("what happens to the watch's head as the agent pushes", () => {
	const B = "b".repeat(40);
	const R = "c".repeat(40);
	const L = "d".repeat(40);
	const O = "e".repeat(40);
	const F = "f".repeat(40);
	const pushed = (head: string, tips: string[], at = 0) => watch("ci", { headSha: head, tipsAtSubscribe: tips, ciSeen: seenOn(head, 2, at) });

	it("follows a force-push made after subscribing, and ignores the old head that still shows late", async () => {
		const git = fakeGit({ tips: [R] });
		const first = await evaluatePrWatches([watch("ci", { headSha: B, tipsAtSubscribe: [B], ciSeen: undefined })], sample({ headRefOid: R }), git, NOW);
		expect(first.patches["w-ci"]).toEqual({ headSha: R, ciSeen: seenOn(R, 2, NOW) });

		const second = await evaluatePrWatches([pushed(R, [B], NOW)], sample({ headRefOid: R }), git, NOW + 60_000);
		expect(notices(second)).toEqual([{ kind: "ci-passed", sha: R, totalChecks: 2 }]);

		const late = await evaluatePrWatches([pushed(R, [B])], sample({ headRefOid: B }), git);
		expect(late).toEqual(EMPTY);
	});

	it("does not move to the pushed head the watch was made after, while the local rebase is unpushed; then reports the pushed one", async () => {
		const waiting = await evaluatePrWatches([pushed(L, [O])], sample({ headRefOid: O }), fakeGit({ tips: [O] }));
		expect(waiting).toEqual(EMPTY);

		const after = await evaluatePrWatches([pushed(L, [O])], sample({ headRefOid: L }), fakeGit({ tips: [L] }));
		expect(notices(after)).toEqual([{ kind: "ci-passed", sha: L, totalChecks: 2 }]);
	});

	it("reports the amended head pushed after a local amend", async () => {
		const amended = "a".repeat(40);
		const out = await evaluatePrWatches([watch("ci", { headSha: L, tipsAtSubscribe: [O], ciSeen: seenOn(amended) })], sample({ headRefOid: amended }), fakeGit({ tips: [amended] }));
		expect(notices(out)).toEqual([{ kind: "ci-passed", sha: amended, totalChecks: 2 }]);
	});

	it("treats a head this repository does not have as someone else's push on top, with no fetch", async () => {
		const out = await evaluatePrWatches(
			[watch("ci", { headSha: B, tipsAtSubscribe: [B], ciSeen: seenOn(F) })],
			sample({ headRefOid: F }),
			fakeGit({ tips: [B], missing: [F] }),
		);
		expect(notices(out)).toEqual([{ kind: "ci-passed", sha: F, totalChecks: 2 }]);
	});

	it("follows a remote tip the local HEAD is behind, after samples a poll apart", async () => {
		const D = "8".repeat(40);
		const git = fakeGit({ tips: [D], ancestors: [[B, D]] });
		const w = watch("ci", { headSha: B, tipsAtSubscribe: [D], ciSeen: undefined });
		const first = await evaluatePrWatches([w], sample({ headRefOid: D }), git, NOW);
		expect(first.patches["w-ci"]).toMatchObject({ headSha: D, ciSeen: seenOn(D, 2, NOW) });
		const second = await evaluatePrWatches([{ ...w, ...first.patches["w-ci"] }], sample({ headRefOid: D }), git, NOW + 61_000);
		expect(notices(second)).toEqual([{ kind: "ci-passed", sha: D, totalChecks: 2 }]);
	});

	it("drops the subscribe-time protection once the watch has moved, so a force-push back to that tip is followed", async () => {
		const C = "7".repeat(40);
		const w = watch("ci", { headSha: B, tipsAtSubscribe: [B], ciSeen: undefined });
		const toC = await evaluatePrWatches([w], sample({ headRefOid: C }), fakeGit({ tips: [C] }), NOW);
		const moved = { ...w, ...toC.patches["w-ci"] };
		expect(moved.tipsAtSubscribe).toBeUndefined();
		const back = await evaluatePrWatches([moved], sample({ headRefOid: B }), fakeGit({ tips: [B] }), NOW + 61_000);
		expect(back.patches["w-ci"]).toMatchObject({ headSha: B });
	});

	it("follows a reset back to an ancestor of the watch's head when a known tip says so", async () => {
		const C = "7".repeat(40);
		const git = fakeGit({ tips: [B], ancestors: [[B, C]] });
		const w = watch("ci", { headSha: C, ciSeen: undefined });
		const first = await evaluatePrWatches([w], sample({ headRefOid: B }), git, NOW);
		expect(first.patches["w-ci"]).toMatchObject({ headSha: B });
		const second = await evaluatePrWatches([{ ...w, ...first.patches["w-ci"] }], sample({ headRefOid: B }), git, NOW + 61_000);
		expect(notices(second)).toEqual([{ kind: "ci-passed", sha: B, totalChecks: 2 }]);
	});

	it("gives no CI verdict, moves nothing and records nothing while the newest remote refs disagree", async () => {
		const A = "9".repeat(40);
		const S = "6".repeat(40);
		const git = fakeGit({ tips: [A, B], ambiguous: true });
		const w = watch("ci", { headSha: B, tipsAtSubscribe: [S], ciSeen: undefined });
		expect(await evaluatePrWatches([w], sample({ headRefOid: A }), git, NOW)).toEqual(EMPTY);
		expect(await evaluatePrWatches([w], sample({ headRefOid: A }), git, NOW + 60_000)).toEqual(EMPTY);
	});

	it("still ends watches on merge, close or another PR while the refs disagree", async () => {
		const git = fakeGit({ tips: [B, R], ambiguous: true });
		const merged = await evaluatePrWatches([watch("ci")], sample({ state: "MERGED" }), git);
		expect(notices(merged)).toEqual([{ kind: "merged" }]);
		const replaced = await evaluatePrWatches([watch("ci", { prNumber: 5 })], sample(), git);
		expect(replaced.fired[0].notice).toEqual({ kind: "replaced", oldNumber: 5 });
	});

	it("skips the older head a stale second remote still shows, once the newest tip is the authoritative one", async () => {
		const A = "9".repeat(40);
		const git = fakeGit({ tips: [B] });
		const out1 = await evaluatePrWatches([pushed(B, [B])], sample({ headRefOid: A }), git, NOW);
		const out2 = await evaluatePrWatches([pushed(B, [B])], sample({ headRefOid: A }), git, NOW + 60_000);
		expect(out1).toEqual(EMPTY);
		expect(out2).toEqual(EMPTY);
	});
});

describe("a watch whose PR is no longer the branch's open PR", () => {
	it("ends with a notice when an open sample carries another number", async () => {
		const out = await evaluatePrWatches([watch("ci", { prNumber: 5 }), watch("merged")], sample(), fakeGit());
		expect(out.fired[0]).toEqual({ watch: watch("ci", { prNumber: 5 }), notice: { kind: "replaced", oldNumber: 5 } });
		expect(out.removeIds).toEqual(["w-ci"]);
	});

	it("is left alone by a merged or closed sample of another PR", async () => {
		const out = await evaluatePrWatches([watch("ci", { prNumber: 5 })], sample({ state: "MERGED" }), fakeGit());
		expect(out).toEqual(EMPTY);
	});
});

describe("watch list helpers", () => {
	it("applies removals and patches to whatever the task holds now", () => {
		const current = [watch("ci"), watch("merged")];
		const next = applyPrWatchOutcome(current, { removeIds: ["w-ci"], patches: { "w-merged": { headSha: NEWER } } });
		expect(next).toEqual([watch("merged", { headSha: NEWER })]);
	});

	it("replaces a watch of the same kind instead of duplicating it, keeping at most two", () => {
		const first = upsertPrWatch(upsertPrWatch([], watch("ci")), watch("merged"));
		const replaced = upsertPrWatch(first, watch("ci", { id: "w-new", prNumber: 9 }));
		expect(replaced.map((w) => w.id).sort()).toEqual(["w-merged", "w-new"]);
	});

	it("keeps watches of the same kind on different PRs side by side, one per kind and PR", () => {
		const own = watch("ci");
		const pinnedA = watch("ci", { id: "a", prNumber: 2111, pinned: true });
		const pinnedB = watch("ci", { id: "b", prNumber: 2112, pinned: true });
		const all = upsertPrWatch(upsertPrWatch(upsertPrWatch([], own), pinnedA), pinnedB);
		expect(all.map((w) => w.id)).toEqual(["w-ci", "a", "b"]);
		const replaced = upsertPrWatch(all, watch("ci", { id: "a2", prNumber: 2111, pinned: true }));
		expect(replaced.map((w) => w.id)).toEqual(["w-ci", "b", "a2"]);
	});
});

describe("a pinned PR's verdict", () => {
	it("moves to a new head GitHub reports, even one this repository has never seen, and confirms CI there", async () => {
		const pinned = watch("ci", { prNumber: 7, pinned: true, headSha: OLD, ciSeen: undefined });
		const first = await evaluatePrWatches([pinned], sample({ headRefOid: HEAD }), PINNED_PR_WATCH_GIT, NOW);
		expect(first.patches[pinned.id]).toMatchObject({ headSha: HEAD, ciSeen: { head: HEAD, total: 2, at: NOW } });
		expect(first.fired).toEqual([]);

		const moved = { ...pinned, ...first.patches[pinned.id] } as PrWatch;
		const second = await evaluatePrWatches([moved], sample({ headRefOid: HEAD }), PINNED_PR_WATCH_GIT, NOW + 60_000);
		expect(second.fired).toEqual([{ watch: moved, notice: { kind: "ci-passed", sha: HEAD, totalChecks: 2 } }]);
	});

	it("follows a force-push back to an older head instead of treating it as a lagging sample", async () => {
		const pinned = watch("ci", { prNumber: 7, pinned: true, headSha: HEAD, ciSeen: undefined });
		const out = await evaluatePrWatches([pinned], sample({ headRefOid: OLD }), PINNED_PR_WATCH_GIT, NOW);
		expect(out.patches[pinned.id]).toMatchObject({ headSha: OLD });
	});
});
