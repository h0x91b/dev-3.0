import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import {
	removeWorktree,
	createWorktree,
	_resetFetchState,
	getDefaultBranch,
	isGitRepo,
	applySparseCheckout,
} from "../git";
import { createTestRepo, cleanup, makeTaskCommits, g, type TestRepo } from "./git-test-helpers";

// ─── Shared factories ────────────────────────────────────────────────────────

function makeProject(path: string, defaultBaseBranch = "main"): Project {
	return {
		id: "proj-1",
		name: "Test",
		path,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch,
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

// ─── removeWorktree ──────────────────────────────────────────────────────────

describe("removeWorktree", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("does nothing when worktreePath is null", async () => {
		const project = makeProject(repo.local);
		const task = makeTask({ worktreePath: null });
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

		expect(existsSync(wtPath)).toBe(false);
		const branches = g("git branch", repo.local);
		expect(branches).not.toContain("dev3/task-aaaaaaaa");
	});

	it("removes worktree and deletes RENAMED branch correctly", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);
		g("git branch -m dev3/task-aaaaaaaa dev3/fix-critical-bug", wtPath);

		const project = makeProject(repo.local);
		const task = makeTask({
			worktreePath: wtPath,
			branchName: "dev3/task-aaaaaaaa",
		});

		await removeWorktree(project, task);

		expect(existsSync(wtPath)).toBe(false);
		const branches = g("git branch", repo.local);
		expect(branches).not.toContain("dev3/fix-critical-bug");
		expect(branches).not.toContain("dev3/task-aaaaaaaa");
	});

	it("removes worktree and deletes branch renamed to conventional prefix (feat/, fix/, etc.)", async () => {
		const wtPath = join(repo.dir, "worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		// Agent renames to conventional prefix — no longer starts with dev3/
		g("git branch -m dev3/task-aaaaaaaa feat/fix-login", wtPath);

		const project = makeProject(repo.local);
		const task = makeTask({
			worktreePath: wtPath,
			branchName: "dev3/task-aaaaaaaa", // original name stored at worktree creation
		});

		await removeWorktree(project, task);

		expect(existsSync(wtPath)).toBe(false);
		// The conventionally-prefixed branch should be deleted (dev3 created it)
		const branches = g("git branch", repo.local);
		expect(branches).not.toContain("feat/fix-login");
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

		expect(existsSync(wtPath)).toBe(false);
		const branches = g("git branch", repo.local);
		expect(branches).toContain("feature/login");
	});

	it("deletes variant branch (feature/login-v1) on removal", async () => {
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
		expect(branches).not.toContain("feature/login-v1");
		expect(branches).toContain("feature/login");
	});
});

// ─── createWorktree ──────────────────────────────────────────────────────────

