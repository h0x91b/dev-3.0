/**
 * `isPreservedOutsideBranch` against real git repos. Mocked spawn cannot answer
 * this: the whole question is which refs a real git considers HEAD reachable
 * from, and the `--exclude` spelling that decides it is silently forgiving —
 * `--exclude=refs/heads/<branch>` matches nothing for `--branches`, which leaves
 * the task branch in the negative set and makes every branch read as preserved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/dev3-test" }));

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { isPreservedOutsideBranch } from "../git";
import { createTestRepo, cleanup, makeTaskCommits, g, type TestRepo } from "./git-test-helpers";

describe("isPreservedOutsideBranch", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		g("git checkout -b dev3/task-branch", repo.local);
		makeTaskCommits(repo.local);
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("commits live only on the task branch: not preserved", async () => {
		// The regression guard for the `--exclude` spelling. The task branch reaches
		// its own HEAD by definition, so a check that fails to exclude it answers
		// "preserved" here and silences every real loss warning.
		expect(await isPreservedOutsideBranch(repo.local, "dev3/task-branch")).toBe(false);
	});

	it("fast-forwarded into the local base branch: preserved (issue #1684)", async () => {
		g("git checkout main", repo.local);
		g("git merge --ff-only dev3/task-branch", repo.local);
		g("git checkout dev3/task-branch", repo.local);

		expect(await isPreservedOutsideBranch(repo.local, "dev3/task-branch")).toBe(true);
	});

	it("another local branch holds the commits: preserved", async () => {
		g("git branch keep/backup dev3/task-branch", repo.local);
		expect(await isPreservedOutsideBranch(repo.local, "dev3/task-branch")).toBe(true);
	});

	it("a tag holds the commits: preserved", async () => {
		g("git tag v9.9.9 dev3/task-branch", repo.local);
		expect(await isPreservedOutsideBranch(repo.local, "dev3/task-branch")).toBe(true);
	});

	it("a remote-tracking ref under another name holds the commits: preserved", async () => {
		// Completing a task deletes only the local branch, so a remote-tracking ref
		// outlives it and must stay in the negative set.
		g("git push origin HEAD:feature/example", repo.local);
		g("git fetch origin", repo.local);

		expect(await isPreservedOutsideBranch(repo.local, "dev3/task-branch")).toBe(true);
	});

	it("merged locally, then one more commit on top: not preserved", async () => {
		g("git checkout main", repo.local);
		g("git merge --ff-only dev3/task-branch", repo.local);
		g("git checkout dev3/task-branch", repo.local);
		makeTaskCommits(repo.local);

		expect(await isPreservedOutsideBranch(repo.local, "dev3/task-branch")).toBe(false);
	});

	it("a branch whose name merely starts with the task branch's is not the task branch", async () => {
		// `--exclude` is a glob; an over-broad one would drop the sibling from the
		// negative set and under-report preservation.
		g("git branch dev3/task-branch-2 dev3/task-branch", repo.local);
		expect(await isPreservedOutsideBranch(repo.local, "dev3/task-branch")).toBe(true);
	});

	it("an unknown branch name proves nothing: not preserved", async () => {
		// A detached HEAD leaves nothing to exclude, so HEAD's own branch would
		// answer for it.
		expect(await isPreservedOutsideBranch(repo.local, "")).toBe(false);
	});

	it("a failing git proves nothing: not preserved", async () => {
		const notARepo = mkdtempSync(join(tmpdir(), "dev3-not-a-repo-"));
		expect(await isPreservedOutsideBranch(notARepo, "dev3/task-branch")).toBe(false);
		cleanup({ dir: notARepo, local: notARepo });
	});
});
