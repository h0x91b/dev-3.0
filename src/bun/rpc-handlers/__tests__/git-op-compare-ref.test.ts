/**
 * WHICH REF the git actions actually run against — the call sites, not the
 * resolver.
 *
 * `git-diff-no-remote.test.ts` already proved that a repo with no remote resolves
 * its comparison base to the LOCAL base branch, and it stayed green while the
 * Rebase button announced `master` and ran `git rebase origin/master` (Seq 1642).
 * The resolution and its USE are two separate things: this file drives the
 * handlers and reads the script that reaches the pane.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
	getProject: vi.fn(),
	getTask: vi.fn(),
	openAuxPane: vi.fn(),
	writeLaunchScript: vi.fn(async (_scriptPath: string, _body: string) => {}),
	refExists: vi.fn(async () => true),
	detectDefaultCompareRef: vi.fn(async (_path: string, base: string) => base),
	getBranchStatus: vi.fn(async () => ({ ahead: 1, behind: 0 })),
	fetchCompareRef: vi.fn(async () => true),
	deliverAgentPrompt: vi.fn(async (_task: unknown, _prompt: string) => ({ status: "delivered", reason: null })),
}));

vi.mock("../shared", () => ({
	getPushMessage: () => null,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../data", () => ({
	getProject: mocks.getProject,
	getTask: mocks.getTask,
	updateTask: vi.fn(),
}));

vi.mock("../../git", () => ({
	refExists: mocks.refExists,
	detectDefaultCompareRef: mocks.detectDefaultCompareRef,
	// The real one: an explicit ref wins, otherwise git decides. Not re-implemented
	// here — the whole point is that every action funnels through it.
	resolveCompareRef: async (path: string, base: string, explicit?: string) =>
		explicit || mocks.detectDefaultCompareRef(path, base),
	getCurrentBranch: vi.fn(async () => "dev3/feature"),
	fetchOrigin: vi.fn(async () => true),
	fetchCompareRef: mocks.fetchCompareRef,
	getBranchStatus: mocks.getBranchStatus,
	hasOriginRemote: vi.fn(async () => false),
	getBehindOriginCount: vi.fn(async () => 0),
	resolveRef: vi.fn(async () => "1111111111111111111111111111111111111111"),
}));

vi.mock("../../task-aux-panes", () => ({
	openAuxPane: mocks.openAuxPane,
	auxPaneAlive: vi.fn(async () => false),
	auxPaneTitle: () => "Git",
}));

vi.mock("../shared-pure", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared-pure")>()),
	writeLaunchScript: mocks.writeLaunchScript,
}));

vi.mock("../../github", () => ({ getGitHubShellExports: vi.fn(async () => []) }));
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
}));
vi.mock("../../lifecycle/merge-fingerprint", () => ({ getMergeCompletionFingerprint: vi.fn() }));

import { gitOperationHandlers } from "../git-operations";

const PROJECT = { id: "proj-1", name: "p", path: "/repo", defaultBaseBranch: "master" } as any;
const TASK = {
	id: "abcdef12-0000-0000-0000-000000000042",
	title: "Separate units",
	branchName: "feat/dev3-unit-separation",
	worktreePath: "/repo/wt",
} as any;

/** The script text the pane would run. */
function paneScript(): string {
	const call = mocks.writeLaunchScript.mock.calls.find(([path]) => !String(path).endsWith(".txt"));
	return String(call?.[1] ?? "");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	mocks.getProject.mockResolvedValue(PROJECT);
	mocks.getTask.mockResolvedValue(TASK);
	mocks.refExists.mockResolvedValue(true);
	mocks.detectDefaultCompareRef.mockImplementation(async (_path: string, base: string) => base);
	mocks.getBranchStatus.mockResolvedValue({ ahead: 1, behind: 0 });
	mocks.openAuxPane.mockResolvedValue({ backend: "native", paneId: "%9" });
});

describe("rebase in a repo with no remote", () => {
	it("rebases onto the local base branch, never origin/<base>", async () => {
		await gitOperationHandlers.rebaseTask({ taskId: TASK.id, projectId: PROJECT.id });
		const script = paneScript();
		expect(script).toContain("git rebase master");
		expect(script).not.toContain("origin/master");
	});

	it("does not fetch at all", async () => {
		await gitOperationHandlers.rebaseTask({ taskId: TASK.id, projectId: PROJECT.id });
		expect(paneScript()).not.toContain("git fetch");
	});

	it("hands the agent a conflict prompt without a fetch it cannot run", async () => {
		await gitOperationHandlers.rebaseTaskViaAgent({ taskId: TASK.id, projectId: PROJECT.id });
		const prompt = String(mocks.deliverAgentPrompt.mock.calls[0][1]);
		expect(prompt).toContain("git rebase master");
		expect(prompt).not.toContain("git fetch origin");
	});
});

describe("rebase with a remote — the positive control", () => {
	beforeEach(() => {
		mocks.detectDefaultCompareRef.mockResolvedValue("origin/master");
	});

	it("still rebases onto origin/<base> and fetches it first", async () => {
		await gitOperationHandlers.rebaseTask({ taskId: TASK.id, projectId: PROJECT.id });
		const script = paneScript();
		expect(script).toContain("git fetch origin master");
		expect(script).toContain("git rebase origin/master");
	});
});

describe("rebase target that is not there", () => {
	it("refuses before opening a pane instead of dying on `invalid upstream`", async () => {
		mocks.refExists.mockResolvedValue(false);
		await expect(gitOperationHandlers.rebaseTask({ taskId: TASK.id, projectId: PROJECT.id }))
			.rejects.toThrow(/does not exist in this repository/);
		expect(mocks.openAuxPane).not.toHaveBeenCalled();
	});
});

describe("the user's explicit compare ref", () => {
	it("wins over whatever git would have detected", async () => {
		mocks.detectDefaultCompareRef.mockResolvedValue("origin/master");
		await gitOperationHandlers.rebaseTask({
			taskId: TASK.id,
			projectId: PROJECT.id,
			compareRef: "review/base",
		});
		expect(paneScript()).toContain("git rebase review/base");
	});
});

describe("merge's rebase guard", () => {
	it("measures against the local base with no remote, so it can actually fire", async () => {
		mocks.getBranchStatus.mockResolvedValue({ ahead: 1, behind: 2 });
		await expect(gitOperationHandlers.mergeTask({ taskId: TASK.id, projectId: PROJECT.id }))
			.rejects.toThrow(/not rebased/);
		expect(mocks.getBranchStatus).toHaveBeenCalledWith("/repo/wt", "master");
	});
});
