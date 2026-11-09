import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchAfter, Task } from "../../shared/types";

// An in-memory tasks file: `updateTaskWith` applies the mutator the way the real
// locked read-modify-write does, so "fires exactly once" is tested for real.
let store: Task[] = [];
vi.mock("../data", () => ({
	updateTaskWith: vi.fn(async (_project: unknown, taskId: string, mutator: (t: Task) => { updates: Partial<Task>; result: unknown }) => {
		const i = store.findIndex((t) => t.id === taskId);
		const { updates, result } = await mutator(store[i]);
		store[i] = { ...store[i], ...updates };
		return { task: store[i], result };
	}),
	updateTask: vi.fn(async (_project: unknown, taskId: string, updates: Partial<Task>) => {
		const i = store.findIndex((t) => t.id === taskId);
		store[i] = { ...store[i], ...updates };
		return store[i];
	}),
	getTask: vi.fn(async (_project: unknown, taskId: string) => store.find((t) => t.id === taskId)),
	loadTasks: vi.fn(async () => store.map((t) => ({ ...t }))),
}));
const { moveTask, launchTaskWithAgentChoice, requestAgentLaunchApproval, pushMessage, pushCliAttention, getPullRequestSnapshot, resolveTaskAcrossProjects } = vi.hoisted(() => ({
	moveTask: vi.fn(async (_params: unknown): Promise<unknown> => undefined),
	launchTaskWithAgentChoice: vi.fn(async (_params: unknown): Promise<unknown> => []),
	requestAgentLaunchApproval: vi.fn(async (_params: unknown): Promise<unknown> => ({ approved: true })),
	pushMessage: vi.fn(),
	pushCliAttention: vi.fn(),
	getPullRequestSnapshot: vi.fn(),
	resolveTaskAcrossProjects: vi.fn(async (_id: string): Promise<unknown> => null),
}));
vi.mock("../rpc-handlers/task-lifecycle", () => ({ moveTask, launchTaskWithAgentChoice }));
vi.mock("../cli-socket/approvals", () => ({ requestAgentLaunchApproval }));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: () => pushMessage }));
vi.mock("../rpc-handlers/shared", () => ({ pushCliAttention }));
vi.mock("../github-pr-status", () => ({ getPullRequestSnapshot }));
vi.mock("../cli-socket/task-resolution", () => ({ resolveTaskAcrossProjects }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { _resetLaunchAfterState, _settleLaunchAfterProbes, armLaunchAfter, clearLaunchAfter, startLaunchAfterNow, evaluateLaunchAfter, LAUNCH_AFTER_PROBE_CONCURRENCY, LAUNCH_AFTER_PROBE_INTERVAL_MS, launchAfterRefusal, prerequisiteMembers, prerequisiteRefusal, tickLaunchAfter } from "../launch-after";

const project = { id: "proj-1", path: "/repo" } as never;

function task(overrides: Partial<Task> & { id: string }): Task {
	return { projectId: "proj-1", seq: 1, status: "todo", ...overrides } as Task;
}

function cond(overrides: Partial<LaunchAfter> = {}): LaunchAfter {
	return { taskId: "a", seq: 1, until: "completed", armedAt: "2026-11-04T10:00:00.000Z", ...overrides };
}

async function tick(now = Date.now()) {
	await tickLaunchAfter(project, store.map((t) => ({ ...t })), now);
	await _settleLaunchAfterProbes();
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
	_resetLaunchAfterState();
});

afterEach(() => {
	vi.clearAllMocks();
	store = [];
});

describe("start-after tick", () => {
	it("launches once when the prerequisite completes, and never again", async () => {
		store = [task({ id: "a", status: "in-progress" }), task({ id: "b", seq: 2, launchAfter: cond() })];
		await tick();
		expect(moveTask).not.toHaveBeenCalled();

		store[0] = { ...store[0], status: "completed" };
		await tick();
		await tick();
		expect(moveTask).toHaveBeenCalledTimes(1);
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "b", newStatus: "in-progress", explicitLaunch: true }));
		expect(store[1].launchAfter).toBeNull();
	});

	it("fires on the first tick after a restart when the prerequisite completed while the app was down", async () => {
		// Nothing is held in memory: the condition and the completed prerequisite are both on disk.
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond() })];
		await tick();
		expect(moveTask).toHaveBeenCalledTimes(1);
	});

	it("never launches after a cancelled prerequisite, and lights attention with the reason", async () => {
		store = [task({ id: "a", status: "cancelled" }), task({ id: "b", seq: 2, launchAfter: cond() })];
		await tick();
		await tick();
		expect(moveTask).not.toHaveBeenCalled();
		expect(store[1].launchAfter).toBeNull();
		expect(store[1].preparationError).toBe("Did not start: task #1, which this task waited for, was cancelled.");
		expect(pushCliAttention).toHaveBeenCalledTimes(1);
		expect(pushCliAttention).toHaveBeenCalledWith(expect.objectContaining({ taskId: "b", reason: store[1].preparationError }));
	});

	it("never launches after a deleted prerequisite", async () => {
		store = [task({ id: "b", seq: 2, launchAfter: cond() })];
		await tick();
		expect(moveTask).not.toHaveBeenCalled();
		expect(store[0].preparationError).toMatch(/no longer exists/);
	});

	it("routes an agent-armed condition through the launch approval dialog, with its agent preselected", async () => {
		const armedBy = { taskId: "c", seq: 9, title: "Coordinator" };
		const variant = { agentId: "claude", configId: "opus" };
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond({ armedBy, variant }) })];
		await tick();
		expect(moveTask).not.toHaveBeenCalled();
		expect(requestAgentLaunchApproval).toHaveBeenCalledWith(expect.objectContaining({ requester: armedBy, suggested: variant, targetStatus: "in-progress" }));
	});

	it("launches a person-armed condition with its chosen agent", async () => {
		const variant = { agentId: "codex", configId: null };
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond({ variant }) })];
		await tick();
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({ taskId: "b", choice: { variants: [variant] } }));
	});

	it("drops a condition left on a task that was started another way", async () => {
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, status: "in-progress", launchAfter: cond() })];
		await tick();
		expect(moveTask).not.toHaveBeenCalled();
		expect(store[1].launchAfter).toBeNull();
	});

	it("does not fire a condition that was re-armed after the tick read it", async () => {
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond() })];
		const snapshot = store.map((t) => ({ ...t }));
		store[1] = { ...store[1], launchAfter: cond({ armedAt: "2026-11-04T11:00:00.000Z", taskId: "x" }) };
		await tickLaunchAfter(project, snapshot);
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("records a failure when the approval dialog cannot be shown", async () => {
		requestAgentLaunchApproval.mockRejectedValueOnce(new Error("No app window is connected"));
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond({ armedBy: { taskId: "c", seq: 9 } }) })];
		await tick();
		// The dialog is not awaited by the tick, so its failure lands a moment later.
		await vi.waitFor(() => expect(pushCliAttention).toHaveBeenCalledTimes(1));
		expect(store[1].preparationError).toMatch(/No app window/);
	});

	it("leaves a declined start in To Do and never asks again", async () => {
		requestAgentLaunchApproval.mockResolvedValue({ approved: false });
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond({ armedBy: { taskId: "c", seq: 9 } }) })];
		await tick();
		await tick();
		expect(requestAgentLaunchApproval).toHaveBeenCalledTimes(1);
		expect(moveTask).not.toHaveBeenCalled();
		expect(store[1]).toMatchObject({ status: "todo", launchAfter: null });
		expect(store[1].preparationError).toBeUndefined();
	});

	it("records a failed launch on the card and lights attention", async () => {
		moveTask.mockRejectedValueOnce(new Error("agent missing"));
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond() })];
		await tick();
		expect(store[1].preparationError).toMatch(/agent missing/);
		expect(pushCliAttention).toHaveBeenCalledTimes(1);
	});
});

