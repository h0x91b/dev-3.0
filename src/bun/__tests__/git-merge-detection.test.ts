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

import { isBranchMergedViaGitHubPR, isContentMergedInto, runGitPipe } from "../git";
import { createTestRepo, cleanup, makeTaskCommits, g, spawnedCommands, type TestRepo } from "./git-test-helpers";

// Anything that would put a shell (or WSL) between us and git.
const SHELLS = /^(bash|sh|zsh|dash|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|wsl|wsl\.exe)$/i;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("isContentMergedInto", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		ghPrListResponse = "[]";
		spawnedCommands.length = 0;
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

	// ── Shell-free streaming pipeline (Windows regression) ───────────────────
	//
	// A `bash -c "git … | git patch-id"` pipeline exits 128 on Windows because
	// PATH resolves bash to WSL bash, which cannot see the native worktree cwd.

	it("detects a squash merge without spawning any shell", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout main", repo.local);
		g("git merge --squash task-branch", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);
		// Diverge on the same file afterwards so merge-tree conflicts and the
		// patch-id pipeline is what actually answers.
		writeFileSync(
			join(repo.local, "feature.ts"),
			"export const add = (a: number, b: number) => a + b;\n" +
				"export const sub = (a: number, b: number) => a - b;\n" +
				"export const mul = (a: number, b: number) => a * b;\n",
		);
		g("git add feature.ts", repo.local);
		g('git commit -m "unrelated PR"', repo.local);
		g("git push origin main", repo.local);
		g("git checkout task-branch", repo.local);

		expect(await isContentMergedInto(repo.local, "origin/main")).toBe(true);

		expect(spawnedCommands.filter((cmd) => SHELLS.test(cmd[0]))).toEqual([]);
		// No rendered pipeline string smuggled into argv either.
		expect(spawnedCommands.filter((cmd) => cmd.some((arg) => arg.includes("|")))).toEqual([]);
		expect(spawnedCommands.some((cmd) => cmd.includes("patch-id"))).toBe(true);
	});

	it("detects a squash merge from a linked worktree (separate gitdir pointer)", async () => {
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
		g('git commit -m "unrelated PR"', repo.local);
		g("git push origin main", repo.local);

		const linked = join(repo.dir, "linked-worktree");
		g(`git worktree add "${linked}" task-branch`, repo.local);

		expect(await isContentMergedInto(linked, "origin/main")).toBe(true);
		expect(spawnedCommands.filter((cmd) => SHELLS.test(cmd[0]))).toEqual([]);
	});

	it("detects a squash merge whose patch contains binary, renamed and deleted files", async () => {
		g("git checkout -b task-branch", repo.local);
		writeFileSync(join(repo.local, "logo.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 7]));
		g("git mv app.ts renamed.ts", repo.local);
		g("git add logo.bin", repo.local);
		g('git commit -m "task: binary + rename"', repo.local);
		writeFileSync(join(repo.local, "doomed.ts"), "export const gone = true;\n");
		g("git add doomed.ts", repo.local);
		g('git commit -m "task: add doomed"', repo.local);
		g("git rm doomed.ts", repo.local);
		g('git commit -m "task: delete doomed"', repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout main", repo.local);
		g("git merge --squash task-branch", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);
		writeFileSync(join(repo.local, "renamed.ts"), "const a = 1;\nconst b = 2;\nconst c = 4;\n");
		g("git add renamed.ts", repo.local);
		g('git commit -m "unrelated PR"', repo.local);
		g("git push origin main", repo.local);
		g("git checkout task-branch", repo.local);

		expect(await isContentMergedInto(repo.local, "origin/main")).toBe(true);
	});

	it("returns true when the branch carries no changes at all (empty diff)", async () => {
		g("git checkout -b task-branch", repo.local);
		g("git push -u origin task-branch", repo.local);

		expect(await isContentMergedInto(repo.local, "origin/main")).toBe(true);
	});

	it("returns true after cherry-picking every task commit onto main", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);
		const shas = g("git log --format=%H main..task-branch", repo.local).trim().split("\n").reverse();

		g("git checkout main", repo.local);
		for (const sha of shas) g(`git cherry-pick ${sha}`, repo.local);
		writeFileSync(join(repo.local, "unrelated.ts"), "export const x = 1;\n");
		g("git add unrelated.ts", repo.local);
		g('git commit -m "unrelated PR"', repo.local);
		g("git push origin main", repo.local);
		g("git checkout task-branch", repo.local);

		expect(await isContentMergedInto(repo.local, "origin/main")).toBe(true);
	});

	it("returns false when main changed the same file differently", async () => {
		g("git checkout -b task-branch", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'task';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "task: change a"', repo.local);
		g("git push -u origin task-branch", repo.local);

		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'other';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "other PR"', repo.local);
		g("git push origin main", repo.local);
		g("git checkout task-branch", repo.local);

		expect(await isContentMergedInto(repo.local, "origin/main")).toBe(false);
	});
});

