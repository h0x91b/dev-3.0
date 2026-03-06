import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Project, Task } from "../../shared/types";

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

// Mock gh CLI response. Tests set this to control what `gh pr list` returns.
let ghPrListResponse: string = "[]";

// Replace Bun.spawn with a real Node.js child_process implementation so
// git.ts functions run actual git commands in integration tests.
// Intercepts `gh` calls and returns mock responses.
vi.mock("../spawn", async () => {
	const { spawn: cpSpawn } = await import("child_process");

	const toWebStream = (readable: NodeJS.ReadableStream) =>
		new ReadableStream({
			start(controller) {
				readable.on("data", (chunk: Buffer) =>
					controller.enqueue(new Uint8Array(chunk)),
				);
				readable.on("end", () => controller.close());
				readable.on("error", (err: Error) => controller.error(err));
			},
		});

	/** Create a fake process that immediately resolves with given stdout/exit code */
	function fakeProc(stdout: string, exitCode: number) {
		const encoder = new TextEncoder();
		return {
			exited: Promise.resolve(exitCode),
			stdout: new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode(stdout));
					controller.close();
				},
			}),
			stderr: new ReadableStream({ start(c) { c.close(); } }),
		};
	}

	return {
		spawn: (cmd: string[], opts?: Record<string, unknown>) => {
			// Intercept gh CLI calls
			if (cmd[0] === "gh") {
				return fakeProc(ghPrListResponse, 0);
			}

			const child = cpSpawn(cmd[0], cmd.slice(1), {
				cwd: opts?.cwd as string | undefined,
				env: (opts?.env as NodeJS.ProcessEnv | undefined) ?? process.env,
				stdio: ["pipe", "pipe", "pipe"],
			});

			if (opts?.stdin instanceof Blob) {
				(opts.stdin as Blob).arrayBuffer().then((buf) => {
					child.stdin!.write(Buffer.from(buf));
					child.stdin!.end();
				});
			} else {
				child.stdin?.end();
			}

			return {
				exited: new Promise<number>((resolve) =>
					child.on("close", (code: number | null) => resolve(code ?? 1)),
				),
				stdout: toWebStream(child.stdout!),
				stderr: toWebStream(child.stderr!),
			};
		},
	};
});

import {
	isContentMergedInto,
	getCurrentBranch,
	getUnpushedCount,
	getBranchStatus,
	canRebaseCleanly,
	removeWorktree,
	getUncommittedChanges,
	listBranches,
} from "../git";

// ─── Helpers ────────────────────────────────────────────────────────────────

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@test.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@test.com",
};

function g(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, env: GIT_ENV, stdio: "pipe", encoding: "utf-8" });
}

interface TestRepo {
	dir: string;
	local: string; // working clone (task branch checked out here)
}

