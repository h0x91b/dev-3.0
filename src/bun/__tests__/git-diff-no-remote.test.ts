import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test",
}));

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { writeFileSync } from "fs";
import { join } from "path";
import { createTestRepo, cleanup, g, type TestRepo } from "./git-test-helpers";
import { getTaskDiff, hasOriginRemote, detectDefaultCompareRef, resolveConfiguredCompareRef, _resetFetchState, _resetCompareRefCache } from "../git";

/**
 * A project added from a local folder has no remote. Every `origin/...` ref is
 * then absent, and an absent ref made `git diff` fail — which used to surface as
 * an empty diff, i.e. "no changes to show" for a comparison that never ran.
 */
describe("git in a repo with no remote", () => {
	let repo: TestRepo;

	/** Strip the remote the template repo ships with, leaving a purely local repo. */
	function detachRemote(local: string): void {
		g("git remote remove origin", local);
		g("git update-ref -d refs/remotes/origin/main", local);
	}

	beforeEach(() => {
		repo = createTestRepo();
		_resetFetchState();
		_resetCompareRefCache();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("hasOriginRemote turns false once the remote is gone, and the default compare ref is the local base branch", async () => {
		expect(await hasOriginRemote(repo.local)).toBe(true);
		detachRemote(repo.local);
		expect(await hasOriginRemote(repo.local)).toBe(false);
		expect(await detectDefaultCompareRef(repo.local, "main")).toBe("main");
	});

	it("diffs against the local base branch, and says a missing compare ref is missing instead of looking empty", async () => {
		detachRemote(repo.local);
		g("git checkout -q -b feature", repo.local);
		writeFileSync(join(repo.local, "added.ts"), "export const added = 1;\n");
		g("git add added.ts", repo.local);
		g('git commit -m "add a file"', repo.local);

		// The compare ref the handler resolves for a remoteless repo — see
		// `resolveCompareRef` in rpc-handlers/git-operations.ts.
		const local = await getTaskDiff(repo.local, "branch", { baseBranch: "main", compareRef: "main" });
		expect(local.fallbackReason).toBeNull();
		expect(local.summary.files).toBe(1);
		expect(local.files.map((f) => f.displayPath)).toEqual(["added.ts"]);

		// The regression itself: an `origin/main` that is not in the repo must never
		// answer "this diff is empty for the selected mode".
		const missing = await getTaskDiff(repo.local, "branch", { baseBranch: "main", compareRef: "origin/main" });
		expect(missing.fallbackReason).toBe("missing-compare-ref");
		expect(missing.compareRef).toBe("origin/main");
		expect(missing.summary).toEqual({ files: 0, insertions: 0, deletions: 0 });
		expect(missing.files).toEqual([]);

		// The unpushed mode reports the missing ref too, not no-upstream.
		const unpushed = await getTaskDiff(repo.local, "unpushed", { baseBranch: "main", compareRef: "origin/main" });
		expect(unpushed.fallbackReason).toBe("missing-compare-ref");
	});
});

describe("resolveConfiguredCompareRef", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		_resetFetchState();
		_resetCompareRefCache();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("keeps a configured ref the repo has, and falls back to the detected default when it is missing", async () => {
		expect(await resolveConfiguredCompareRef(repo.local, "main", "origin/main")).toBe("origin/main");
		expect(await resolveConfiguredCompareRef(repo.local, "main", "origin/master")).toBe("origin/main");
	});

	it("falls back to the local base when there is no remote at all", async () => {
		g("git remote remove origin", repo.local);
		g("git update-ref -d refs/remotes/origin/main", repo.local);
		expect(await resolveConfiguredCompareRef(repo.local, "main", "origin/main")).toBe("main");
	});
});
