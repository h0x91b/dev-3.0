import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { Project, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/git-task-work-disposable`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import {
	assertTaskWorkDisposable,
	assertWorkspaceReclaimable,
	createWorktree,
	_resetFetchState,
	WorkspaceReclaimRefusedError,
} from "../git";
import { createTestRepo, cleanup, g, type TestRepo } from "./git-test-helpers";

const TASK_ID = "d2d2d2d2-0000-0000-0000-000000000000";

function project(path: string): Project {
	return { id: "p", name: "T", path, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" };
}
function task(over: Partial<Task> = {}): Task {
	return {
		id: TASK_ID, seq: 1, projectId: "p", title: "t", description: "",
		status: "user-questions", baseBranch: "main", worktreePath: null, branchName: null, groupId: null,
		variantIndex: null, agentId: null, configId: null, createdAt: "", updatedAt: "", ...over,
	};
}
function commit(dir: string, file: string): string {
	writeFileSync(join(dir, file), `${file}\n`);
	g(`git add ${file} && git commit -m ${file}`, dir);
	return g("git rev-parse HEAD", dir).trim();
}
async function refusal(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
		return null;
	} catch (err) {
		if (err instanceof WorkspaceReclaimRefusedError) return err.kind;
		throw err;
	}
}

let repo: TestRepo;
beforeEach(() => { _resetFetchState(); repo = createTestRepo(); });
afterEach(() => cleanup(repo));

// PR #2059 review: removing imported tasks relied on assertWorkspaceReclaimable,
// which counts the worktree's own branch as "found elsewhere", so an unpushed
// commit on dev3/task-* passed and the delete then removed the branch.
describe("assertTaskWorkDisposable", () => {
	it("allows a fresh worktree with nothing on its branch", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		expect(await refusal(assertTaskWorkDisposable(p, task(wt)))).toBeNull();
	});

	it("refuses a clean worktree whose own branch holds an unpushed commit", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		commit(wt.worktreePath, "work.txt");

		// The gap: the folder check alone calls this reclaimable.
		expect(await refusal(assertWorkspaceReclaimable(wt.worktreePath))).toBeNull();
		expect(await refusal(assertTaskWorkDisposable(p, task(wt)))).toBe("unique-commits");
	});

	it("refuses when HEAD is detached at the branch's unpushed commit", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		commit(wt.worktreePath, "work.txt");
		g("git checkout --detach", wt.worktreePath);

		expect(await refusal(assertTaskWorkDisposable(p, task(wt)))).toBe("unique-commits");
	});

	it("refuses when the worktree folder is gone but the branch still holds the commit", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		commit(wt.worktreePath, "work.txt");
		rmSync(wt.worktreePath, { recursive: true, force: true });

		expect(await refusal(assertTaskWorkDisposable(p, task(wt)))).toBe("unique-commits");
	});

	it("allows the branch once its commit is pushed", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		commit(wt.worktreePath, "work.txt");
		g(`git push origin ${wt.branchName}`, wt.worktreePath);

		expect(await refusal(assertTaskWorkDisposable(p, task(wt)))).toBeNull();
	});

	it("refuses uncommitted files", async () => {
		const p = project(repo.local);
		const wt = await createWorktree(p, task());
		writeFileSync(join(wt.worktreePath, "draft.txt"), "draft\n");

		expect(await refusal(assertTaskWorkDisposable(p, task(wt)))).toBe("dirty-dir");
	});
});