describe("start-after until merged", () => {
	const merged = { prNumber: 7, prStatusCache: { number: 7, mergeState: { state: "MERGED" } } } as Partial<Task>;

	it("waits while the PR is open, then fires when the poller records the merge", async () => {
		store = [
			task({ id: "a", status: "review-by-user", prNumber: 7, prStatusCache: { number: 7, mergeState: { state: "OPEN" } } as never }),
			task({ id: "b", seq: 2, launchAfter: cond({ until: "merged" }) }),
		];
		await tick();
		expect(moveTask).not.toHaveBeenCalled();
		store[0] = { ...store[0], ...merged };
		await tick();
		expect(moveTask).toHaveBeenCalledTimes(1);
		expect(getPullRequestSnapshot).not.toHaveBeenCalled();
	});

	it("does not fire on completion alone", async () => {
		expect(evaluateLaunchAfter(cond({ until: "merged" }), [task({ id: "a", status: "in-progress", prNumber: 7 })])).toEqual({ kind: "wait" });
	});

	it("asks GitHub at most once per interval for a completed task whose merge was never seen", async () => {
		getPullRequestSnapshot.mockResolvedValue({ state: "OPEN" });
		store = [task({ id: "a", status: "completed", prNumber: 7 }), task({ id: "b", seq: 2, launchAfter: cond({ until: "merged" }) })];
		const t0 = 1_000_000;
		await tick(t0);
		await tick(t0 + 30_000);
		expect(getPullRequestSnapshot).toHaveBeenCalledTimes(1);
		getPullRequestSnapshot.mockResolvedValue({ state: "MERGED" });
		await tick(t0 + LAUNCH_AFTER_PROBE_INTERVAL_MS);
		expect(getPullRequestSnapshot).toHaveBeenCalledTimes(2);
		expect(moveTask).toHaveBeenCalledTimes(1);
	});

	it("keeps waiting when GitHub cannot be reached, and asks again after the interval", async () => {
		getPullRequestSnapshot.mockResolvedValue(null);
		store = [task({ id: "a", status: "completed", prNumber: 7 }), task({ id: "b", seq: 2, launchAfter: cond({ until: "merged" }) })];
		const t0 = 1_000_000;
		await tick(t0);
		expect(store[1].launchAfter).not.toBeNull();
		expect(store[1].preparationError).toBeUndefined();
		await tick(t0 + LAUNCH_AFTER_PROBE_INTERVAL_MS);
		expect(getPullRequestSnapshot).toHaveBeenCalledTimes(2);
		expect(moveTask).not.toHaveBeenCalled();
	});

	it("probes a re-armed condition at once instead of inheriting the old wait", async () => {
		getPullRequestSnapshot.mockResolvedValue({ state: "OPEN" });
		store = [task({ id: "a", status: "completed", prNumber: 7 }), task({ id: "b", seq: 2, launchAfter: cond({ until: "merged" }) })];
		await tick(1_000_000);
		store[1] = { ...store[1], launchAfter: cond({ until: "merged", armedAt: "2026-11-04T12:00:00.000Z" }) };
		await tick(1_030_000);
		expect(getPullRequestSnapshot).toHaveBeenCalledTimes(2);
	});

	it("a failing probe does not hold up the other waiting tasks", async () => {
		getPullRequestSnapshot.mockRejectedValue(new Error("network down"));
		store = [
			task({ id: "a", status: "completed", prNumber: 7 }),
			task({ id: "b", seq: 2, launchAfter: cond({ until: "merged" }) }),
			task({ id: "c", seq: 3, launchAfter: cond() }),
		];
		await tick();
		expect(moveTask).toHaveBeenCalledTimes(1);
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "c" }));
		expect(store[1].launchAfter).not.toBeNull();
	});

	it("gives up when the completed task's PR was closed without merging", async () => {
		getPullRequestSnapshot.mockResolvedValue({ state: "CLOSED" });
		store = [task({ id: "a", status: "completed", prNumber: 7 }), task({ id: "b", seq: 2, launchAfter: cond({ until: "merged" }) })];
		await tick();
		expect(moveTask).not.toHaveBeenCalled();
		expect(store[1].preparationError).toBe("Did not start: the pull request of task #1 was closed without merging.");
	});

	it("gives up when the task completed without any PR", async () => {
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond({ until: "merged" }) })];
		await tick();
		expect(moveTask).not.toHaveBeenCalled();
		expect(store[1].preparationError).toMatch(/completed without a pull request/);
	});
});

