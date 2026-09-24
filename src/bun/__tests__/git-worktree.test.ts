import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Project, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/git-worktree`);

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
}));

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import {
	removeWorktree,
	createWorktree,
	_resetFetchState,
	_setWorktreeAddRetryPolicy,
	gitLockRetryDelayMs,
	isTransientWorktreeAddFailure,
	getDefaultBranch,
	isGitRepo,
	applySparseCheckout,
	recoverStaleInitializingWorktrees,
	taskDir,
} from "../git";
import { createTestRepo, cleanup, makeTaskCommits, g, spawnedCommands, type TestRepo } from "./git-test-helpers";

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

	it("rejects when Git cannot remove a present worktree", async () => {
		const wtPath = join(repo.dir, "locked-worktree");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);
		g(`git worktree lock "${wtPath}"`, repo.local);

		const project = makeProject(repo.local);
		const task = makeTask({
			worktreePath: wtPath,
			branchName: "dev3/task-aaaaaaaa",
		});

		await expect(removeWorktree(project, task)).rejects.toThrow("Failed to remove worktree");
		expect(existsSync(wtPath)).toBe(true);
	});

	it("swallows the failure when git no longer knows the path is a worktree", async () => {
		// Real user report: `.git/worktrees/<name>` metadata vanished, so every
		// completion attempt died on "is not a working tree" and the task could
		// never leave review. Teardown must succeed and reclaim the orphan dir.
		const project = makeProject(repo.local);
		const task = makeTask({
			id: "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
			branchName: "dev3/task-77777777",
		});
		const wtPath = join(taskDir(project, task), "worktree");
		mkdirSync(taskDir(project, task), { recursive: true });
		g(`git worktree add -b dev3/task-77777777 "${wtPath}" main`, repo.local);
		rmSync(join(repo.local, ".git", "worktrees"), { recursive: true, force: true });

		await removeWorktree(project, { ...task, worktreePath: wtPath });

		expect(existsSync(wtPath)).toBe(false);
		expect(g("git branch", repo.local)).not.toContain("dev3/task-77777777");
	});

	it("swallows the failure when the checkout lost its .git link", async () => {
		// Real user report: the registration survived while `<worktree>/.git` did
		// not, so `git worktree remove --force` answered "validation failed ... does
		// not exist" on every app start. Teardown aborted, the task stayed in
		// `tearing-down`, and the same error came back at the next boot forever.
		const project = makeProject(repo.local);
		const task = makeTask({
			id: "55555555-6666-7777-8888-999999999999",
			branchName: "dev3/task-55555555",
		});
		const wtPath = join(taskDir(project, task), "worktree");
		mkdirSync(taskDir(project, task), { recursive: true });
		g(`git worktree add -b dev3/task-55555555 "${wtPath}" main`, repo.local);
		rmSync(join(wtPath, ".git"), { recursive: true, force: true });
		mkdirSync(join(wtPath, ".claude"), { recursive: true });
		writeFileSync(join(wtPath, ".claude", "settings.local.json"), "{}");
		expect(g(`git worktree list`, repo.local)).toContain("prunable");

		await removeWorktree(project, { ...task, worktreePath: wtPath });

		expect(existsSync(wtPath)).toBe(false);
		expect(g("git worktree list", repo.local)).not.toContain(wtPath);
		expect(g("git branch", repo.local)).not.toContain("dev3/task-55555555");
	});

	it("is idempotent across repeated teardown attempts on a lost checkout", async () => {
		// The boot path re-dispatches teardown for a task still parked in
		// `tearing-down`. A second pass must stay silent, not resurrect the error.
		const project = makeProject(repo.local);
		const task = makeTask({
			id: "44444444-3333-2222-1111-000000000000",
			branchName: "dev3/task-44444444",
		});
		const wtPath = join(taskDir(project, task), "worktree");
		mkdirSync(taskDir(project, task), { recursive: true });
		g(`git worktree add -b dev3/task-44444444 "${wtPath}" main`, repo.local);
		rmSync(join(wtPath, ".git"), { recursive: true, force: true });

		const withPath = { ...task, worktreePath: wtPath };
		await removeWorktree(project, withPath);
		await expect(removeWorktree(project, withPath)).resolves.toBeUndefined();
		expect(existsSync(wtPath)).toBe(false);
	});

	it("still rejects a locked worktree whose checkout is intact", async () => {
		// The `.git`-missing classification must not widen into "every validation
		// failure is a successful teardown".
		const wtPath = join(repo.dir, "locked-intact");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);
		g(`git worktree lock "${wtPath}"`, repo.local);

		const project = makeProject(repo.local);
		const task = makeTask({ worktreePath: wtPath, branchName: "dev3/task-aaaaaaaa" });

		await expect(removeWorktree(project, task)).rejects.toThrow("Failed to remove worktree");
		expect(existsSync(wtPath)).toBe(true);
		expect(g("git branch", repo.local)).toContain("dev3/task-aaaaaaaa");
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

	it("still deletes the branch when worktree directory was already removed externally", async () => {
		// Regression: `git rev-parse --abbrev-ref HEAD` was being spawned with
		// cwd=task.worktreePath. When the directory was gone, Bun.spawn threw
		// ENOENT and the function aborted before deleting the branch. Result:
		// stale branch on disk, and the next attempt to revive the task from
		// completed/cancelled failed with "branch already exists".
		const wtPath = join(repo.dir, "worktree-removed-externally");
		g(`git worktree add -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);

		// Simulate the directory being deleted out from under git (e.g. cleanup
		// script `rm -rf`, manual cleanup, or filesystem inconsistency).
		rmSync(wtPath, { recursive: true, force: true });
		expect(existsSync(wtPath)).toBe(false);

		const project = makeProject(repo.local);
		const task = makeTask({
			worktreePath: wtPath,
			branchName: "dev3/task-aaaaaaaa",
		});

		await removeWorktree(project, task);

		const branches = g("git branch", repo.local);
		expect(branches).not.toContain("dev3/task-aaaaaaaa");
	});

	it("removes an interrupted worktree still locked as initializing", async () => {
		const wtPath = join(repo.dir, "initializing-worktree");
		g(`git worktree add --lock --reason initializing -b dev3/task-aaaaaaaa "${wtPath}" main`, repo.local);
		rmSync(wtPath, { recursive: true, force: true });

		const project = makeProject(repo.local);
		const task = makeTask({
			worktreePath: wtPath,
			branchName: "dev3/task-aaaaaaaa",
		});

		await removeWorktree(project, task);

		expect(existsSync(wtPath)).toBe(false);
		expect(g("git worktree list --porcelain", repo.local)).not.toContain(`worktree ${wtPath}`);
		expect(g("git branch", repo.local)).not.toContain("dev3/task-aaaaaaaa");
	});
});

