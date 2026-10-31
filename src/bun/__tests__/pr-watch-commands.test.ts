import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";
import { PR_WATCH_NO_PR_PREFIX } from "../../shared/pr-watch";

const runtime = vi.hoisted(() => ({ prNextDue: 123 as number | undefined }));
vi.mock("../data", () => ({ getProject: vi.fn(), loadTasks: vi.fn(), loadProjects: vi.fn(async () => []), loadVirtualProjects: vi.fn(async () => []) }));
vi.mock("../git", () => ({ getCurrentBranch: vi.fn(), getHeadSha: vi.fn(), getRemoteBranchTips: vi.fn() }));
vi.mock("../github", () => ({ runGitHub: vi.fn(), findOpenPullRequest: vi.fn() }));
vi.mock("../lifecycle/activities", () => ({ persistTaskPrIdentity: vi.fn() }));
vi.mock("../lifecycle/service", () => ({ lifecycleActorRuntime: () => runtime }));
vi.mock("../scheduled-message-author", () => ({ captureScheduledMessageAuthor: vi.fn(async () => null) }));
vi.mock("../pr-watch-runner", () => ({ addPrWatch: vi.fn(), clearPrWatches: vi.fn(async () => 2) }));

import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import { persistTaskPrIdentity } from "../lifecycle/activities";
import { addPrWatch } from "../pr-watch-runner";
import { captureScheduledMessageAuthor } from "../scheduled-message-author";
import { PR_WATCH_GH_TIMEOUT_MS, prWatchHandlers } from "../cli-socket/pr-watch-commands";

const project = { id: "p1" } as Project;
const HEAD = "a".repeat(40);
let task: Task;

const add = (extra: Record<string, unknown> = {}) =>
	prWatchHandlers["pr.watch.add"]({ taskId: "t1", projectId: "p1", until: "ci", ...extra });

beforeEach(() => {
	vi.resetAllMocks();
	runtime.prNextDue = 123;
	task = { id: "t1", seq: 1, status: "in-progress", worktreePath: "/wt", branchName: "feat/x", prNumber: null, prUrl: null } as unknown as Task;
	vi.mocked(data.getProject).mockResolvedValue(project);
	vi.mocked(data.loadTasks).mockImplementation(async () => [task]);
	vi.mocked(git.getCurrentBranch).mockResolvedValue("feat/x");
	vi.mocked(git.getHeadSha).mockResolvedValue(HEAD);
	vi.mocked(git.getRemoteBranchTips).mockResolvedValue({ tips: [], ambiguous: false });
	vi.mocked(github.findOpenPullRequest).mockResolvedValue({ pr: { number: 7, url: "https://github.com/a/b/pull/7", title: null, author: null }, isGitHub: true });
});