describe("launchAfterRefusal", () => {
	const a = task({ id: "a", status: "in-progress" });
	const b = task({ id: "b", seq: 2 });

	it("accepts a To Do task waiting on a live one", () => {
		expect(launchAfterRefusal(b, a, "completed", [a, b])).toBeNull();
	});

	it("refuses a self-reference", () => {
		expect(launchAfterRefusal(b, b, "completed", [a, b])).toMatch(/itself/);
	});

	it("refuses a direct cycle", () => {
		const aWaits = task({ id: "a", status: "todo", launchAfter: cond({ taskId: "b", seq: 2 }) });
		expect(launchAfterRefusal(b, aWaits, "completed", [aWaits, b])).toMatch(/never start/);
	});

	it("refuses a longer cycle", () => {
		const c = task({ id: "c", seq: 3, launchAfter: cond({ taskId: "b", seq: 2 }) });
		const aWaits = task({ id: "a", status: "todo", launchAfter: cond({ taskId: "c", seq: 3 }) });
		expect(launchAfterRefusal(b, aWaits, "completed", [aWaits, b, c])).toMatch(/never start/);
	});

	it("refuses a cancelled prerequisite, a non-todo task, a draft and a Start-in task", () => {
		expect(launchAfterRefusal(b, task({ id: "a", status: "cancelled" }), "completed", [])).toMatch(/cancelled/);
		expect(launchAfterRefusal(task({ id: "b", status: "in-progress" }), a, "completed", [])).toMatch(/To Do/);
		expect(launchAfterRefusal(task({ id: "b", draft: true }), a, "completed", [])).toMatch(/draft/);
		expect(launchAfterRefusal(task({ id: "b", scheduledLaunch: { at: "x" } as never }), a, "completed", [])).toMatch(/Start in/);
	});

	it("refuses a prerequisite that is already completed, with or without a PR", () => {
		for (const until of ["completed", "merged"] as const) {
			expect(launchAfterRefusal(b, task({ id: "a", status: "completed" }), until, [])).toMatch(/already completed/);
			expect(launchAfterRefusal(b, task({ id: "a", status: "completed", prNumber: 7 }), until, [])).toMatch(/already completed/);
		}
	});

	it("refuses waiting for a merge that has already happened, even on an open task", () => {
		const merged = task({ id: "a", status: "review-by-user", prNumber: 7, prStatusCache: { number: 7, mergeState: { state: "MERGED" } } as never });
		expect(launchAfterRefusal(b, merged, "merged", [])).toMatch(/already merged/);
		expect(launchAfterRefusal(b, merged, "completed", [])).toBeNull();
	});
});