describe("createWorktree", () => {
	let repo: TestRepo;

	beforeEach(() => {
		_resetFetchState();
		repo = createTestRepo();
	});

	afterEach(() => cleanup(repo));

	it("creates worktree from existing branch that is not checked out", async () => {
		g("git checkout -b feature/available", repo.local);
		makeTaskCommits(repo.local);
		g("git checkout main", repo.local);

		const project = makeProject(repo.local);
		const task = makeTask();

		const result = await createWorktree(project, task, "feature/available");

		expect(existsSync(result.worktreePath)).toBe(true);
		expect(result.branchName).toBe("feature/available");

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
	});

	it("falls back to task branch when existing branch is already checked out", async () => {
		const project = makeProject(repo.local);
		const task = makeTask();

		const result = await createWorktree(project, task, "main");

		expect(existsSync(result.worktreePath)).toBe(true);
		expect(result.branchName).toBe("dev3/task-aaaaaaaa");

		const mainContent = readFileSync(join(repo.local, "app.ts"), "utf-8");
		const wtContent = readFileSync(join(result.worktreePath, "app.ts"), "utf-8");
		expect(wtContent).toBe(mainContent);

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
		g("git branch -D dev3/task-aaaaaaaa", repo.local);
	});

	it("falls back to task branch when existing branch is checked out in another worktree", async () => {
		g("git checkout -b feature/busy", repo.local);
		makeTaskCommits(repo.local);
		g("git checkout main", repo.local);
		const otherWt = join(repo.dir, "other-wt");
		g(`git worktree add "${otherWt}" feature/busy`, repo.local);

		const project = makeProject(repo.local);
		const task = makeTask();

		const result = await createWorktree(project, task, "feature/busy");

		expect(existsSync(result.worktreePath)).toBe(true);
		expect(result.branchName).toBe("dev3/task-aaaaaaaa");

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
		g(`git worktree remove --force "${otherWt}"`, repo.local);
		g("git branch -D dev3/task-aaaaaaaa", repo.local);
	});

	it("sets up remote tracking when fallback branch has a remote counterpart", async () => {
		g("git checkout -b feature/tracked", repo.local);
		makeTaskCommits(repo.local);
		g("git push origin feature/tracked", repo.local);
		g("git checkout main", repo.local);
		const otherWt = join(repo.dir, "other-wt-tracked");
		g(`git worktree add "${otherWt}" feature/tracked`, repo.local);

		const project = makeProject(repo.local);
		const task = makeTask();

		const result = await createWorktree(project, task, "feature/tracked");

		expect(result.branchName).toBe("dev3/task-aaaaaaaa");
		const upstream = g(`git -C "${result.worktreePath}" rev-parse --abbrev-ref --symbolic-full-name @{u}`, repo.local);
		expect(upstream.trim()).toBe("origin/feature/tracked");

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
		g(`git worktree remove --force "${otherWt}"`, repo.local);
		g("git branch -D dev3/task-aaaaaaaa", repo.local);
	});

	it("does not set remote tracking when fallback branch has no remote counterpart", async () => {
		g("git checkout -b feature/local-only", repo.local);
		makeTaskCommits(repo.local);
		g("git checkout main", repo.local);
		const otherWt = join(repo.dir, "other-wt-local");
		g(`git worktree add "${otherWt}" feature/local-only`, repo.local);

		const project = makeProject(repo.local);
		const task = makeTask();

		const result = await createWorktree(project, task, "feature/local-only");

		expect(result.branchName).toBe("dev3/task-aaaaaaaa");
		const upstreamResult = g(`git -C "${result.worktreePath}" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>&1 || true`, repo.local);
		expect(upstreamResult).not.toContain("origin/feature/local-only");

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
		g(`git worktree remove --force "${otherWt}"`, repo.local);
		g("git branch -D dev3/task-aaaaaaaa", repo.local);
	});

	it("creates worktree from remote branch", async () => {
		g("git checkout -b feature/remote-only", repo.local);
		makeTaskCommits(repo.local);
		g("git push origin feature/remote-only", repo.local);
		g("git checkout main", repo.local);
		g("git branch -D feature/remote-only", repo.local);

		const project = makeProject(repo.local);
		const task = makeTask();

		const result = await createWorktree(project, task, "origin/feature/remote-only");

		expect(existsSync(result.worktreePath)).toBe(true);
		expect(result.branchName).toBe("feature/remote-only");

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
	});

	it("creates default task branch when no existing branch specified", async () => {
		const project = makeProject(repo.local);
		const task = makeTask();

		const result = await createWorktree(project, task);

		expect(existsSync(result.worktreePath)).toBe(true);
		expect(result.branchName).toBe("dev3/task-aaaaaaaa");

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
		g("git branch -D dev3/task-aaaaaaaa", repo.local);
	});

	it("creates worktree from latest origin/main even when local main is stale", async () => {
		const project = makeProject(repo.local);

		const otherClone = join(repo.dir, "other");
		g(`git clone "${join(repo.dir, "origin.git")}" "${otherClone}"`, repo.dir);
		g("git config user.email test@test.com", otherClone);
		g("git config user.name Test", otherClone);
		g("git checkout main", otherClone);
		writeFileSync(join(otherClone, "new-file.ts"), "export const x = 42;\n");
		g("git add new-file.ts", otherClone);
		g('git commit -m "new commit on main"', otherClone);
		g("git push origin main", otherClone);

		const localMainHas = g("git log --oneline main", repo.local);
		expect(localMainHas).not.toContain("new commit on main");

		const task = makeTask({ id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" });
		const result = await createWorktree(project, task);

		expect(existsSync(result.worktreePath)).toBe(true);
		expect(existsSync(join(result.worktreePath, "new-file.ts"))).toBe(true);

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
		g("git branch -D dev3/task-bbbbbbbb", repo.local);
		rmSync(otherClone, { recursive: true, force: true });
	});

	it("falls back to local baseBranch when fetch fails (no remote)", async () => {
		g("git remote remove origin", repo.local);

		const project = makeProject(repo.local);
		const task = makeTask({ id: "cccccccc-dddd-eeee-ffff-111111111111" });

		const result = await createWorktree(project, task);

		expect(existsSync(result.worktreePath)).toBe(true);
		expect(result.branchName).toBe("dev3/task-cccccccc");

		const mainContent = readFileSync(join(repo.local, "app.ts"), "utf-8");
		const wtContent = readFileSync(join(result.worktreePath, "app.ts"), "utf-8");
		expect(wtContent).toBe(mainContent);

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
		g("git branch -D dev3/task-cccccccc", repo.local);
	});

	it("falls back to local baseBranch when origin/<baseBranch> does not exist", async () => {
		g("git checkout -b develop", repo.local);
		writeFileSync(join(repo.local, "dev-file.ts"), "export const dev = true;\n");
		g("git add dev-file.ts", repo.local);
		g('git commit -m "develop commit"', repo.local);
		g("git checkout main", repo.local);

		const project = makeProject(repo.local);
		const task = makeTask({
			id: "dddddddd-eeee-ffff-1111-222222222222",
			baseBranch: "develop",
		});

		const result = await createWorktree(project, task);

		expect(existsSync(result.worktreePath)).toBe(true);
		expect(result.branchName).toBe("dev3/task-dddddddd");
		expect(existsSync(join(result.worktreePath, "dev-file.ts"))).toBe(true);

		g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
		g("git branch -D dev3/task-dddddddd", repo.local);
	});
});

// ─── createWorktree edge cases (no remote, wrong baseBranch) ────────────────

interface LocalOnlyRepo {
	dir: string;
	local: string;
}

function createLocalOnlyRepo(branchName = "main"): LocalOnlyRepo {
	const dir = mkdtempSync(join(tmpdir(), "dev3-local-only-"));
	const local = join(dir, "repo");
	g(`git init "${local}"`, dir);
	g("git config user.email test@test.com", local);
	g("git config user.name Test", local);
	writeFileSync(join(local, "file.txt"), "hello\n");
	g("git add file.txt", local);
	g('git commit -m "initial"', local);
	if (branchName !== "master") {
		g(`git branch -M ${branchName}`, local);
	}
	return { dir, local };
}

function createEmptyRepo(): LocalOnlyRepo {
	const dir = mkdtempSync(join(tmpdir(), "dev3-empty-"));
	const local = join(dir, "repo");
	g(`git init "${local}"`, dir);
	g("git config user.email test@test.com", local);
	g("git config user.name Test", local);
	return { dir, local };
}

function cleanupLocal(r: LocalOnlyRepo): void {
	rmSync(r.dir, { recursive: true, force: true });
}

describe("createWorktree edge cases", () => {
	beforeEach(() => {
		_resetFetchState();
	});

	it("succeeds with local-only repo (no remote) when base branch exists", async () => {
		const r = createLocalOnlyRepo("main");
		try {
			const project = makeProject(r.local);
			const task = makeTask({ id: "eeeeeeee-ffff-0000-1111-222222222222" });

			const result = await createWorktree(project, task);
			expect(existsSync(result.worktreePath)).toBe(true);
			expect(result.branchName).toBe("dev3/task-eeeeeeee");

			g(`git worktree remove --force "${result.worktreePath}"`, r.local);
			g("git branch -D dev3/task-eeeeeeee", r.local);
		} finally {
			cleanupLocal(r);
		}
	});

	it("succeeds with local-only repo when branch is master", async () => {
		const r = createLocalOnlyRepo();
		g("git branch -M master", r.local);
		try {
			const project = makeProject(r.local, "master");
			const task = makeTask({ id: "ffffffff-0000-1111-2222-333333333333", baseBranch: "master" });

			const result = await createWorktree(project, task);
			expect(existsSync(result.worktreePath)).toBe(true);
			expect(result.branchName).toBe("dev3/task-ffffffff");

			g(`git worktree remove --force "${result.worktreePath}"`, r.local);
			g("git branch -D dev3/task-ffffffff", r.local);
		} finally {
			cleanupLocal(r);
		}
	});

	it("throws descriptive error when base branch does not exist (the #213 bug)", async () => {
		const r = createLocalOnlyRepo("develop");
		try {
			const project = makeProject(r.local, "master");
			const task = makeTask({
				id: "11111111-2222-3333-4444-555555555555",
				baseBranch: "master",
			});

			await expect(createWorktree(project, task)).rejects.toThrow(
				'Branch "master" does not exist',
			);
		} finally {
			cleanupLocal(r);
		}
	});

	it("throws descriptive error when base branch is 'main' but repo uses 'master' without remote", async () => {
		const r = createLocalOnlyRepo();
		g("git branch -M master", r.local);
		try {
			const project = makeProject(r.local, "main");
			const task = makeTask({
				id: "22222222-3333-4444-5555-666666666666",
				baseBranch: "main",
			});

			await expect(createWorktree(project, task)).rejects.toThrow(
				'Branch "main" does not exist',
			);
		} finally {
			cleanupLocal(r);
		}
	});

	it("throws when repo has no commits at all", async () => {
		const r = createEmptyRepo();
		try {
			const project = makeProject(r.local);
			const task = makeTask({
				id: "33333333-4444-5555-6666-777777777777",
			});

			await expect(createWorktree(project, task)).rejects.toThrow(
				'Branch "main" does not exist',
			);
		} finally {
			cleanupLocal(r);
		}
	});
});

// ─── isGitRepo ──────────────────────────────────────────────────────────────

describe("isGitRepo", () => {
	it("returns true for a valid git repository", async () => {
		const r = createLocalOnlyRepo();
		try {
			expect(await isGitRepo(r.local)).toBe(true);
		} finally {
			cleanupLocal(r);
		}
	});

	it("returns false for a non-git directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-not-git-"));
		try {
			expect(await isGitRepo(dir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─── getDefaultBranch ───────────────────────────────────────────────────────

describe("getDefaultBranch", () => {
	it("detects 'main' from origin/HEAD in a cloned repo", async () => {
		const repo = createTestRepo();
		try {
			const branch = await getDefaultBranch(repo.local);
			expect(branch).toBe("main");
		} finally {
			cleanup(repo);
		}
	});

	it("detects 'master' from origin remote branches", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-master-origin-"));
		const origin = join(dir, "origin.git");
		const local = join(dir, "local");
		g(`git init --bare "${origin}"`, dir);
		g(`git clone "${origin}" "${local}"`, dir);
		g("git config user.email test@test.com", local);
		g("git config user.name Test", local);
		writeFileSync(join(local, "file.txt"), "test");
		g("git add file.txt", local);
		g('git commit -m "initial"', local);
		g("git branch -M master", local);
		g("git push -u origin master", local);
		g("git remote set-head origin -d", local);

		try {
			const branch = await getDefaultBranch(local);
			expect(branch).toBe("master");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to local 'main' when no remote exists", async () => {
		const r = createLocalOnlyRepo("main");
		try {
			const branch = await getDefaultBranch(r.local);
			expect(branch).toBe("main");
		} finally {
			cleanupLocal(r);
		}
	});

	it("falls back to local 'master' when no remote exists and branch is master", async () => {
		const r = createLocalOnlyRepo();
		g("git branch -M master", r.local);
		try {
			const branch = await getDefaultBranch(r.local);
			expect(branch).toBe("master");
		} finally {
			cleanupLocal(r);
		}
	});

	it("falls back to first local branch when neither main nor master exists", async () => {
		const r = createLocalOnlyRepo();
		g("git branch -M develop", r.local);
		try {
			const branch = await getDefaultBranch(r.local);
			expect(branch).toBe("develop");
		} finally {
			cleanupLocal(r);
		}
	});

	it("throws when repo has no commits (no branches at all)", async () => {
		const r = createEmptyRepo();
		try {
			await expect(getDefaultBranch(r.local)).rejects.toThrow(
				"No branches found in repository",
			);
		} finally {
			cleanupLocal(r);
		}
	});
});

// ─── applySparseCheckout ─────────────────────────────────────────────────────

describe("applySparseCheckout", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("applies sparse checkout with specified paths", async () => {
		const wtPath = join(repo.dir, "wt-sparse");
		g(`git worktree add -b dev3/sparse-test "${wtPath}" main`, repo.local);

		await applySparseCheckout(wtPath, ["src", "docs"]);

		// Verify sparse-checkout config exists and contains the paths
		const sparseList = g("git sparse-checkout list", wtPath);
		expect(sparseList).toContain("src");
		expect(sparseList).toContain("docs");

		// Clean up worktree
		g(`git worktree remove --force "${wtPath}"`, repo.local);
	});

	it("throws on init failure for invalid path", async () => {
		await expect(
			applySparseCheckout("/nonexistent/path", ["src"]),
		).rejects.toThrow("Failed to init sparse checkout");
	});
});