function createTestRepo(): TestRepo {
	const dir = mkdtempSync(join(tmpdir(), "dev3-git-test-"));
	const origin = join(dir, "origin.git");
	const local = join(dir, "local");

	g(`git init --bare "${origin}"`, dir);
	g(`git clone "${origin}" "${local}"`, dir);
	g("git config user.email test@test.com", local);
	g("git config user.name Test", local);

	// Initial commit with a file that later tests will also modify (to simulate
	// context drift from other PRs touching the same file after the task merge).
	writeFileSync(join(local, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
	g("git add app.ts", local);
	g('git commit -m "initial"', local);
	g("git branch -M main", local); // ensure branch is named 'main' regardless of git default
	g("git push -u origin main", local);

	return { dir, local };
}

function cleanup({ dir }: TestRepo): void {
	rmSync(dir, { recursive: true, force: true });
}

/** Create two commits on the current branch that add/modify feature.ts */
function makeTaskCommits(local: string): void {
	writeFileSync(
		join(local, "feature.ts"),
		"export const add = (a: number, b: number) => a + b;\n",
	);
	g("git add feature.ts", local);
	g('git commit -m "feat: add function"', local);

	writeFileSync(
		join(local, "feature.ts"),
		"export const add = (a: number, b: number) => a + b;\n" +
			"export const sub = (a: number, b: number) => a - b;\n",
	);
	g("git add feature.ts", local);
	g('git commit -m "feat: add sub function"', local);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("isContentMergedInto", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
		ghPrListResponse = "[]"; // default: no merged PRs
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

		// Squash merge the task
		g("git checkout main", repo.local);
		g("git merge --squash task-branch", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);

		// Simulate other PRs landing on main that touch the same file —
		// this is what caused the false positive before the patch-id fix.
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

		// Rebase onto main using a temp branch so task-branch keeps its original SHAs,
		// simulating GitHub's "rebase and merge" which creates new SHAs on main but
		// leaves the original task branch untouched.
		g("git checkout -b temp-rebase task-branch", repo.local);
		g("git rebase main", repo.local);
		g("git checkout main", repo.local);
		g("git merge --ff-only temp-rebase", repo.local);
		g("git push origin main", repo.local);
		g("git branch -D temp-rebase", repo.local);

		// task-branch still has original commits (original SHAs, not the rebased ones)
		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after rebase merge even when main diverges further with commits to the same files", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		// Rebase merge (GitHub "rebase and merge")
		g("git checkout -b temp-rebase task-branch", repo.local);
		g("git rebase main", repo.local);
		g("git checkout main", repo.local);
		g("git merge --ff-only temp-rebase", repo.local);
		g("git branch -D temp-rebase", repo.local);

		// Simulate another PR landing on main that touches the same file
		writeFileSync(
			join(repo.local, "feature.ts"),
			"export const add = (a: number, b: number) => a + b;\n" +
				"export const sub = (a: number, b: number) => a - b;\n" +
				"export const mul = (a: number, b: number) => a * b;\n",
		);
		g("git add feature.ts", repo.local);
		g('git commit -m "feat: add mul (unrelated PR)"', repo.local);
		g("git push origin main", repo.local);

		// task-branch still has original commits
		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after squash merge when main had overlapping commits BEFORE the squash (the real-world bug)", async () => {
		// The task branch modifies app.ts line
		g("git checkout -b task-branch", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'task';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "task: change a"', repo.local);
		makeTaskCommits(repo.local); // adds feature.ts
		g("git push -u origin task-branch", repo.local);

		// Another PR on main modifies the SAME line of app.ts (different value).
		// This creates the scenario where the merge-base has "const a = 1;",
		// main has "const a = 'other';", and task has "const a = 'task';".
		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'other';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "other PR: also change a"', repo.local);

		// Squash merge — will conflict on app.ts. Resolve by taking task's value.
		try { g("git merge --squash task-branch", repo.local); } catch { /* conflict expected */ }
		writeFileSync(join(repo.local, "app.ts"), "const a = 'task';\nconst b = 2;\nconst c = 3;\n");
		g("git add .", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);
		g("git push origin main", repo.local);

		// Back on task branch — patch-id detection fails because:
		// - Task combined diff: -"const a = 1;" +"const a = 'task';"  (base=merge-base)
		// - Squash commit diff: -"const a = 'other';" +"const a = 'task';" (base=squash parent)
		// Different `-` lines → different patch-ids
		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns true after squash merge when main diverged BOTH before AND after the squash on the same files", async () => {
		// Task modifies app.ts (conflicting with main) and creates feature.ts
		g("git checkout -b task-branch", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'task';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "task: change a"', repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		// Another PR on main modifies app.ts BEFORE the squash
		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 'other';\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "other PR: also change a"', repo.local);

		// Squash merge (resolve conflict)
		try { g("git merge --squash task-branch", repo.local); } catch { /* conflict */ }
		writeFileSync(join(repo.local, "app.ts"), "const a = 'task';\nconst b = 2;\nconst c = 3;\n");
		g("git add .", repo.local);
		g('git commit -m "squash: task (#1)"', repo.local);

		// ANOTHER PR on main AFTER the squash also touches feature.ts
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

		// merge-tree fails (conflict on feature.ts add/add + app.ts overlap)
		// patch-id fails (different `-` lines due to pre-squash divergence on app.ts)
		// gh PR check confirms the branch was merged
		ghPrListResponse = JSON.stringify([{ number: 42 }]);
		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns false when only some task commits are present in main (partial merge)", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin task-branch", repo.local);

		// Cherry-pick only the first commit to main, leaving the second unmerged
		const firstSha = g("git log --format=%H", repo.local).trim().split("\n")[1]; // parent = first commit
		g("git checkout main", repo.local);
		g(`git cherry-pick ${firstSha}`, repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await isContentMergedInto(repo.local, "origin/main");
		expect(result).toBe(false);
	});
});

// ─── getCurrentBranch ────────────────────────────────────────────────────────

describe("getCurrentBranch", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("returns current branch name on main", async () => {
		const result = await getCurrentBranch(repo.local);
		expect(result).toBe("main");
	});

	it("returns new name after git branch -m", async () => {
		g("git checkout -b dev3/task-aaaaaaaa", repo.local);
		makeTaskCommits(repo.local);

		g("git branch -m dev3/task-aaaaaaaa dev3/fix-login-bug", repo.local);

		const result = await getCurrentBranch(repo.local);
		expect(result).toBe("dev3/fix-login-bug");
	});

	it("returns new name after git checkout -b (new branch from existing)", async () => {
		g("git checkout -b dev3/task-aaaaaaaa", repo.local);
		makeTaskCommits(repo.local);

		// Simulate agent creating a new branch from current position
		g("git checkout -b dev3/better-name", repo.local);

		const result = await getCurrentBranch(repo.local);
		expect(result).toBe("dev3/better-name");
	});

	it("returns null on detached HEAD", async () => {
		const sha = g("git rev-parse HEAD", repo.local).trim();
		g(`git checkout ${sha}`, repo.local);

		const result = await getCurrentBranch(repo.local);
		expect(result).toBeNull();
	});
});

// ─── getUnpushedCount ────────────────────────────────────────────────────────

describe("getUnpushedCount", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("returns -1 when branch was never pushed", async () => {
		g("git checkout -b dev3/task-branch", repo.local);
		makeTaskCommits(repo.local);

		const result = await getUnpushedCount(repo.local, "dev3/task-branch");
		expect(result).toBe(-1);
	});

	it("returns 0 when all commits are pushed", async () => {
		g("git checkout -b dev3/task-branch", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin dev3/task-branch", repo.local);

		const result = await getUnpushedCount(repo.local, "dev3/task-branch");
		expect(result).toBe(0);
	});

	it("returns N for N unpushed commits", async () => {
		g("git checkout -b dev3/task-branch", repo.local);
		makeTaskCommits(repo.local); // 2 commits
		g("git push -u origin dev3/task-branch", repo.local);

		// Add one more commit after push
		writeFileSync(join(repo.local, "extra.ts"), "export const x = 1;\n");
		g("git add extra.ts", repo.local);
		g('git commit -m "feat: extra"', repo.local);

		const result = await getUnpushedCount(repo.local, "dev3/task-branch");
		expect(result).toBe(1);
	});

	it("returns 0 for empty branch name", async () => {
		const result = await getUnpushedCount(repo.local, "");
		expect(result).toBe(0);
	});

	it("works correctly with live branch name after rename", async () => {
		g("git checkout -b dev3/task-aaaaaaaa", repo.local);
		makeTaskCommits(repo.local);
		g("git push -u origin dev3/task-aaaaaaaa", repo.local);

		// Rename the branch
		g("git branch -m dev3/task-aaaaaaaa dev3/fix-login", repo.local);

		// Push under new name
		g("git push -u origin dev3/fix-login", repo.local);

		// Add an unpushed commit
		writeFileSync(join(repo.local, "extra.ts"), "export const x = 1;\n");
		g("git add extra.ts", repo.local);
		g('git commit -m "feat: extra"', repo.local);

		// Using LIVE name should work correctly
		const liveBranch = await getCurrentBranch(repo.local);
		expect(liveBranch).toBe("dev3/fix-login");

		const result = await getUnpushedCount(repo.local, liveBranch!);
		expect(result).toBe(1);

		// Using OLD stored name still returns correct count
		// (because origin/dev3/task-aaaaaaaa still exists from old push)
		const resultOld = await getUnpushedCount(repo.local, "dev3/task-aaaaaaaa");
		expect(resultOld).toBe(1);
	});

	it("returns -1 for renamed branch that was never pushed under new name", async () => {
		g("git checkout -b dev3/task-aaaaaaaa", repo.local);
		makeTaskCommits(repo.local);
		// Do NOT push before rename

		g("git branch -m dev3/task-aaaaaaaa dev3/fix-login", repo.local);

		// Using live name — never pushed
		const result = await getUnpushedCount(repo.local, "dev3/fix-login");
		expect(result).toBe(-1);
	});
});

// ─── getBranchStatus ─────────────────────────────────────────────────────────

describe("getBranchStatus", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("returns ahead count for new commits", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		const result = await getBranchStatus(repo.local, "origin/main");
		expect(result.ahead).toBe(2);
		expect(result.behind).toBe(0);
	});

	it("returns behind count when base has new commits", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		// Add a commit to main and push
		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "other.ts"), "const z = 1;\n");
		g("git add other.ts", repo.local);
		g('git commit -m "main: new feature"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);

		const result = await getBranchStatus(repo.local, "origin/main");
		expect(result.ahead).toBe(2);
		expect(result.behind).toBe(1);
	});

	it("returns zero for fresh branch with no changes", async () => {
		g("git checkout -b task-branch", repo.local);

		const result = await getBranchStatus(repo.local, "origin/main");
		expect(result.ahead).toBe(0);
		expect(result.behind).toBe(0);
	});
});

