/**
 * An Operations (virtual) task can attach a local git repo: reads (diff, branch
 * status) go to that repo, every write RPC stays rejected. Real git repos, real
 * `git.ts`; only the board and the agent hand-off are faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	updateTask: vi.fn(),
	push: vi.fn(),
	deliverAgentPrompt: vi.fn(async (_task: unknown, _prompt: string) => ({ status: "delivered", reason: null })),
}));

vi.mock("../../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../paths", async (importOriginal) => {
	const { realpathSync, mkdirSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const opsDir = `${realpathSync(tmpdir())}/dev3-ops-dir-test`;
	mkdirSync(opsDir, { recursive: true });
	return { ...(await importOriginal<typeof import("../../paths")>()), DEV3_HOME: "/tmp/dev3-test", OPS_DIR: opsDir };
});
vi.mock("../../spawn", async () => {
	const { createSpawnMock } = await import("../../__tests__/git-test-helpers");
	return createSpawnMock();
});
vi.mock("../shared", () => ({
	getPushMessage: () => mocks.push,
	isActive: (status: string) => ["in-progress", "user-questions", "review-by-ai", "review-by-user", "review-by-colleague"].includes(status),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../data", () => ({
	getProject: mocks.getProject,
	getTask: mocks.getTask,
	updateTask: mocks.updateTask,
}));
vi.mock("../../task-aux-panes", () => ({ openAuxPane: vi.fn(), auxPaneAlive: vi.fn(async () => false), auxPaneTitle: () => "Git" }));
vi.mock("../../github", () => ({ getGitHubShellExports: vi.fn(async () => []), findOpenPullRequest: vi.fn() }));
vi.mock("../../settings", () => ({ loadSettings: vi.fn(async () => ({})) }));
vi.mock("../../agent-prompt-delivery", () => ({ deliverAgentPrompt: mocks.deliverAgentPrompt }));
vi.mock("../../scheduled-message-scheduler", () => ({
	scheduleMessage: vi.fn(),
	cancelScheduledMessage: vi.fn(),
	sendScheduledMessageNow: vi.fn(),
}));
vi.mock("../../task-branch-sync", () => ({ syncTaskBranchName: vi.fn() }));
vi.mock("../../lifecycle/service", () => ({ lifecycleActorRuntime: vi.fn(() => ({})) }));
vi.mock("../../lifecycle/activities", () => ({
	PR_DETECTION_TIMEOUT_MS: 1000,
	dismissMergeCompletionPrompt: vi.fn(),
	persistProjectPrIdentities: vi.fn(),
	persistTaskPrIdentity: vi.fn(),
	prepareMergeCompletionPrompt: vi.fn(),
	refreshTaskPrStatus: vi.fn(),
	reportTaskPrStatus: vi.fn(),
}));
vi.mock("../../lifecycle/merge-fingerprint", () => ({ getMergeCompletionFingerprint: vi.fn() }));

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, createTestRepo, g, type TestRepo } from "../../__tests__/git-test-helpers";
import { createOpsWorktree } from "../../git";
import { gitOperationHandlers as handlers } from "../git-operations";

const VPROJECT = { id: "vp1", kind: "virtual", path: "/tmp/dev3-test/ops/operations" } as any;
const GPROJECT = { id: "gp1", kind: "git", path: "/tmp/dev3-test/repo", defaultBaseBranch: "main" } as any;

function vtask(overrides: Record<string, unknown> = {}) {
	return {
		id: "abcdef12-0000-0000-0000-000000000001",
		projectId: "vp1",
		status: "in-progress",
		worktreePath: "/tmp/dev3-test/ops/operations/abcdef12/work",
		...overrides,
	} as any;
}

let repo: TestRepo;
let root: string;
const scratch: string[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	repo = createTestRepo();
	root = realpathSync(repo.local);
	mocks.getProject.mockResolvedValue(VPROJECT);
	mocks.getTask.mockResolvedValue(vtask());
	mocks.updateTask.mockImplementation(async (_p: unknown, _id: string, updates: Record<string, unknown>) => vtask(updates));
});

afterEach(() => {
	cleanup(repo);
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("setTaskAttachedRepo", () => {
	it("saves the repo root and pushes taskUpdated", async () => {
		await handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: root });
		expect(mocks.updateTask).toHaveBeenCalledWith(VPROJECT, expect.any(String), { attachedRepo: root, baseBranch: "main" });
		expect(mocks.push).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ projectId: "vp1" }));
	});

	it("stores the root when given a subfolder", async () => {
		const sub = join(root, "src", "deep");
		mkdirSync(sub, { recursive: true });
		await handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: sub });
		expect(mocks.updateTask).toHaveBeenCalledWith(VPROJECT, expect.any(String), { attachedRepo: root, baseBranch: "main" });
	});

	it("rejects a folder that is not a repository and leaves the task alone", async () => {
		const plain = mkdtempSync(join(tmpdir(), "dev3-plain-"));
		scratch.push(plain);
		await expect(handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: plain }))
			.rejects.toThrow(/Not a git repository/);
		expect(mocks.updateTask).not.toHaveBeenCalled();
	});

	it("detects the default branch once and stores it as the task's base", async () => {
		g("git checkout -q -b trunk", root);
		g("git branch -D main", root);
		g("git update-ref -d refs/remotes/origin/main", root);
		g("git remote remove origin", root);
		await handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: root });
		expect(mocks.updateTask).toHaveBeenCalledWith(VPROJECT, expect.any(String), { attachedRepo: root, baseBranch: "trunk" });
	});

	it("rejects a repo that lives inside an Operations task folder, which is deleted with the task", async () => {
		const { OPS_DIR } = await import("../../paths");
		const inside = `${OPS_DIR}/slug/abcdef12/work/clone`;
		mkdirSync(inside, { recursive: true });
		g("git init -q", inside);

		await expect(handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: inside }))
			.rejects.toThrow(/inside an Operations task folder/);
		expect(mocks.updateTask).not.toHaveBeenCalled();
		rmSync(`${OPS_DIR}/slug`, { recursive: true, force: true });
	});

	it("detaches with a null path and does not message the agent", async () => {
		await handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: null });
		expect(mocks.updateTask).toHaveBeenCalledWith(VPROJECT, expect.any(String), { attachedRepo: null });
		expect(mocks.deliverAgentPrompt).not.toHaveBeenCalled();
	});

	it("rejects a git (non-virtual) project", async () => {
		mocks.getProject.mockResolvedValue(GPROJECT);
		await expect(handlers.setTaskAttachedRepo({ taskId: "t", projectId: "gp1", path: root }))
			.rejects.toThrow(/Operations task/);
		expect(mocks.updateTask).not.toHaveBeenCalled();
	});

	it("tells an active task's agent once", async () => {
		await handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: root });
		expect(mocks.deliverAgentPrompt).toHaveBeenCalledTimes(1);
		expect(String(mocks.deliverAgentPrompt.mock.calls[0][1])).toContain(`attached to this task: ${root}`);
	});

	it("does not message an inactive task", async () => {
		mocks.updateTask.mockImplementation(async (_p: unknown, _id: string, updates: Record<string, unknown>) => vtask({ ...updates, status: "todo" }));
		await handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: root });
		expect(mocks.deliverAgentPrompt).not.toHaveBeenCalled();
	});

	it("survives a failed agent hand-off", async () => {
		mocks.deliverAgentPrompt.mockRejectedValueOnce(new Error("no pane"));
		await expect(handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: root })).resolves.toBeDefined();
	});
});

describe("reads on a virtual task with an attached repo", () => {
	it("getTaskDiff (uncommitted) returns the repo's changes", async () => {
		writeFileSync(join(root, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
		mocks.getTask.mockResolvedValue(vtask({ attachedRepo: root }));
		const diff = await handlers.getTaskDiff({ taskId: "t", projectId: "vp1", mode: "uncommitted" });
		expect(diff.files.map((f) => f.newPath ?? f.oldPath)).toContain("app.ts");
	});

	it("getTaskDiff without an attached repo is still rejected", async () => {
		await expect(handlers.getTaskDiff({ taskId: "t", projectId: "vp1", mode: "uncommitted" }))
			.rejects.toThrow(/not available for Operations/i);
	});

	it("reads the stored base instead of detecting it again", async () => {
		g("git checkout -q -b trunk", root);
		writeFileSync(join(root, "t.ts"), "x\n");
		g("git add t.ts", root);
		g('git -c user.email=t@t -c user.name=T commit -m t', root);
		mocks.getTask.mockResolvedValue(vtask({ attachedRepo: root, baseBranch: "main" }));
		const status = await handlers.getBranchStatus({ taskId: "t", projectId: "vp1" });
		expect(status.ahead).toBe(1);
	});

	it("getTaskDiff on a missing repo names it", async () => {
		mocks.getTask.mockResolvedValue(vtask({ attachedRepo: "/tmp/dev3-gone-repo" }));
		await expect(handlers.getTaskDiff({ taskId: "t", projectId: "vp1", mode: "uncommitted" }))
			.rejects.toThrow("Attached repository not found: /tmp/dev3-gone-repo");
	});

	it("getBranchStatus reports local facts: uncommitted lines, no PR", async () => {
		writeFileSync(join(root, "app.ts"), "const a = 1;\nconst b = 22;\nconst c = 3;\n");
		mocks.getTask.mockResolvedValue(vtask({ attachedRepo: root }));
		const status = await handlers.getBranchStatus({ taskId: "t", projectId: "vp1" });
		expect(status.insertions).toBe(1);
		expect(status.deletions).toBe(1);
		expect(status.prNumber).toBeNull();
		expect(status.mergeCompletionFingerprint).toBeNull();
		expect(status.hasRemote).toBe(true);
	});

	it("getBranchStatus on a deleted repo is inert and does not throw", async () => {
		mocks.getTask.mockResolvedValue(vtask({ attachedRepo: "/tmp/dev3-gone-repo" }));
		const status = await handlers.getBranchStatus({ taskId: "t", projectId: "vp1" });
		expect(status.ahead).toBe(0);
		expect(status.diffFiles).toBe(0);
		expect(status.hasRemote).toBe(false);
	});

	it.each([
		["pushTask", (p: any) => handlers.pushTask(p)],
		["mergeTask", (p: any) => handlers.mergeTask(p)],
		["rebaseTask", (p: any) => handlers.rebaseTask(p)],
		["createPullRequest", (p: any) => handlers.createPullRequest(p)],
		["rebaseTaskViaAgent", (p: any) => handlers.rebaseTaskViaAgent(p)],
		["commitTaskViaAgent", (p: any) => handlers.commitTaskViaAgent(p)],
		["openPullRequest", (p: any) => handlers.openPullRequest(p)],
	])("%s stays rejected", async (_name, call) => {
		mocks.getTask.mockResolvedValue(vtask({ attachedRepo: root }));
		await expect(call({ taskId: "t", projectId: "vp1" })).rejects.toThrow(/not available for Operations/i);
	});
});

describe("worktree mode", () => {
	let wt: string;
	const wtTask = (overrides: Record<string, unknown> = {}) => vtask({
		attachedRepo: root, opsWorktree: true, baseBranch: "main", branchName: "dev3/task-abcdef12", worktreePath: wt, ...overrides,
	});

	beforeEach(async () => {
		wt = join(repo.dir, "ops", "abcdef12", "work");
		await createOpsWorktree(root, vtask(), wt, "main");
	});

	it("getTaskDiff reads the worktree, not the repo", async () => {
		writeFileSync(join(wt, "app.ts"), "const a = 100;\n");
		writeFileSync(join(root, "other.ts"), "dirty in the repo, not in the worktree\n");
		mocks.getTask.mockResolvedValue(wtTask());

		const diff = await handlers.getTaskDiff({ taskId: "t", projectId: "vp1", mode: "uncommitted" });

		const paths = diff.files.map((f) => f.newPath ?? f.oldPath);
		expect(paths).toContain("app.ts");
		expect(paths).not.toContain("other.ts");
	});

	it("branch mode compares the task's commits against the stored base", async () => {
		writeFileSync(join(wt, "feature.ts"), "export const x = 1;\n");
		g("git add feature.ts", wt);
		g('git -c user.email=t@t -c user.name=T commit -m feature', wt);
		mocks.getTask.mockResolvedValue(wtTask());

		const diff = await handlers.getTaskDiff({ taskId: "t", projectId: "vp1", mode: "branch" });
		const status = await handlers.getBranchStatus({ taskId: "t", projectId: "vp1" });

		expect(diff.files.map((f) => f.newPath ?? f.oldPath)).toEqual(["feature.ts"]);
		expect(status.ahead).toBe(1);
		expect(status.diffFiles).toBe(1);
	});

	it("getUnsavedWork reports uncommitted and unpushed work of the worktree", async () => {
		writeFileSync(join(wt, "app.ts"), "const a = 100;\n");
		writeFileSync(join(wt, "feature.ts"), "export const x = 1;\n");
		g("git add feature.ts", wt);
		g('git -c user.email=t@t -c user.name=T commit -m feature', wt);
		mocks.getTask.mockResolvedValue(wtTask());

		const unsaved = await handlers.getUnsavedWork({ taskId: "t", projectId: "vp1" });

		expect(unsaved.insertions + unsaved.deletions).toBeGreaterThan(0);
		expect(unsaved.ahead).toBe(1);
		expect(unsaved.unpushed).not.toBe(0);
	});

	it("getUnsavedWork stays empty for a plain attached repo with local changes", async () => {
		writeFileSync(join(root, "app.ts"), "const a = 100;\n");
		mocks.getTask.mockResolvedValue(vtask({ attachedRepo: root }));

		const unsaved = await handlers.getUnsavedWork({ taskId: "t", projectId: "vp1" });

		expect(unsaved).toMatchObject({ insertions: 0, deletions: 0, unpushed: 0, ahead: 0 });
	});

	it("a vanished worktree is an error, never a clean status, for status and unsaved work alike", async () => {
		mocks.getTask.mockResolvedValue(wtTask({ worktreePath: "/tmp/dev3-gone-worktree" }));
		await expect(handlers.getBranchStatus({ taskId: "t", projectId: "vp1" })).rejects.toThrow(/Task worktree not found/);
		await expect(handlers.getUnsavedWork({ taskId: "t", projectId: "vp1" })).rejects.toThrow(/Task worktree not found/);
	});

	it("a vanished attached repo is an error for unsaved work too", async () => {
		mocks.getTask.mockResolvedValue(wtTask({ attachedRepo: "/tmp/dev3-gone-repo" }));
		await expect(handlers.getUnsavedWork({ taskId: "t", projectId: "vp1" })).rejects.toThrow(/Attached repository not found/);
	});

	it("refuses to change or detach the repo of a worktree task", async () => {
		mocks.getTask.mockResolvedValue(wtTask());
		await expect(handlers.setTaskAttachedRepo({ taskId: "t", projectId: "vp1", path: null }))
			.rejects.toThrow(/cannot be changed/);
		expect(mocks.updateTask).not.toHaveBeenCalled();
	});
});

describe("inspectOpsFolder", () => {
	it("returns the repo root and its default branch for a subfolder", async () => {
		const sub = join(root, "src");
		mkdirSync(sub, { recursive: true });
		expect(await handlers.inspectOpsFolder({ path: sub })).toEqual({ repoRoot: root, defaultBranch: "main" });
	});

	it("returns nulls for a folder outside any repo", async () => {
		const plain = mkdtempSync(join(tmpdir(), "dev3-plain-"));
		scratch.push(plain);
		expect(await handlers.inspectOpsFolder({ path: plain })).toEqual({ repoRoot: null, defaultBranch: null });
	});
});
