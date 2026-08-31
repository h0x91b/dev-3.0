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
import { getBranchStatus, getTaskDiff, _resetFetchState, _resetCompareRefCache } from "../git";

/**
 * A local clone whose history is truncated (shallow / grafted) hides the commit
 * a branch forked from. The two commands the git bar and the diff are built on
 * then disagree in the worst possible way: `git diff ref...HEAD` refuses to run,
 * while `git rev-list --count --left-right ref...HEAD` silently answers with the
 * whole history of each side. That is how the bar came to read "1889 ahead" for
 * a branch that was 2 ahead of a 1894-commit main.
 */

/** Each case builds a real repo out of ~10 git subprocesses; 5s is a coin flip on a loaded box. */
const REAL_GIT_TIMEOUT_MS = 60_000;

describe("git against a compare ref with no merge base", () => {
	let repo: TestRepo;

	/**
	 * Four commits on main, a branch forked three back with one of its own, then
	 * main's history cut one commit deep — the shape of the incident, in
	 * miniature. `.git/shallow` is git's own graft file; writing it is what `git
	 * fetch --depth` does, and git honours it identically.
	 */
	function shallowRepoWithEarlyBranch(local: string): void {
		commit(local, "f2");
		commit(local, "f3");
		commit(local, "f4");
		g("git checkout -b feature main~3", local);
		commit(local, "feat1");
		writeFileSync(join(local, ".git", "shallow"), g("git rev-parse main~1", local));
	}

	function commit(local: string, name: string): void {
		writeFileSync(join(local, `${name}.ts`), `export const ${name} = 1;\n`);
		g("git add -A", local);
		g(`git commit -m "${name}"`, local);
	}

	beforeEach(() => {
		repo = createTestRepo();
		_resetFetchState();
		_resetCompareRefCache();
	}, REAL_GIT_TIMEOUT_MS);

	afterEach(() => {
		cleanup(repo);
	}, REAL_GIT_TIMEOUT_MS);

	it("reports the counts as unknown instead of git's degraded answer", async () => {
		shallowRepoWithEarlyBranch(repo.local);

		// What git says on its own, and what the bar used to print verbatim: both
		// numbers are a whole history, and both are wrong (the truth is 1 ahead,
		// 3 behind). Asserted so the test fails loudly if git ever stops degrading
		// this way — the fix would then be guarding nothing.
		expect(g("git rev-list --count --left-right main...HEAD", repo.local).trim()).toBe("2\t2");

		expect(await getBranchStatus(repo.local, "main")).toEqual({
			ahead: 0,
			behind: 0,
			baseUnreachable: true,
		});
	}, REAL_GIT_TIMEOUT_MS);

	it("still counts normally when the fork point is reachable", async () => {
		commit(repo.local, "f2");
		commit(repo.local, "f3");
		g("git checkout -b feature main~1", repo.local);
		commit(repo.local, "feat");

		expect(await getBranchStatus(repo.local, "main")).toEqual({
			ahead: 1,
			behind: 1,
			baseUnreachable: false,
		});
	}, REAL_GIT_TIMEOUT_MS);

	it("names the branch diff empty-because-unmeasurable, not 'no changes'", async () => {
		shallowRepoWithEarlyBranch(repo.local);

		const diff = await getTaskDiff(repo.local, "branch", { baseBranch: "main", compareRef: "main" });

		expect(diff.fallbackReason).toBe("no-merge-base");
		expect(diff.files).toEqual([]);
		expect(diff.summary).toEqual({ files: 0, insertions: 0, deletions: 0 });
	}, REAL_GIT_TIMEOUT_MS);

	it("keeps a compare ref that is absent distinct from one with no merge base", async () => {
		shallowRepoWithEarlyBranch(repo.local);

		const diff = await getTaskDiff(repo.local, "branch", {
			baseBranch: "main",
			compareRef: "origin/does-not-exist",
		});

		expect(diff.fallbackReason).toBe("missing-compare-ref");
	}, REAL_GIT_TIMEOUT_MS);
});