// ─── canRebaseCleanly ────────────────────────────────────────────────────────

describe("canRebaseCleanly", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("returns true when rebase would succeed without conflicts", async () => {
		g("git checkout -b task-branch", repo.local);
		makeTaskCommits(repo.local);

		// Add a non-conflicting commit to main
		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "other.ts"), "const z = 1;\n");
		g("git add other.ts", repo.local);
		g('git commit -m "main: other file"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);
		g("git fetch origin", repo.local);

		const result = await canRebaseCleanly(repo.local, "origin/main");
		expect(result).toBe(true);
	});

	it("returns false when rebase would have conflicts", async () => {
		g("git checkout -b task-branch", repo.local);
		// Modify app.ts on task branch
		writeFileSync(join(repo.local, "app.ts"), "const a = 999;\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "task: change a"', repo.local);

		// Create conflicting change on main
		g("git checkout main", repo.local);
		writeFileSync(join(repo.local, "app.ts"), "const a = 777;\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "main: also change a"', repo.local);
		g("git push origin main", repo.local);

		g("git checkout task-branch", repo.local);
		g("git fetch origin", repo.local);

		const result = await canRebaseCleanly(repo.local, "origin/main");
		expect(result).toBe(false);
	});
});

// ─── getUncommittedChanges ───────────────────────────────────────────────────

