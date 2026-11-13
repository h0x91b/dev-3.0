import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/dev3-test" }));
vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, createTestRepo, g, spawnedCommands, type TestRepo } from "./git-test-helpers";
import { createOpsWorktree, isWorktreeDirtyOrUnknown, getDefaultBranch, getMainRepoOfLinkedWorktree, getRepoTopLevel, removeLinkedWorktree, pruneWorktrees, _resetFetchState } from "../git";

const task = { id: "abcdef12-0000-0000-0000-000000000009" } as any;

describe("Operations worktree", () => {
	let repo: TestRepo;
	let wtPath: string;

	beforeEach(() => {
		repo = createTestRepo();
		_resetFetchState();
		wtPath = join(repo.dir, "ops", "abcdef12", "work");
	});
	afterEach(() => cleanup(repo));

	it("adds a worktree on dev3/task-<shortId> from the base branch", async () => {
		const created = await createOpsWorktree(repo.local, task, wtPath, "main");

		expect(created).toEqual({ worktreePath: wtPath, branchName: "dev3/task-abcdef12" });
		expect(g("git rev-parse --abbrev-ref HEAD", wtPath).trim()).toBe("dev3/task-abcdef12");
		expect(readFileSync(join(wtPath, "app.ts"), "utf-8")).toContain("const a = 1");
		expect(g("git worktree list", repo.local)).toContain(wtPath);
	});

	it("keeps an existing worktree on a reopen", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		writeFileSync(join(wtPath, "wip.txt"), "work in progress");

		await createOpsWorktree(repo.local, task, wtPath, "main");

		expect(existsSync(join(wtPath, "wip.txt"))).toBe(true);
	});

	it("adopts a leftover branch of the same task instead of failing", async () => {
		g("git branch dev3/task-abcdef12", repo.local);
		await createOpsWorktree(repo.local, task, wtPath, "main");
		expect(g("git rev-parse --abbrev-ref HEAD", wtPath).trim()).toBe("dev3/task-abcdef12");
	});

	it("says where the task branch is checked out when the user has it open elsewhere", async () => {
		g("git checkout -b dev3/task-abcdef12", repo.local);

		await expect(createOpsWorktree(repo.local, task, wtPath, "main")).rejects.toThrow(
			/Branch dev3\/task-abcdef12 is checked out at .+; switch it away and retry/,
		);
	});

	it("fails with git's reason when the base does not exist", async () => {
		await expect(createOpsWorktree(repo.local, task, wtPath, "no-such-branch")).rejects.toThrow(/Failed to create worktree/);
	});

	it("isWorktreeDirtyOrUnknown: clean is false, edits and an unreadable status are true", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		expect(await isWorktreeDirtyOrUnknown(wtPath)).toBe(false);
		writeFileSync(join(wtPath, "wip.txt"), "x");
		expect(await isWorktreeDirtyOrUnknown(wtPath)).toBe(true);
		expect(await isWorktreeDirtyOrUnknown(join(repo.dir, "no-such-dir"))).toBe(true);
	});

	it("isWorktreeDirtyOrUnknown sees untracked files even with status.showUntrackedFiles=no", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		g("git config status.showUntrackedFiles no", repo.local);
		writeFileSync(join(wtPath, "untracked.txt"), "x");

		expect(await isWorktreeDirtyOrUnknown(wtPath)).toBe(true);
	});

	it("isWorktreeDirtyOrUnknown sees changes inside a submodule configured with ignore=all", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		const sub = join(repo.dir, "sub-src");
		g(`git init -q -b main ${sub}`, repo.dir);
		writeFileSync(join(sub, "lib.txt"), "v1");
		g("git add . && git -c user.email=t@t -c user.name=t commit -qm sub", sub);
		g(`git -c protocol.file.allow=always submodule add -q ${sub} sub`, wtPath);
		g("git -c user.email=t@t -c user.name=t commit -qm add-sub", wtPath);
		g("git config submodule.sub.ignore all", wtPath);
		writeFileSync(join(wtPath, "sub", "lib.txt"), "v2");

		expect(await isWorktreeDirtyOrUnknown(wtPath)).toBe(true);
	});

	it("prune drops the registration of a deleted dir and keeps the branch and the repo", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		rmSync(wtPath, { recursive: true, force: true });

		await pruneWorktrees(repo.local);

		expect(g("git worktree list", repo.local)).not.toContain(wtPath);
		expect(g("git branch --list dev3/task-abcdef12", repo.local)).toContain("dev3/task-abcdef12");
		expect(existsSync(join(repo.local, "app.ts"))).toBe(true);
	});

	it("prune never throws, even on a path that is not a repo", async () => {
		await expect(pruneWorktrees("/tmp/dev3-not-a-repo-xyz")).resolves.toBeUndefined();
	});

	it("getRepoTopLevel resolves a subfolder to the root and a non-repo to null", async () => {
		const sub = join(repo.local, "x");
		g("mkdir x", repo.local);
		expect(await getRepoTopLevel(sub)).toBe(await getRepoTopLevel(repo.local));
		expect(await getRepoTopLevel("/tmp/dev3-not-a-repo-xyz")).toBeNull();
	});
	it("getMainRepoOfLinkedWorktree names the owning repo of a linked worktree", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		expect(await getMainRepoOfLinkedWorktree(wtPath)).toBe(realpathSync(repo.local));
	});

	it("getMainRepoOfLinkedWorktree is null for a plain checkout and for a path that is not a repo", async () => {
		expect(await getMainRepoOfLinkedWorktree(repo.local)).toBeNull();
		expect(await getMainRepoOfLinkedWorktree("/tmp/dev3-not-a-repo-xyz")).toBeNull();
	});

	it("removeLinkedWorktree drops the worktree and its registration but keeps the branch", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		writeFileSync(join(wtPath, "dirty.ts"), "uncommitted\n");

		expect(await removeLinkedWorktree(repo.local, wtPath)).toBe(true);

		expect(existsSync(wtPath)).toBe(false);
		expect(g("git worktree list", repo.local)).not.toContain("abcdef12");
		expect(g("git branch --list dev3/task-abcdef12", repo.local)).toContain("dev3/task-abcdef12");
	});

	it("removeLinkedWorktree removes a locked worktree too, and its registration is gone", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		g(`git worktree lock ${wtPath}`, repo.local);

		expect(await removeLinkedWorktree(repo.local, wtPath)).toBe(true);

		expect(existsSync(wtPath)).toBe(false);
		expect(g("git worktree list", repo.local)).not.toContain("abcdef12");
	});

	it("removeLinkedWorktree falls back to rm and prune when git refuses, leaving no registration", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		// Git refuses to remove a worktree whose .git file is gone ("validation failed").
		rmSync(join(wtPath, ".git"));
		expect(() => g(`git worktree remove --force --force ${wtPath}`, repo.local)).toThrow();

		expect(await removeLinkedWorktree(repo.local, wtPath)).toBe(true);

		expect(existsSync(wtPath)).toBe(false);
		expect(g("git worktree list", repo.local)).not.toContain("abcdef12");
	});

	it("removeLinkedWorktree never throws when the main repo is gone", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		expect(await removeLinkedWorktree("/tmp/dev3-not-a-repo-xyz", wtPath)).toBe(true);
		expect(existsSync(wtPath)).toBe(false);
	});

	it("re-adds the worktree after a prune that never ran: the stale registration no longer blocks the path", async () => {
		await createOpsWorktree(repo.local, task, wtPath, "main");
		rmSync(wtPath, { recursive: true, force: true });

		const again = await createOpsWorktree(repo.local, task, wtPath, "main");

		expect(again.worktreePath).toBe(wtPath);
		expect(g("git rev-parse --abbrev-ref HEAD", wtPath).trim()).toBe("dev3/task-abcdef12");
	});

	it("local default-branch detection reads only: no set-head, so no network and no write into the repo", async () => {
		g("git update-ref -d refs/remotes/origin/HEAD", repo.local);
		spawnedCommands.length = 0;

		expect(await getDefaultBranch(repo.local, { local: true })).toBe("main");

		expect(spawnedCommands.some((cmd) => cmd.includes("set-head"))).toBe(false);
	});

	it("local detection with no origin/HEAD and no remote falls back to the local main or master", async () => {
		g("git remote remove origin", repo.local);
		g("git branch -m main master", repo.local);

		expect(await getDefaultBranch(repo.local, { local: true })).toBe("master");
	});
});
