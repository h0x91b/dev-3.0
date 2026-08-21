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
import { getTaskDiff, hasOriginRemote, detectDefaultCompareRef, _resetFetchState, _resetCompareRefCache } from "../git";

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

	it("hasOriginRemote is false once the remote is gone, true while it is there", async () => {
		expect(await hasOriginRemote(repo.local)).toBe(true);
		detachRemote(repo.local);
		expect(await hasOriginRemote(repo.local)).toBe(false);
	});

	it("detectDefaultCompareRef resolves to the local base branch", async () => {
		detachRemote(repo.local);
		expect(await detectDefaultCompareRef(repo.local, "main")).toBe("main");
	});

	it("branch diff against the local base branch reports the real changes", async () => {
		detachRemote(repo.local);
		g("git checkout -q -b feature", repo.local);
		writeFileSync(join(repo.local, "added.ts"), "export const added = 1;\n");
		g("git add added.ts", repo.local);
		g('git commit -m "add a file"', repo.local);

		// The compare ref the handler resolves for a remoteless repo — see
		// `resolveCompareRef` in rpc-handlers/git-operations.ts.
		const result = await getTaskDiff(repo.local, "branch", { baseBranch: "main", compareRef: "main" });

		expect(result.fallbackReason).toBeNull();
		expect(result.summary.files).toBe(1);
		expect(result.files.map((f) => f.displayPath)).toEqual(["added.ts"]);
	});

	// The regression itself: an `origin/main` that is not in the repo must never
	// answer "this diff is empty for the selected mode".
	it("branch diff against a missing compare ref says so instead of looking empty", async () => {
		detachRemote(repo.local);
		g("git checkout -q -b feature", repo.local);
		writeFileSync(join(repo.local, "added.ts"), "export const added = 1;\n");
		g("git add added.ts", repo.local);
		g('git commit -m "add a file"', repo.local);

		const result = await getTaskDiff(repo.local, "branch", { baseBranch: "main", compareRef: "origin/main" });

		expect(result.fallbackReason).toBe("missing-compare-ref");
		expect(result.compareRef).toBe("origin/main");
		expect(result.summary).toEqual({ files: 0, insertions: 0, deletions: 0 });
		expect(result.files).toEqual([]);
	});

	it("unpushed diff against a missing compare ref reports the missing ref, not no-upstream", async () => {
		detachRemote(repo.local);
		g("git checkout -q -b feature", repo.local);
		writeFileSync(join(repo.local, "added.ts"), "export const added = 1;\n");
		g("git add added.ts", repo.local);
		g('git commit -m "add a file"', repo.local);

		const result = await getTaskDiff(repo.local, "unpushed", { baseBranch: "main", compareRef: "origin/main" });

		expect(result.fallbackReason).toBe("missing-compare-ref");
	});
});