describe("getUncommittedChanges", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("returns zero for clean working tree", async () => {
		const result = await getUncommittedChanges(repo.local);
		expect(result.insertions).toBe(0);
		expect(result.deletions).toBe(0);
	});

	it("counts insertions and deletions in tracked files", async () => {
		// Modify existing file: change 1 line (1 insert + 1 delete)
		writeFileSync(join(repo.local, "app.ts"), "const a = 999;\nconst b = 2;\nconst c = 3;\n");

		const result = await getUncommittedChanges(repo.local);
		expect(result.insertions).toBe(1);
		expect(result.deletions).toBe(1);
	});

	// Untracked file counting relies on Bun.file() which is not available in vitest (Node).
	// Skipping this test — untracked counting is exercised in e2e tests.
	it.skip("counts untracked file lines as insertions (requires Bun runtime)", async () => {
		writeFileSync(join(repo.local, "new-file.ts"), "line1\nline2\nline3\n");

		const result = await getUncommittedChanges(repo.local);
		expect(result.insertions).toBe(3);
		expect(result.deletions).toBe(0);
	});
});

// ─── removeWorktree ──────────────────────────────────────────────────────────

describe("removeWorktree", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	function makeProject(path: string): Project {
		return {
			id: "proj-1",
			name: "Test",
			path,
			setupScript: "",
			devScript: "",
			cleanupScript: "",
			defaultBaseBranch: "main",
			createdAt: new Date().toISOString(),
		};
	}

	function makeTask(overrides: Partial<Task> = {}): Task {
		return {
			id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			seq: 1,
			projectId: "proj-1",
			title: "Test task",
			description: "",
			status: "in-progress",
			baseBranch: "main",
			worktreePath: null,
			branchName: null,
			groupId: null,
			variantIndex: null,
			agentId: null,
			configId: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			...overrides,
		};
	}

	it("does nothing when worktreePath is null", async () => {
		const project = makeProject(repo.local);
		const task = makeTask({ worktreePath: null });

		// Should not throw
		await removeWorktree(project, task);
	});

	it("removes worktree and deletes branch with original name", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		const project = makeProject(repo.local);
		const task = makeTask({
			worktreePath: wtPath,
			branchName: "dev3/task-aaaaaaaa",
		});

		await removeWorktree(project, task);

		// Worktree should be gone
		expect(existsSync(wtPath)).toBe(false);
		// Branch should be gone
		const branches = g("git branch", repo.local);
		expect(branches).not.toContain("dev3/task-aaaaaaaa");
	});

	it("removes worktree and deletes RENAMED branch correctly", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		// Rename the branch inside the worktree
		g("git branch -m dev3/task-aaaaaaaa dev3/fix-critical-bug", wtPath);

		const project = makeProject(repo.local);
		const task = makeTask({
			worktreePath: wtPath,
			branchName: "dev3/task-aaaaaaaa", // stored name is STALE
		});

		await removeWorktree(project, task);

		// Worktree should be gone
		expect(existsSync(wtPath)).toBe(false);
		// The RENAMED branch should be deleted
		const branches = g("git branch", repo.local);
		expect(branches).not.toContain("dev3/fix-critical-bug");
		expect(branches).not.toContain("dev3/task-aaaaaaaa");
	});
	it("preserves user-owned branch (non-dev3) on removal", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b feature/login "${wtPath}" main`, repo.local);

		const project = makeProject(repo.local);
		const task = makeTask({
			worktreePath: wtPath,
			branchName: "feature/login",
			existingBranch: "feature/login",
		});

		await removeWorktree(project, task);

		// Worktree should be gone
		expect(existsSync(wtPath)).toBe(false);
		// Branch should be PRESERVED
		const branches = g("git branch", repo.local);
		expect(branches).toContain("feature/login");
	});

	it("deletes variant branch (feature/login-v1) on removal", async () => {
		// Create the base branch first
		g("git branch feature/login", repo.local);

		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b feature/login-v1 "${wtPath}" feature/login`, repo.local);

		const project = makeProject(repo.local);
		const task = makeTask({
			worktreePath: wtPath,
			branchName: "feature/login-v1",
			existingBranch: "feature/login",
		});

		await removeWorktree(project, task);

		expect(existsSync(wtPath)).toBe(false);
		const branches = g("git branch", repo.local);
		// Variant branch should be deleted
		expect(branches).not.toContain("feature/login-v1");
		// Original branch should be preserved
		expect(branches).toContain("feature/login");
	});
});

