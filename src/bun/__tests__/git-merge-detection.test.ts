import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";

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

let ghPrListResponse: string = "[]";

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock(() => ghPrListResponse);
});

import { isContentMergedInto } from "../git";
import { createTestRepo, cleanup, makeTaskCommits, g, type TestRepo } from "./git-test-helpers";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("isContentMergedInto", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		ghPrListResponse = "[]";
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("returns false when task branch has not been merged", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(false);
	});

	it("returns true after squash merge", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout main", repo.local);
		g("git merge --squash task-branch", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after squash merge even when main diverges further with commits to the same files (the actual bug scenario)", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout main", repo.local);
		g("git merge --squash task-branch", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);

		writeFileSync(
			join(repo.local, "feature.ts"),
			"export const add = (a: number, b: number) => a + b;\n" +
				"export const sub = (a: number, b: number) => a - b;\n" +
				"export const mul = (a: number, b: number) => a * b;\n",
		);
		g("git add feature.ts", repo.local);
		g('git commit -m "feat: add mul (unrelated PR)"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after rebase merge", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout -b temp-rebase task-branch", repo.local);
		g("git rebase main", repo.local);
		g("git checkout main", repo.local);
		g("git merge --ff-only temp-rebase", repo.local);
		g("git push origin main", repo.local);
		g("git branch -D temp-rebase", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after rebase merge even when main diverges further with commits to the same files", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout -b temp-rebase task-branch", repo.local);
		g("git rebase main", repo.local);
		g("git checkout main", repo.local);
		g("git merge --ff-only temp-rebase", repo.local);
		g("git branch -D temp-rebase", repo.local);

		writeFileSync(
			join(repo.local, "feature.ts"),
			"export const add = (a: number, b: number) => a + b;\n" +
				"export const sub = (a: number, b: number) => a - b;\n" +
				"export const mul = (a: number, b: number) => a * b;\n",
		);
		g("git add feature.ts", repo.local);
		g('git commit -m "feat: add mul (unrelated PR)"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after squash merge when main had overlapping commits BEFORE the squash (the real-world bug)", async () => {
		g("git checkout -b task-branch", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'task';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "task: change a"', repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'other';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "other PR: also change a"', repo.local);

		try { g("git merge --squash task-branch", repo.local); } catch { /* conflict expected */ }
		writeFileSync(join(repo.local, "app.ts"), "const a = 'task';\nconst b = 2;\nconst c = 3;\n");
		g("git add .", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after squash merge when main diverged BOTH before AND after the squash on the same files", async () => {
		g("git checkout -b task-branch", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'task';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "task: change a"', repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'other';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "other PR: also change a"', repo.local);

		try { g("git merge --squash task-branch", repo.local); } catch { /* conflict */ }
		writeFileSync(join(repo.local, "app.ts"), "const a = 'task';\nconst b = 2;\nconst c = 3;\n");
		g("git add .", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);

		writeFileSync(
			join(repo.local, "feature.ts"),
			"export const add = (a: number, b: number) => a + b;\n" +
				"export const sub = (a: number, b: number) => a - b;\n" +
				"export const mul = (a: number, b: number) => a * b;\n",
		);
		g("git add feature.ts", repo.local);
		g('git commit -m "unrelated PR: add mul to feature.ts"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		// A genuine merge leaves the head ref tip untouched, so the merged PR's
		// headRefOid equals the current local HEAD.
		const headSha = g("git rev-parse HEAD", repo.local).trim();
		ghPrListResponse = JSON.stringify([{ number: 42, headRefOid: headSha }]);
		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns false when gh reports a merged PR for the head branch name but its head commit does not match current HEAD (reused branch name / stale PR — the PR-review false positive)", async () => {
		// Genuinely unmerged work: the branch's changes are NOT in main.
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		// main diverges with an unrelated commit so the local patch-id strategy
		// reaches the gh fallback (Strategy 3) instead of bailing out early.
		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "unrelated.ts"), "export const x = 1;\n");
		g("git add unrelated.ts", repo.local);
		g('git commit -m "unrelated PR"', repo.local);
		g("git push origin main", repo.local);
		g("git checkout task-branch", repo.local);

		// A previously-merged PR exists for the SAME branch name, but it merged a
		// different (older) head commit — not the current HEAD. This must NOT be
		// treated as merged.
		ghPrListResponse = JSON.stringify([
			{ number: 7, headRefOid: "0000000000000000000000000000000000000000" },
		]);
		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(false);
	});

	it("returns false when gh reports a merged PR with no headRefOid", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "unrelated.ts"), "export const x = 1;\n");
		g("git add unrelated.ts", repo.local);
		g('git commit -m "unrelated PR"', repo.local);
		g("git push origin main", repo.local);
		g("git checkout task-branch", repo.local);

		ghPrListResponse = JSON.stringify([{ number: 9 }]);
		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(false);
	});

	it("returns false when only some task commits are present in main (partial merge)", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		const firstSha = g("git log --format=%H", repo.local).trim().split("\n")[1];
		g("git checkout main", repo.local);
		g(`git cherry-pick ${firstSha}`, repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(false);
	});
});
