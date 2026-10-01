import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { join } from "path";
import type { Project, Task } from "../../shared/types";

// A worktree left for dev3 to delete can be a monorepo tree; deleting it with
// rmSync froze every RPC for seconds. Both fallback deletes must stay async.
const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/git-delete-off-host`);

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const rmSync = vi.fn(actual.rmSync);
	return { ...actual, rmSync, default: { ...actual, rmSync } };
});
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { createWorktree, removeWorktree, taskDir } from "../git";
import { cleanup, createTestRepo, g, type TestRepo } from "./git-test-helpers";

const project = (path: string): Project => ({
	id: "proj-1", name: "Test", path, setupScript: "", devScript: "", cleanupScript: "",
	defaultBaseBranch: "main", createdAt: new Date().toISOString(),
});
const task = (id: string): Task => ({
	id, seq: 1, projectId: "proj-1", title: "t", description: "", status: "in-progress",
	baseBranch: "main", worktreePath: null, branchName: null,
	createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
} as Task);

describe("worktree deletes stay off the host thread", () => {
	let repo: TestRepo;
	const hostRmSync = vi.mocked(fs.rmSync);

	beforeEach(() => {
		repo = createTestRepo();
		hostRmSync.mockClear();
	});
	afterEach(() => cleanup(repo));

	it("tears down a worktree git no longer knows without rmSync on the host", async () => {
		const p = project(repo.local);
		const t = task("77777777-8888-9999-aaaa-bbbbbbbbbbbb");
		const wtPath = join(taskDir(p, t), "worktree");
		fs.mkdirSync(taskDir(p, t), { recursive: true });
		g(`git worktree add -b dev3/task-77777777 "${wtPath}" main`, repo.local);
		fs.writeFileSync(join(wtPath, "big-tree-stand-in.txt"), "x\n");
		g(`rm -rf "${join(repo.local, ".git", "worktrees")}"`, repo.local);

		await removeWorktree(p, { ...t, worktreePath: wtPath });

		expect(fs.existsSync(wtPath)).toBe(false);
		expect(hostRmSync).not.toHaveBeenCalled();
	});

	it("reclaims a leftover folder git refuses to remove without rmSync on the host", async () => {
		const p = project(repo.local);
		const t = task("66666666-7777-8888-9999-aaaaaaaaaaaa");
		const first = await createWorktree(p, t);
		g(`git worktree remove --force "${first.worktreePath}"`, repo.local);
		fs.mkdirSync(first.worktreePath, { recursive: true });

		await expect(createWorktree(p, t)).resolves.toMatchObject({ worktreePath: first.worktreePath });
		expect(hostRmSync).not.toHaveBeenCalled();
	});
});