describe("start-after review fixes", () => {
	it("does not start a task the user started by hand between the tick's read and the claim", async () => {
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond() })];
		const snapshot = store.map((t) => ({ ...t }));
		store[1] = { ...store[1], status: "in-progress" };
		await tickLaunchAfter(project, snapshot);
		expect(moveTask).not.toHaveBeenCalled();
		expect(pushCliAttention).not.toHaveBeenCalled();
		expect(store[1].preparationError).toBeUndefined();
		expect(store[1].launchAfter).toBeNull();
	});

	it("tells the new agent to report back only while the arming task is still running", async () => {
		const armedBy = { taskId: "c", seq: 9 };
		resolveTaskAcrossProjects.mockResolvedValueOnce({ task: task({ id: "c", status: "completed" }) });
		store = [task({ id: "a", status: "completed" }), task({ id: "b", seq: 2, launchAfter: cond({ armedBy }) })];
		await tick();
		expect(requestAgentLaunchApproval).toHaveBeenLastCalledWith(expect.objectContaining({ requester: armedBy, handoff: false }));

		resolveTaskAcrossProjects.mockResolvedValueOnce({ task: task({ id: "c", status: "in-progress" }) });
		store = [task({ id: "a", status: "completed" }), task({ id: "d", seq: 3, launchAfter: cond({ armedBy }) })];
		await tick();
		expect(requestAgentLaunchApproval).toHaveBeenLastCalledWith(expect.objectContaining({ requester: armedBy, handoff: true }));
	});

	it("does not wait on GitHub probes, and runs them in parallel with a bound", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let running = 0;
		let peak = 0;
		getPullRequestSnapshot.mockImplementation(async () => {
			running++;
			peak = Math.max(peak, running);
			await gate;
			running--;
			return { state: "MERGED" };
		});
		const waiting = Array.from({ length: LAUNCH_AFTER_PROBE_CONCURRENCY + 3 }, (_, i) =>
			task({ id: `w${i}`, seq: 10 + i, launchAfter: cond({ until: "merged" }) }));
		store = [task({ id: "a", status: "completed", prNumber: 7 }), ...waiting];
		// The tick returns while every probe is still blocked on GitHub.
		await tickLaunchAfter(project, store.map((t) => ({ ...t })));
		await vi.waitFor(() => expect(peak).toBe(LAUNCH_AFTER_PROBE_CONCURRENCY));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(peak).toBe(LAUNCH_AFTER_PROBE_CONCURRENCY);
		expect(moveTask).not.toHaveBeenCalled();
		// A tick while they run does not start a second probe for the same task.
		await tickLaunchAfter(project, store.map((t) => ({ ...t })), Date.now() + LAUNCH_AFTER_PROBE_INTERVAL_MS);
		release();
		await _settleLaunchAfterProbes();
		expect(getPullRequestSnapshot).toHaveBeenCalledTimes(waiting.length);
		expect(moveTask).toHaveBeenCalledTimes(waiting.length);
		getPullRequestSnapshot.mockReset();
	});

	it("waits on an open PR whose number is not recorded yet, then probes it once the task completes", async () => {
		const openRecord = { pullRequests: [{ number: 7, url: "u", state: "OPEN", firstSeenAt: "x" }] } as Partial<Task>;
		store = [task({ id: "a", status: "review-by-user", ...openRecord }), task({ id: "b", seq: 2, launchAfter: cond({ until: "merged" }) })];
		await tick();
		expect(getPullRequestSnapshot).not.toHaveBeenCalled();
		expect(store[1].launchAfter).not.toBeNull();

		getPullRequestSnapshot.mockResolvedValue({ state: "MERGED" });
		store[0] = { ...store[0], status: "completed" };
		await tick();
		expect(getPullRequestSnapshot).toHaveBeenCalledWith(project, "/repo", 7);
		expect(moveTask).toHaveBeenCalledTimes(1);
		getPullRequestSnapshot.mockReset();
	});
});