// ─── Branch rename integration scenarios ─────────────────────────────────────

describe("branch rename integration", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("getCurrentBranch returns new name in a worktree after rename", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		// Verify initial name
		const before = await getCurrentBranch(wtPath);
		expect(before).toBe("dev3/task-aaaaaaaa");

		// Rename via git branch -m (common agent pattern)
		g("git branch -m dev3/task-aaaaaaaa dev3/fix-auth-flow", wtPath);

		const after = await getCurrentBranch(wtPath);
		expect(after).toBe("dev3/fix-auth-flow");

		// Cleanup
		g(`git worktree remove --force "${wtPath}"`, repo.local);
		g("git branch -D dev3/fix-auth-flow", repo.local);
	});

	it("getUnpushedCount works with live branch name after rename and push", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		// Make commits in worktree
		writeFileSync(join(wtPath, "feature.ts"), "export const x = 1;\n");
		g("git add feature.ts", wtPath);
		g('git commit -m "feat: x"', wtPath);

		// Rename the branch
		g("git branch -m dev3/task-aaaaaaaa dev3/fix-login", wtPath);

		// Push under new name
		g("git push -u origin dev3/fix-login", wtPath);

		// Add unpushed commit
		writeFileSync(join(wtPath, "feature.ts"), "export const x = 2;\n");
		g("git add feature.ts", wtPath);
		g('git commit -m "feat: update x"', wtPath);

		// Live name should give correct count
		const liveBranch = await getCurrentBranch(wtPath);
		expect(liveBranch).toBe("dev3/fix-login");

		const count = await getUnpushedCount(wtPath, liveBranch!);
		expect(count).toBe(1);

		// Cleanup
		g(`git worktree remove --force "${wtPath}"`, repo.local);
		g("git branch -D dev3/fix-login", repo.local);
	});

	it("getBranchStatus works correctly in a worktree after rename", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		// Make commits
		writeFileSync(join(wtPath, "feature.ts"), "export const x = 1;\n");
		g("git add feature.ts", wtPath);
		g('git commit -m "feat: x"', wtPath);

		// Rename
		g("git branch -m dev3/task-aaaaaaaa dev3/fix-ui", wtPath);

		// getBranchStatus still works (it uses HEAD, not branchName)
		const status = await getBranchStatus(wtPath, "origin/main");
		expect(status.ahead).toBe(1);
		expect(status.behind).toBe(0);

		// Cleanup
		g(`git worktree remove --force "${wtPath}"`, repo.local);
		g("git branch -D dev3/fix-ui", repo.local);
	});

	it("canRebaseCleanly works in worktree after rename", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		// Make a non-conflicting commit in worktree
		writeFileSync(join(wtPath, "feature.ts"), "export const x = 1;\n");
		g("git add feature.ts", wtPath);
		g('git commit -m "feat: x"', wtPath);

		// Add commit to main
		writeFileSync(join(repo.local, "other.ts"), "export const z = 1;\n");
		g("git add other.ts", repo.local);
		g('git commit -m "main: other"', repo.local);
		g("git push origin main", repo.local);

		// Rename worktree branch
		g("git branch -m dev3/task-aaaaaaaa dev3/fix-stuff", wtPath);

		g("git fetch origin", wtPath);
		const result = await canRebaseCleanly(wtPath, "origin/main");
		expect(result).toBe(true);

		// Cleanup
		g(`git worktree remove --force "${wtPath}"`, repo.local);
		g("git branch -D dev3/fix-stuff", repo.local);
	});
});

