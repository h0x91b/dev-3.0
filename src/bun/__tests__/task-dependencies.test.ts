import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";

let store: Task[] = [];
const pushMessage = vi.hoisted(() => vi.fn());
vi.mock("../data", () => ({
	updateTaskWith: vi.fn(async (_project: unknown, taskId: string, mutator: (t: Task) => { updates: Partial<Task>; result: unknown }) => {
		const i = store.findIndex((t) => t.id === taskId);
		const { updates, result } = await mutator(store[i]);
		store[i] = { ...store[i], ...updates };
		return { task: store[i], result };
	}),
	loadTasks: vi.fn(async () => store.map((t) => ({ ...t }))),
}));
vi.mock("../rpc-handlers/shared-pure", () => ({ getPushMessage: () => pushMessage }));

import { addDependencies, removeDependencies } from "../task-dependencies";
import { launchAfterRefusal } from "../launch-after";
import { dependencyInfo, dependencyRefusal, summarizeDependencies } from "../../shared/task-dependencies";

const project = { id: "proj-1", path: "/repo" } as never;

function task(overrides: Partial<Task> & { id: string }): Task {
	return { projectId: "proj-1", seq: 1, status: "todo", title: overrides.id, groupId: null, relations: [], ...overrides } as Task;
}
const dependsOn = (...ids: string[]) => ids.map((taskId) => ({ type: "blocked-by" as const, taskId }));

afterEach(() => {
	vi.clearAllMocks();
	store = [];
});

describe("dependency state", () => {
	it("walks a chain through blocked, ready and done as each task finishes", () => {
		const a = task({ id: "a", seq: 1 });
		const b = task({ id: "b", seq: 2, relations: dependsOn("a") });
		const c = task({ id: "c", seq: 3, relations: dependsOn("b") });
		const verdicts = (tasks: Task[]) => tasks.map((t) => summarizeDependencies(t, tasks).verdict);

		expect(verdicts([a, b, c])).toEqual(["none", "blocked", "blocked"]);
		const aDone = { ...a, status: "completed" as const };
		expect(verdicts([aDone, b, c])).toEqual(["none", "ready", "blocked"]);
		const bDone = { ...b, status: "completed" as const };
		expect(verdicts([aDone, bDone, c])).toEqual(["none", "ready", "ready"]);
	});

	it("stays blocked until every dependency is done and names the open ones", () => {
		const tasks = [
			task({ id: "a", seq: 1, status: "completed" }),
			task({ id: "b", seq: 2, status: "in-progress" }),
			task({ id: "c", seq: 3, relations: dependsOn("a", "b") }),
		];
		const summary = summarizeDependencies(tasks[2], tasks);
		expect(summary.verdict).toBe("blocked");
		expect(summary.open.map((d) => d.seq)).toEqual([2]);
	});

	it("counts a start-after prerequisite as a dependency, and ignores other relation kinds", () => {
		const tasks = [
			task({ id: "a", seq: 1 }),
			task({ id: "x", seq: 9 }),
			task({ id: "b", seq: 2, relations: [{ type: "relates-to", taskId: "x" }], launchAfter: { taskId: "a", seq: 1, until: "completed", armedAt: "t" } }),
		];
		expect(summarizeDependencies(tasks[2], tasks).open.map((d) => d.seq)).toEqual([1]);
	});

	it("is satisfied by any completed variant, drops a deleted dependency, and frees a cancelled one", () => {
		const v1 = task({ id: "v1", seq: 1, groupId: "g", status: "cancelled" });
		const v2 = task({ id: "v2", seq: 1, groupId: "g", status: "in-progress" });
		const b = task({ id: "b", seq: 2, relations: dependsOn("v1", "gone") });
		expect(summarizeDependencies(b, [v1, v2, b]).verdict).toBe("blocked");
		expect(summarizeDependencies(b, [v1, { ...v2, status: "completed" }, b]).verdict).toBe("ready");
		expect(summarizeDependencies(b, [v1, { ...v2, status: "cancelled" }, b]).verdict).toBe("ready");
		expect(summarizeDependencies(b, [b]).verdict).toBe("none");
	});

	it("lists both directions for task show", () => {
		const tasks = [task({ id: "a", seq: 1 }), task({ id: "b", seq: 2, relations: dependsOn("a") }), task({ id: "c", seq: 3 })];
		expect(dependencyInfo(tasks[0], tasks)?.blocks.map((d) => d.seq)).toEqual([2]);
		expect(dependencyInfo(tasks[1], tasks)?.dependsOn.map((d) => d.seq)).toEqual([1]);
		expect(dependencyInfo(tasks[2], tasks)).toBeNull();
	});
});