describe("start-after with variants", () => {
	const v1 = (o: Partial<Task> = {}) => task({ id: "a", seq: 1, groupId: "g", variantIndex: 1, ...o });
	const v2 = (o: Partial<Task> = {}) => task({ id: "a2", seq: 1, groupId: "g", variantIndex: 2, ...o });

	it("fires when v2's PR merged although v1 was cancelled", async () => {
		store = [v1({ status: "cancelled" }), v2({ status: "completed", prNumber: 8, prStatusCache: { number: 8, mergeState: { state: "MERGED" } } as never }), task({ id: "b", seq: 2, launchAfter: cond({ until: "merged" }) })];
		await tick();
		expect(moveTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "b" }));
	});

	it("keeps waiting while another variant still runs", () => {
		const members = [v1({ status: "cancelled" }), v2({ status: "in-progress" })];
		expect(evaluateLaunchAfter(cond(), members)).toEqual({ kind: "wait" });
		expect(evaluateLaunchAfter(cond({ until: "merged" }), members)).toEqual({ kind: "wait" });
	});

	it("fires on completion of any variant, and abandons only when every one is cancelled", () => {
		expect(evaluateLaunchAfter(cond(), [v1({ status: "cancelled" }), v2({ status: "completed" })])).toEqual({ kind: "fire" });
		expect(evaluateLaunchAfter(cond(), [v1({ status: "cancelled" }), v2({ status: "cancelled" })])).toEqual({ kind: "abandon", reason: "cancelled" });
	});

	it("probes every completed variant's PR", () => {
		expect(evaluateLaunchAfter(cond({ until: "merged" }), [v1({ status: "completed", prNumber: 7 }), v2({ status: "completed", prNumber: 8 })]))
			.toEqual({ kind: "probe", prNumbers: [7, 8] });
	});

	it("finds the siblings by seq when the source variant was deleted", () => {
		const others = [v2({ status: "completed" }), task({ id: "z", seq: 1 })];
		expect(prerequisiteMembers(cond(), others).map((t) => t.id)).toEqual(["a2"]);
	});

	it("does not refuse waiting on a cancelled v1 while v2 still runs", () => {
		const board = [v1({ status: "cancelled" }), v2({ status: "in-progress" })];
		expect(prerequisiteRefusal(board[0]!, "completed", board)).toBeNull();
		expect(prerequisiteRefusal(board[0]!, "completed", [v1({ status: "cancelled" }), v2({ status: "cancelled" })])).toMatch(/cancelled/);
	});

	it("judges an already-finished prerequisite by the whole variant group", () => {
		const oneDone = [v1({ status: "completed", prNumber: 7 }), v2({ status: "in-progress" })];
		expect(prerequisiteRefusal(oneDone[1]!, "completed", oneDone)).toMatch(/already completed/);
		expect(prerequisiteRefusal(oneDone[1]!, "merged", oneDone)).toBeNull();
		const allDone = [v1({ status: "completed", prNumber: 7 }), v2({ status: "cancelled" })];
		expect(prerequisiteRefusal(allDone[0]!, "merged", allDone)).toMatch(/already completed/);
	});
});