describe("runGitPipe", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		spawnedCommands.length = 0;
	});

	afterEach(() => {
		cleanup(repo);
	});

	const PATCH_ID = ["git", "patch-id", "--stable"];

	it("streams a prefix followed by the producer's bytes into the consumer", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		const prefix = new TextEncoder().encode(`commit ${"0".repeat(40)}\n\n`);
		const piped = await runGitPipe(["git", "diff", "main", "HEAD"], PATCH_ID, repo.local, { prefix });

		expect(piped.ok).toBe(true);
		// patch-id echoes the commit id it was given after the patch id.
		expect(piped.stdout).toMatch(/^[0-9a-f]{40} 0{40}$/);
		expect(spawnedCommands.filter((cmd) => SHELLS.test(cmd[0]))).toEqual([]);
	});

	it("produces identical patch-ids for identical patches across invocations", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		const cmd = ["git", "log", "-p", "--no-merges", "main..HEAD"];
		const first = await runGitPipe(cmd, PATCH_ID, repo.local);
		const second = await runGitPipe(cmd, PATCH_ID, repo.local);

		expect(first.ok).toBe(true);
		expect(first.stdout.split("\n")).toHaveLength(2);
		expect(second.stdout).toBe(first.stdout);
	});

	it("streams patches larger than the OS pipe buffer without deadlocking", async () => {
		g("git checkout -b task-branch", repo.local);
		writeFileSync(join(repo.local, "big.txt"), "x".repeat(64) + "\n".repeat(1) + Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join("\n"));
		g("git add big.txt", repo.local);
		g('git commit -m "task: big file"', repo.local);

		const piped = await runGitPipe(["git", "log", "-p", "main..HEAD"], PATCH_ID, repo.local);
		expect(piped.ok).toBe(true);
		expect(piped.stdout).toMatch(/^[0-9a-f]{40} /);
	});

	it("fails when the producer fails", async () => {
		const piped = await runGitPipe(["git", "log", "-p", "no-such-ref-xyz"], PATCH_ID, repo.local);
		expect(piped.ok).toBe(false);
		expect(piped.stderr).not.toBe("");
	});

	it("fails when the consumer fails", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		const piped = await runGitPipe(
			["git", "log", "-p", "main..HEAD"],
			["git", "patch-id", "--definitely-not-a-flag"],
			repo.local,
		);
		expect(piped.ok).toBe(false);
	});

	it("fails when a side cannot be spawned at all", async () => {
		const piped = await runGitPipe(["dev3-no-such-binary"], PATCH_ID, repo.local);
		expect(piped.ok).toBe(false);
	});
});

describe("isBranchMergedViaGitHubPR", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		ghPrListResponse = "[]";
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("returns true when a merged PR's head commit matches the current local HEAD", async () => {
		// Simulates delete_branch_on_merge: the PR merged and origin/<branch>
		// was pruned, so content strategies are unavailable — gh is the source
		// of truth.
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		const headSha = g("git rev-parse HEAD", repo.local).trim();
		ghPrListResponse = JSON.stringify([{ number: 42, headRefOid: headSha }]);

		const result = await isBranchMergedViaGitHubPR(repo.local);
		expect(result).toBe(true);
	});

	it("returns false when no merged PR exists for the branch", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		const result = await isBranchMergedViaGitHubPR(repo.local);
		expect(result).toBe(false);
	});

	it("returns false when the merged PR's head commit does not match current HEAD (reused branch name)", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		ghPrListResponse = JSON.stringify([
			{ number: 7, headRefOid: "0000000000000000000000000000000000000000" },
		]);

		const result = await isBranchMergedViaGitHubPR(repo.local);
		expect(result).toBe(false);
	});

	it("returns false on detached HEAD", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		const headSha = g("git rev-parse HEAD", repo.local).trim();
		g(`git checkout --detach ${headSha}`, repo.local);

		ghPrListResponse = JSON.stringify([{ number: 42, headRefOid: headSha }]);

		const result = await isBranchMergedViaGitHubPR(repo.local);
		expect(result).toBe(false);
	});

	it("returns false when gh output is not valid JSON", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		ghPrListResponse = "gh: command failed";

		const result = await isBranchMergedViaGitHubPR(repo.local);
		expect(result).toBe(false);
	});
});