// ─── startup recovery ──────────────────────────────────────────────────────

describe("recoverStaleInitializingWorktrees", () => {
	let repo: TestRepo;

	beforeEach(() => {
		repo = createTestRepo();
	});

	afterEach(() => {
		cleanup(repo);
	});

	it("removes stale initializing entries without touching active managed worktrees", async () => {
		const project = makeProject(repo.local);
		const staleTask = makeTask({ id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" });
		const activeTask = makeTask({ id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee" });
		const stalePath = join(taskDir(project, staleTask), "worktree");
		const activePath = join(taskDir(project, activeTask), "worktree");
		mkdirSync(join(stalePath, ".."), { recursive: true });
		mkdirSync(join(activePath, ".."), { recursive: true });
		g(`git worktree add --lock --reason initializing -b dev3/task-bbbbbbbb "${stalePath}" main`, repo.local);
		g(`git worktree add --lock --reason initializing -b dev3/task-cccccccc "${activePath}" main`, repo.local);
		const registeredStalePath = realpathSync(stalePath);
		const registeredActivePath = realpathSync(activePath);
		rmSync(stalePath, { recursive: true, force: true });

		const recovered = await recoverStaleInitializingWorktrees(project, new Set([activePath]));

		expect(recovered).toEqual([registeredStalePath]);
		expect(existsSync(stalePath)).toBe(false);
		expect(existsSync(activePath)).toBe(true);
		const registrations = g("git worktree list --porcelain", repo.local);
		expect(registrations).not.toContain(`worktree ${registeredStalePath}`);
		expect(registrations).toContain(`worktree ${registeredActivePath}`);
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

	it("re-runs a task on a remote branch whose worktree and local branch survived", async () => {
		// Regression: a task launched on origin/<branch> that is moved back to To Do
		// keeps its worktree and local branch. Re-running it hit "'<path>' already
		// exists", retried with `--track -b`, and died on "a branch named X already
		// exists" — the task could never be launched again.
		g("git checkout -b verif/evidence", repo.local);
		makeTaskCommits(repo.local);
		g("git push origin verif/evidence", repo.local);
		g("git checkout main", repo.local);

		const project = makeProject(repo.local);
		const task = makeTask();

		const first = await createWorktree(project, task, "origin/verif/evidence");
		expect(first.branchName).toBe("verif/evidence");

		// Move back to To Do leaves the worktree and the branch behind, so the
		// second launch starts from exactly that state.
		const second = await createWorktree(project, task, "origin/verif/evidence");

		expect(existsSync(second.worktreePath)).toBe(true);
		expect(second.branchName).toBe("verif/evidence");
		expect(second.worktreePath).toBe(first.worktreePath);

		g(`git worktree remove --force "${second.worktreePath}"`, repo.local);
	});

	it("re-runs a variant task whose worktree and variant branch survived", async () => {
		g("git checkout -b feature/base", repo.local);
		makeTaskCommits(repo.local);
		g("git checkout main", repo.local);

		const project = makeProject(repo.local);
		const task = makeTask();

		const first = await createWorktree(project, task, "feature/base", "feature/base-v1");
		expect(first.branchName).toBe("feature/base-v1");

		const second = await createWorktree(project, task, "feature/base", "feature/base-v1");

		expect(existsSync(second.worktreePath)).toBe(true);
		expect(second.branchName).toBe("feature/base-v1");

		g(`git worktree remove --force "${second.worktreePath}"`, repo.local);
		g("git branch -D feature/base-v1", repo.local);
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

	// Launches starting together race for .git/config.lock while writing the new
	// branch's upstream config; the loser exits after the branch already exists.
	describe("transient git contention", () => {
		const addsSince = (before: number) => spawnedCommands
			.slice(before)
			.filter((cmd) => cmd.join(" ").includes("worktree add"));
		const branchDeletesSince = (before: number, branch: string) => spawnedCommands
			.slice(before)
			.filter((cmd) => cmd.join(" ").includes(`branch -D ${branch}`));

		beforeEach(() => _setWorktreeAddRetryPolicy({ baseDelayMs: 40, maxDelayMs: 80 }));
		afterEach(() => _setWorktreeAddRetryPolicy());

		it("retries through .git/config lock contention held by another git process", async () => {
			const project = makeProject(repo.local);
			const task = makeTask({ id: "abababab-cdcd-efef-0101-232323232323" });
			const lockPath = join(repo.local, ".git", "config.lock");
			writeFileSync(lockPath, "");
			const before = spawnedCommands.length;
			// Released only once the first attempt has provably failed — the retry's
			// `branch -D` of the leftover branch is what proves it. A timer here would
			// let the lock expire before git ever reached the config write.
			// Once only: a second rmSync would delete git's own config.lock mid-write.
			const release = setInterval(() => {
				if (branchDeletesSince(before, "dev3/task-abababab").length > 0) {
					clearInterval(release);
					rmSync(lockPath, { force: true });
				}
			}, 5);

			try {
				const result = await createWorktree(project, task);
				expect(existsSync(result.worktreePath)).toBe(true);
				expect(result.branchName).toBe("dev3/task-abababab");
				expect(addsSince(before).length).toBeGreaterThanOrEqual(2);
				expect(g("git config branch.dev3/task-abababab.merge", repo.local).trim()).toBe("refs/heads/main");
				g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
				g("git branch -D dev3/task-abababab", repo.local);
			} finally {
				clearInterval(release);
				rmSync(lockPath, { force: true });
			}
		});

		it("gives up after the attempt cap when the config lock is never released", async () => {
			const project = makeProject(repo.local);
			const task = makeTask({ id: "bcbcbcbc-cdcd-efef-0101-232323232323" });
			const lockPath = join(repo.local, ".git", "config.lock");
			writeFileSync(lockPath, "");
			const before = spawnedCommands.length;

			try {
				const error = await createWorktree(project, task).then(() => null, (err: Error) => err);
				expect(error?.message).toMatch(/could not lock config file/);
				expect(error?.message).toMatch(/gave up after 8 attempts over \d+\.\ds/);
				expect(addsSince(before)).toHaveLength(8);
				// dev3 waits for somebody else's lock; it never removes it.
				expect(existsSync(lockPath)).toBe(true);
			} finally {
				rmSync(lockPath, { force: true });
				g("git branch -D dev3/task-bcbcbcbc", repo.local);
			}
		});

		it("stops at the time budget before the attempt cap", async () => {
			_setWorktreeAddRetryPolicy({ baseDelayMs: 200, maxDelayMs: 200, budgetMs: 350 });
			const project = makeProject(repo.local);
			const task = makeTask({ id: "cdcdcdcd-cdcd-efef-0101-232323232323" });
			const lockPath = join(repo.local, ".git", "config.lock");
			writeFileSync(lockPath, "");
			const before = spawnedCommands.length;

			try {
				await expect(createWorktree(project, task)).rejects.toThrow(/could not lock config file/);
				const adds = addsSince(before).length;
				expect(adds).toBeGreaterThanOrEqual(2);
				expect(adds).toBeLessThan(8);
			} finally {
				rmSync(lockPath, { force: true });
				g("git branch -D dev3/task-cdcdcdcd", repo.local);
			}
		});

		// A failed attempt leaves its branch behind. If deleting it loses the race
		// too, `add -b` would hit a permanent "already exists" — so the round waits.
		it("waits instead of re-adding when the leftover branch cannot be reclaimed yet", async () => {
			const project = makeProject(repo.local);
			const task = makeTask({ id: "acacacac-cdcd-efef-0101-232323232323" });
			const configLock = join(repo.local, ".git", "config.lock");
			const refLock = join(repo.local, ".git", "refs", "heads", "dev3", "task-acacacac.lock");
			writeFileSync(configLock, "");
			const before = spawnedCommands.length;
			let refLocked = false;
			const choreograph = setInterval(() => {
				const deletes = branchDeletesSince(before, "dev3/task-acacacac").length;
				if (!refLocked && deletes === 0 && addsSince(before).length === 1
					&& existsSync(join(repo.local, ".git", "refs", "heads", "dev3", "task-acacacac"))) {
					refLocked = true;
					writeFileSync(refLock, "");
				}
				if (deletes >= 2) {
					clearInterval(choreograph);
					rmSync(refLock, { force: true });
					rmSync(configLock, { force: true });
				}
			}, 2);

			try {
				const result = await createWorktree(project, task);
				expect(existsSync(result.worktreePath)).toBe(true);
				expect(branchDeletesSince(before, "dev3/task-acacacac").length).toBeGreaterThanOrEqual(2);
				g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
				g("git branch -D dev3/task-acacacac", repo.local);
			} finally {
				clearInterval(choreograph);
				rmSync(refLock, { force: true });
				rmSync(configLock, { force: true });
			}
		});

		// Every worktree-listing git command dies on a sibling whose metadata dir
		// exists but whose commondir is still empty — a sibling `worktree add` mid-way.
		it("retries past a sibling worktree that is still initializing, without touching it", async () => {
			const project = makeProject(repo.local);
			const task = makeTask({ id: "dededede-cdcd-efef-0101-232323232323" });
			const sibling = join(repo.local, ".git", "worktrees", "sibling-in-flight");
			mkdirSync(sibling, { recursive: true });
			writeFileSync(join(sibling, "locked"), "initializing");
			writeFileSync(join(sibling, "gitdir"), `${join(repo.dir, "sibling-in-flight")}/.git\n`);
			writeFileSync(join(sibling, "commondir"), "");
			const before = spawnedCommands.length;
			const finishSibling = setInterval(() => {
				if (addsSince(before).length > 0 && branchDeletesSince(before, "dev3/task-dededede").length > 0) {
					clearInterval(finishSibling);
					writeFileSync(join(sibling, "commondir"), "../..\n");
				}
			}, 5);

			try {
				const result = await createWorktree(project, task);
				expect(existsSync(result.worktreePath)).toBe(true);
				expect(addsSince(before).length).toBeGreaterThanOrEqual(2);
				expect(readFileSync(join(sibling, "locked"), "utf-8")).toBe("initializing");
				g(`git worktree remove --force "${result.worktreePath}"`, repo.local);
				g("git branch -D dev3/task-dededede", repo.local);
			} finally {
				clearInterval(finishSibling);
				rmSync(sibling, { recursive: true, force: true });
			}
		});

		it("does not retry a failure that is not contention", async () => {
			const project = makeProject(repo.local);
			const task = makeTask({ id: "efefefef-cdcd-efef-0101-232323232323" });
			const before = spawnedCommands.length;

			await expect(createWorktree(project, task, "no-such-branch")).rejects.toThrow(/invalid reference|not a valid/);
			expect(addsSince(before)).toHaveLength(1);
		});

		it("lands every launch of a concurrent batch while another process keeps writing config", async () => {
			const project = makeProject(repo.local);
			const tasks = Array.from({ length: 8 }, (_, i) => makeTask({ id: `f${i}f${i}f${i}f${i}-cdcd-efef-0101-232323232323` }));
			let stop = false;
			const noise = (async () => {
				for (let i = 0; !stop; i++) {
					await new Promise((resolve) => setTimeout(resolve, 1));
					try { g(`git config dev3test.noise ${i}`, repo.local); } catch { /* lost the lock to a launch */ }
				}
			})();

			try {
				const results = await Promise.all(tasks.map((task) => createWorktree(project, task)));
				expect(new Set(results.map((r) => r.branchName)).size).toBe(8);
				const branches = g('git branch --format="%(refname:short)"', repo.local).split("\n");
				expect(branches.filter((b) => b.startsWith("dev3/task-f")).sort())
					.toEqual(results.map((r) => r.branchName).sort());
				for (const r of results) {
					expect(existsSync(r.worktreePath)).toBe(true);
					expect(g(`git config branch.${r.branchName}.merge`, repo.local).trim()).toBe("refs/heads/main");
				}
			} finally {
				stop = true;
				await noise;
			}
		});
	});
});

describe("git contention classification", () => {
	it("treats config, ref and sibling-initializing failures as transient", () => {
		expect(isTransientWorktreeAddFailure("error: could not lock config file .git/config: File exists")).toBe(true);
		expect(isTransientWorktreeAddFailure(
			"fatal: cannot lock ref 'refs/heads/x': Unable to create '/r/.git/refs/heads/x.lock': File exists.",
		)).toBe(true);
		expect(isTransientWorktreeAddFailure(
			"fatal: failed to read .git/worktrees/worktree5/commondir: Undefined error: 0",
		)).toBe(true);
		expect(isTransientWorktreeAddFailure(
			"fatal: failed to read C:\\r\\.git\\worktrees\\wt\\commondir: Result too large",
		)).toBe(true);
	});

	it("leaves permanent failures alone", () => {
		expect(isTransientWorktreeAddFailure("fatal: a branch named 'x' already exists")).toBe(false);
		expect(isTransientWorktreeAddFailure("fatal: invalid reference: nope")).toBe(false);
		expect(isTransientWorktreeAddFailure("fatal: 'x' is already used by worktree at '/y'")).toBe(false);
	});

	it("backs off exponentially up to the cap, with half of each delay random", () => {
		const policy = { baseDelayMs: 150, maxDelayMs: 2_000 };
		expect([0, 1, 2, 3, 4, 5].map((r) => gitLockRetryDelayMs(r, policy, () => 1)))
			.toEqual([150, 300, 600, 1_200, 2_000, 2_000]);
		expect([0, 1, 2, 3, 4, 5].map((r) => gitLockRetryDelayMs(r, policy, () => 0)))
			.toEqual([75, 150, 300, 600, 1_000, 1_000]);
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

	it("throws a clear empty-repo error when repo has no commits at all", async () => {
		const r = createEmptyRepo();
		try {
			const project = makeProject(r.local);
			const task = makeTask({
				id: "33333333-4444-5555-6666-777777777777",
			});

			// Empty repos get an empty-repo-specific message (create an initial
			// commit), not the generic "branch does not exist" guidance which
			// misleads the user into changing their base-branch setting.
			await expect(createWorktree(project, task)).rejects.toThrow(
				/no commits yet/i,
			);
		} finally {
			cleanupLocal(r);
		}
	});

	it("self-heals a stale dev3/task-* branch left behind from a failed cleanup", async () => {
		// Regression: when a previous move-to-completed failed to delete the
		// branch (e.g. because the worktree dir was gone, so removeWorktree
		// aborted), the next revive of the same task from completed/cancelled
		// was failing with "a branch named '...' already exists".
		const r = createLocalOnlyRepo("main");
		try {
			const project = makeProject(r.local);
			const task = makeTask({ id: "44444444-5555-6666-7777-888888888888" });

			// Pre-create the stale branch as if a prior cleanup had left it behind.
			g("git branch dev3/task-44444444 main", r.local);

			const result = await createWorktree(project, task);
			expect(existsSync(result.worktreePath)).toBe(true);
			expect(result.branchName).toBe("dev3/task-44444444");
		} finally {
			cleanupLocal(r);
		}
	});

	it("self-heals a stale worktree directory left behind from a failed cleanup", async () => {
		const r = createLocalOnlyRepo("main");
		try {
			const project = makeProject(r.local);
			const task = makeTask({ id: "55555555-6666-7777-8888-999999999999" });

			// Pre-create the worktree at the path createWorktree will pick, then
			// detach it so the path is "stale" (directory present, branch removed).
			const stalePath = join(TEST_HOME, "worktrees", "tmp-repo", "55555555", "worktree");
			mkdirSync(stalePath, { recursive: true });
			writeFileSync(join(stalePath, "leftover.txt"), "leftover\n");

			const result = await createWorktree(project, task);
			expect(existsSync(result.worktreePath)).toBe(true);
			expect(result.branchName).toBe("dev3/task-55555555");
			// The leftover file should be gone — the directory was reclaimed.
			expect(existsSync(join(result.worktreePath, "leftover.txt"))).toBe(false);
		} finally {
			cleanupLocal(r);
		}
	});

	it("self-heals when BOTH a stale dir and a stale branch are present", async () => {
		// Regression for a real user log on PR #571: stale branch +
		// post-side-effect stale dir caused a retry-based fix to fail because
		// the first attempt cleaned only one condition and the second tripped
		// on the other. Proactive cleanup must handle both in a single pass.
		const r = createLocalOnlyRepo("main");
		try {
			const project = makeProject(r.local);
			const task = makeTask({ id: "66666666-7777-8888-9999-aaaaaaaaaaaa" });

			// Stale branch.
			g("git branch dev3/task-66666666 main", r.local);

			// Stale worktree directory at the exact path createWorktree will pick.
			const stalePath = join(TEST_HOME, "worktrees", "tmp-repo", "66666666", "worktree");
			mkdirSync(stalePath, { recursive: true });
			writeFileSync(join(stalePath, "leftover.txt"), "leftover\n");

			const result = await createWorktree(project, task);
			expect(existsSync(result.worktreePath)).toBe(true);
			expect(result.branchName).toBe("dev3/task-66666666");
			expect(existsSync(join(result.worktreePath, "leftover.txt"))).toBe(false);
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

	it("throws on init failure for non-git directory", async () => {
		const tmpDir = join(tmpdir(), `sparse-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		try {
			await expect(
				applySparseCheckout(tmpDir, ["src"]),
			).rejects.toThrow("Failed to init sparse checkout");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