describe("board actions", () => {
	it("arms a condition as a person, clearing an earlier abandon reason", async () => {
		store = [task({ id: "a", status: "in-progress" }), task({ id: "b", seq: 2, preparationError: "Did not start: x" })];
		const variant = { agentId: "codex", configId: null };
		const updated = await armLaunchAfter(project, store[1]!, store[0]!, "merged", variant, null);
		expect(updated.launchAfter).toMatchObject({ taskId: "a", seq: 1, until: "merged", variant });
		expect(updated.launchAfter?.armedBy).toBeUndefined();
		expect(updated.preparationError).toBeNull();
		expect(pushMessage).toHaveBeenCalledWith("taskUpdated", expect.objectContaining({ task: updated }));
	});

	it("refuses an arm that could never start, writing nothing", async () => {
		store = [task({ id: "a", status: "cancelled" }), task({ id: "b", seq: 2 })];
		await expect(armLaunchAfter(project, store[1]!, store[0]!, "completed", null, null)).rejects.toThrow(/cancelled/);
		expect(store[1]!.launchAfter).toBeUndefined();
	});

	it("removes a condition", async () => {
		store = [task({ id: "b", seq: 2, launchAfter: cond() })];
		expect((await clearLaunchAfter(project, store[0]!)).launchAfter).toBeNull();
	});

	it("starts now with the condition's agent, without the approval dialog even when an agent armed it", async () => {
		const variant = { agentId: "codex", configId: null };
		store = [task({ id: "a", status: "in-progress" }), task({ id: "b", seq: 2, launchAfter: cond({ variant, armedBy: { taskId: "c", seq: 9 } }) })];
		await startLaunchAfterNow(project, store[1]!);
		expect(requestAgentLaunchApproval).not.toHaveBeenCalled();
		expect(launchTaskWithAgentChoice).toHaveBeenCalledWith(expect.objectContaining({ taskId: "b", choice: { variants: [variant] } }));
		expect(store[1]!.launchAfter).toBeNull();
	});

	it("refuses start now on a task that already left To Do", async () => {
		store = [task({ id: "b", seq: 2, status: "in-progress", launchAfter: cond() })];
		await expect(startLaunchAfterNow(project, { ...store[0]!, status: "todo" })).rejects.toThrow(/no longer waiting/);
		expect(moveTask).not.toHaveBeenCalled();
	});
});
