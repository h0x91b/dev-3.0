import { describe, expect, it } from "vitest";
import type { PRCheckInfo } from "../../shared/types";
import type { PrWatch } from "../../shared/pr-watch";
import { applyPrWatchOutcome, evaluatePrWatches, upsertPrWatch, type PrWatchGit, type PrWatchSample } from "../pr-watch";

const OLD = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const NEWER = "3333333333333333333333333333333333333333";

const check = (name: string, status: string, conclusion: string | null): PRCheckInfo => ({ name, status, conclusion, detailsUrl: null });
const green = [check("lint", "COMPLETED", "SUCCESS"), check("test", "COMPLETED", "SUCCESS")];
const red = [check("lint", "COMPLETED", "FAILURE"), check("test", "COMPLETED", "SUCCESS")];

function watch(until: PrWatch["until"], overrides: Partial<PrWatch> = {}): PrWatch {
	return { id: `w-${until}`, until, prNumber: 7, headSha: HEAD, createdAt: "2026-10-22T10:00:00.000Z", ...overrides };
}

function sample(overrides: Partial<PrWatchSample> = {}): PrWatchSample {
	return { number: 7, state: "OPEN", headRefOid: HEAD, checks: green, ...overrides };
}

/** Local repo facts: which head is an ancestor of which (any unlisted pair is not, an unknown commit included), and what the remotes have for the branch. */
function fakeGit(opts: { ancestors?: Array<[string, string]>; tips?: string[] } = {}): PrWatchGit {
	const ancestors = opts.ancestors ?? [];
	return { tips: opts.tips ?? [], isAncestor: async (a, d) => ancestors.some(([x, y]) => x === a && y === d) };
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

	it("keeps waiting while any check is pending, even when another already failed", async () => {
		const checks = [check("lint", "COMPLETED", "FAILURE"), check("test", "IN_PROGRESS", null)];
		const out = await evaluatePrWatches([watch("ci")], sample({ checks }), fakeGit());
		expect(out).toEqual(EMPTY);
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
			[{ ...seen, headSha: HEAD }],
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
		expect(out.patches).toEqual({ "w-ci": { headSha: HEAD } });
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
		const out = await evaluatePrWatches([watch("ci")], sample({ headRefOid: NEWER, checks: red }), fakeGit());
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

		const current = await evaluatePrWatches([watch("ci")], sample({ headRefOid: NEWER }), git);
		expect(notices(current)).toEqual([{ kind: "ci-passed", sha: NEWER, totalChecks: 2 }]);
	});

	it("judges the head when the branch has no remote ref to be behind", async () => {
		const out = await evaluatePrWatches([watch("ci")], sample({ headRefOid: HEAD }), fakeGit({ tips: [] }));
		expect(notices(out)).toEqual([{ kind: "ci-passed", sha: HEAD, totalChecks: 2 }]);
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
});
