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

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import {
	getCurrentBranch,
	getUnpushedCount,
	getBranchStatus,
	canRebaseCleanly,
	getUncommittedChanges,
	listBranches,
} from "../git";
import { createTestRepo, cleanup, makeTaskCommits, g, type TestRepo } from "./git-test-helpers";

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
		makeTaskCommits(repo.local);
		g("git push -u origin dev3/task-branch", repo.local);

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

		g("git branch -m dev3/task-aaaaaaaa dev3/fix-login", repo.local);
		g("git push -u origin dev3/fix-login", repo.local);

		writeFileSync(join(repo.local, "extra.ts"), "export const x = 1;\n");
		g("git add extra.ts", repo.local);
		g('git commit -m "feat: extra"', repo.local);

		const liveBranch = await getCurrentBranch(repo.local);
		expect(liveBranch).toBe("dev3/fix-login");

		const result = await getUnpushedCount(repo.local, liveBranch!);
		expect(result).toBe(1);

		const resultOld = await getUnpushedCount(repo.local, "dev3/task-aaaaaaaa");
		expect(resultOld).toBe(1);
	});

	it("returns -1 for renamed branch that was never pushed under new name", async () => {
		g("git checkout -b dev3/task-aaaaaaaa", repo.local);
		makeTaskCommits(repo.local);

		g("git branch -m dev3/task-aaaaaaaa dev3/fix-login", repo.local);

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
		writeFileSync(join(repo.local, "app.ts"), "const a = 999;\nconst b = 2;\nconst c = 3;\n");
		g("git add app.ts", repo.local);
		g('git commit -m "task: change a"', repo.local);

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
		writeFileSync(join(repo.local, "app.ts"), "const a = 999;\nconst b = 2;\nconst c = 3;\n");

		const result = await getUncommittedChanges(repo.local);
		expect(result.insertions).toBe(1);
		expect(result.deletions).toBe(1);
	});

	it.skip("counts untracked file lines as insertions (requires Bun runtime)", async () => {
		writeFileSync(join(repo.local, "new-file.ts"), "line1\nline2\nline3\n");

		const result = await getUncommittedChanges(repo.local);
		expect(result.insertions).toBe(3);
		expect(result.deletions).toBe(0);
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

		const before = await getCurrentBranch(wtPath);
		expect(before).toBe("dev3/task-aaaaaaaa");

		g("git branch -m dev3/task-aaaaaaaa dev3/fix-auth-flow", wtPath);

		const after = await getCurrentBranch(wtPath);
		expect(after).toBe("dev3/fix-auth-flow");

		g(`git worktree remove --force "${wtPath}"`, repo.local);
		g("git branch -D dev3/fix-auth-flow", repo.local);
	});

	it("getUnpushedCount works with live branch name after rename and push", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		writeFileSync(join(wtPath, "feature.ts"), "export const x = 1;\n");
		g("git add feature.ts", wtPath);
		g('git commit -m "feat: x"', wtPath);

		g("git branch -m dev3/task-aaaaaaaa dev3/fix-login", wtPath);
		g("git push -u origin dev3/fix-login", wtPath);

		writeFileSync(join(wtPath, "feature.ts"), "export const x = 2;\n");
		g("git add feature.ts", wtPath);
		g('git commit -m "feat: update x"', wtPath);

		const liveBranch = await getCurrentBranch(wtPath);
		expect(liveBranch).toBe("dev3/fix-login");

		const count = await getUnpushedCount(wtPath, liveBranch!);
		expect(count).toBe(1);

		g(`git worktree remove --force "${wtPath}"`, repo.local);
		g("git branch -D dev3/fix-login", repo.local);
	});

	it("getBranchStatus works correctly in a worktree after rename", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		writeFileSync(join(wtPath, "feature.ts"), "export const x = 1;\n");
		g("git add feature.ts", wtPath);
		g('git commit -m "feat: x"', wtPath);

		g("git branch -m dev3/task-aaaaaaaa dev3/fix-ui", wtPath);

		const status = await getBranchStatus(wtPath, "origin/main");
		expect(status.ahead).toBe(1);
		expect(status.behind).toBe(0);

		g(`git worktree remove --force "${wtPath}"`, repo.local);
		g("git branch -D dev3/fix-ui", repo.local);
	});

	it("canRebaseCleanly works in worktree after rename", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		writeFileSync(join(wtPath, "feature.ts"), "export const x = 1;\n");
		g("git add feature.ts", wtPath);
		g('git commit -m "feat: x"', wtPath);

		writeFileSync(join(repo.local, "other.ts"), "export const z = 1;\n");
		g("git add other.ts", repo.local);
		g('git commit -m "main: other"', repo.local);
		g("git push origin main", repo.local);

		g("git branch -m dev3/task-aaaaaaaa dev3/fix-stuff", wtPath);

		g("git fetch origin", wtPath);
		const result = await canRebaseCleanly(wtPath, "origin/main");
		expect(result).toBe(true);

		g(`git worktree remove --force "${wtPath}"`, repo.local);
		g("git branch -D dev3/fix-stuff", repo.local);
	});
});