// ─── listBranches ────────────────────────────────────────────────────────────

describe("listBranches", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => cleanup(repo));

	it("returns local and remote branches", async () => {
		g("git checkout -b feature/login", repo.local);
		g("git checkout main", repo.local);

		const branches = await listBranches(repo.local);
		const localNames = branches.filter((b) => !b.isRemote).map((b) => b.name);
		const remoteNames = branches.filter((b) => b.isRemote).map((b) => b.name);

		expect(localNames).toContain("main");
		expect(localNames).toContain("feature/login");
		expect(remoteNames).toContain("origin/main");
	});

	it("filters out origin/HEAD from remote branches", async () => {
		const branches = await listBranches(repo.local);
		const remoteNames = branches.filter((b) => b.isRemote).map((b) => b.name);
		expect(remoteNames.some((n) => n.endsWith("/HEAD"))).toBe(false);
	});

	it("includes remote-only branches not checked out locally", async () => {
		// Create a branch, push it, then delete the local copy
		g("git checkout -b temp-branch", repo.local);
		writeFileSync(join(repo.local, "temp.ts"), "export const t = 1;\n");
		g("git add temp.ts", repo.local);
		g('git commit -m "temp"', repo.local);
		g("git push origin temp-branch", repo.local);
		g("git checkout main", repo.local);
		g("git branch -D temp-branch", repo.local);

		const branches = await listBranches(repo.local);
		const localNames = branches.filter((b) => !b.isRemote).map((b) => b.name);
		const remoteNames = branches.filter((b) => b.isRemote).map((b) => b.name);

		expect(localNames).not.toContain("temp-branch");
		expect(remoteNames).toContain("origin/temp-branch");
	});
});