describe("pr.watch.add", () => {
	it("looks up the open PR of the branch, records its identity and stores the watch at the local HEAD", async () => {
		const res = await add();

		expect(persistTaskPrIdentity).toHaveBeenCalledWith(project, task, 7, "https://github.com/a/b/pull/7");
		expect(vi.mocked(addPrWatch).mock.calls[0][2]).toMatchObject({ until: "ci", prNumber: 7, headSha: HEAD });
		expect(res).toMatchObject({ prNumber: 7, until: "ci" });
	});

	it("records the branch's authoritative remote tip at subscribe time", async () => {
		vi.mocked(git.getRemoteBranchTips).mockResolvedValue({ tips: ["9".repeat(40)], ambiguous: false });
		await add();
		expect(git.getRemoteBranchTips).toHaveBeenCalledWith("/wt", "feat/x");
		expect(vi.mocked(addPrWatch).mock.calls[0][2]).toMatchObject({ tipsAtSubscribe: ["9".repeat(40)] });
	});

	it("resets the poll schedule so the next tick checks the PR", async () => {
		await add();
		expect(runtime.prNextDue).toBeUndefined();
	});

	it("prefers the open PR of the branch over a stale one recorded on the task", async () => {
		task = { ...task, prNumber: 5, prUrl: "https://github.com/a/b/pull/5" } as Task;
		await add();
		expect(vi.mocked(addPrWatch).mock.calls[0][2]).toMatchObject({ prNumber: 7 });
		expect(persistTaskPrIdentity).toHaveBeenCalledWith(project, task, 7, "https://github.com/a/b/pull/7");
	});

	it("accepts --pr only when it is the open PR of the branch", async () => {
		await add({ prNumber: 7 });
		expect(vi.mocked(addPrWatch).mock.calls[0][2]).toMatchObject({ prNumber: 7 });
	});

	it("refuses --pr of a closed PR while another one is open on the branch", async () => {
		task = { ...task, prNumber: 5, prUrl: "https://github.com/a/b/pull/5" } as Task;

		await expect(add({ prNumber: 5 })).rejects.toThrow(PR_WATCH_NO_PR_PREFIX);

		expect(persistTaskPrIdentity).not.toHaveBeenCalled();
		expect(addPrWatch).not.toHaveBeenCalled();
	});

	it("never falls back to a recorded PR that is not open, e.g. when gh failed or timed out", async () => {
		task = { ...task, prNumber: 1, prUrl: "https://github.com/a/b/pull/1" } as Task;
		vi.mocked(github.findOpenPullRequest).mockResolvedValue({ pr: null, isGitHub: true });

		await expect(add()).rejects.toThrow(PR_WATCH_NO_PR_PREFIX);

		expect(persistTaskPrIdentity).not.toHaveBeenCalled();
		expect(addPrWatch).not.toHaveBeenCalled();
	});

	it("caps its gh call, and says watching is for the task's own PR", async () => {
		await add();
		expect(vi.mocked(github.findOpenPullRequest).mock.calls[0][3]).toEqual({ timeoutMs: PR_WATCH_GH_TIMEOUT_MS, force: true });
		vi.mocked(github.findOpenPullRequest).mockResolvedValue({ pr: null, isGitHub: true });
		await expect(add()).rejects.toThrow("review target is not supported");
	});

	it("forces a fresh PR lookup, so a PR opened seconds ago is not hidden by a cached \"no PR\"", async () => {
		await add();
		expect(vi.mocked(github.findOpenPullRequest).mock.calls[0][3]).toMatchObject({ force: true });
	});

	it("binds the watch to the calling agent only for the caller's own task", async () => {
		const author = { paneId: "%3", sessionId: null, paneToken: "t", agentProcess: "9@x" };
		vi.mocked(captureScheduledMessageAuthor).mockResolvedValue(author);

		await add({ sourceTaskId: "t1", sourcePaneId: "%3", sourcePid: 99 });
		expect(captureScheduledMessageAuthor).toHaveBeenCalledWith(task, "%3", 99);
		expect(vi.mocked(addPrWatch).mock.calls[0][2]).toMatchObject({ author });

		await add({ sourceTaskId: "someone-else", sourcePaneId: "%3", sourcePid: 99 });
		expect(vi.mocked(addPrWatch).mock.calls[1][2]).not.toHaveProperty("author");
	});

	it("fails with the no-PR prefix when the branch has no open PR, and stores nothing", async () => {
		vi.mocked(github.findOpenPullRequest).mockResolvedValue({ pr: null, isGitHub: true });
		await expect(add()).rejects.toThrow(PR_WATCH_NO_PR_PREFIX);
		expect(addPrWatch).not.toHaveBeenCalled();
		expect(persistTaskPrIdentity).not.toHaveBeenCalled();
	});

	it("rejects an unknown kind and a task with no worktree", async () => {
		await expect(add({ until: "review" })).rejects.toThrow("--until takes ci or merged");
		task = { ...task, worktreePath: null } as Task;
		await expect(add()).rejects.toThrow("live worktree");
	});
});

describe("pr.watch.off and pr.watch.list", () => {
	it("reports how many watches were removed", async () => {
		expect(await prWatchHandlers["pr.watch.off"]({ taskId: "t1", projectId: "p1" })).toMatchObject({ removed: 2 });
	});

	it("lists watches with a short head", async () => {
		task = { ...task, prWatches: [{ id: "w", until: "merged", prNumber: 7, headSha: HEAD, createdAt: "2026-10-22T10:00:00.000Z" }] } as Task;
		const res = (await prWatchHandlers["pr.watch.list"]({ taskId: "t1", projectId: "p1" })) as { watches: unknown[] };
		expect(res.watches).toEqual([{ until: "merged", prNumber: 7, headSha: "aaaaaaa", createdAt: "2026-10-22T10:00:00.000Z" }]);
	});
});