describe("dependency refusals", () => {
	const a = task({ id: "a", seq: 1 });
	const b = task({ id: "b", seq: 2, relations: dependsOn("a") });
	const c = task({ id: "c", seq: 3, relations: dependsOn("b") });

	it("refuses a self-link, another board and a cycle through other tasks", () => {
		expect(dependencyRefusal(a, a, [a, b, c])).toMatch(/itself/);
		expect(dependencyRefusal(a, task({ id: "z", projectId: "proj-2" }), [a, b, c])).toMatch(/another board/);
		expect(dependencyRefusal(a, c, [a, b, c])).toMatch(/cycle/);
		expect(dependencyRefusal(c, a, [a, b, c])).toBeNull();
	});

	it("sees a cycle that mixes a dependency with a start-after condition, in both directions", () => {
		const waits = task({ id: "w", seq: 4, launchAfter: { taskId: "c", seq: 3, until: "completed", armedAt: "t" } });
		const board = [a, b, c, waits];
		expect(dependencyRefusal(a, waits, board)).toMatch(/cycle/);
		expect(launchAfterRefusal(a, c, "completed", board)).toMatch(/already waits/);
	});
});

describe("writing dependencies", () => {
	it("adds links once, keeps other relations, and pushes the task", async () => {
		store = [task({ id: "a", seq: 1 }), task({ id: "b", seq: 2 }), task({ id: "c", seq: 3, relations: [{ type: "relates-to", taskId: "a" }] })];
		await addDependencies(project, store[2], [store[0], store[1]]);
		const updated = await addDependencies(project, store[2], [store[0]]);
		expect(updated.relations).toEqual([{ type: "relates-to", taskId: "a" }, ...dependsOn("a", "b")]);
		expect(pushMessage).toHaveBeenCalledWith("taskUpdated", { projectId: "proj-1", task: updated });
	});

	it("writes nothing when one of several links is refused", async () => {
		store = [task({ id: "a", seq: 1, relations: dependsOn("c") }), task({ id: "b", seq: 2 }), task({ id: "c", seq: 3 })];
		await expect(addDependencies(project, store[2], [store[1], store[0]])).rejects.toThrow(/cycle/);
		expect(store[2].relations).toEqual([]);
	});

	it("removes named links or all of them, and says when there is nothing to remove", async () => {
		store = [task({ id: "a", seq: 1 }), task({ id: "b", seq: 2 }), task({ id: "c", seq: 3, relations: [...dependsOn("a", "b"), { type: "relates-to", taskId: "a" }] })];
		expect((await removeDependencies(project, store[2], [store[0]])).relations).toEqual([...dependsOn("b"), { type: "relates-to", taskId: "a" }]);
		await expect(removeDependencies(project, store[2], [store[0]])).rejects.toThrow("does not depend on #1");
		expect((await removeDependencies(project, store[2], "all")).relations).toEqual([{ type: "relates-to", taskId: "a" }]);
	});

	it("points at --no-start-after when the link is the start-after condition", async () => {
		store = [task({ id: "a", seq: 1 }), task({ id: "b", seq: 2, launchAfter: { taskId: "a", seq: 1, until: "completed", armedAt: "t" } })];
		await expect(removeDependencies(project, store[1], [store[0]])).rejects.toThrow("--no-start-after");
	});
});
