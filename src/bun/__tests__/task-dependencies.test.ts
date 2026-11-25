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

import { addDependencies, planDependencyChange, writeDependencyPlan } from "../task-dependencies";
import { launchAfterRefusal } from "../launch-after";
import { dependencyInfo, dependencyRefusal, indexDependencies, summarizeDependencies } from "../../shared/task-dependencies";

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
	it("walks a chain through blocked, ready and done, staying blocked until every dependency is done and naming the open ones", () => {
		const a = task({ id: "a", seq: 1 });
		const b = task({ id: "b", seq: 2, relations: dependsOn("a") });
		const c = task({ id: "c", seq: 3, relations: dependsOn("b") });
		const verdicts = (tasks: Task[]) => tasks.map((t) => summarizeDependencies(t, tasks).verdict);

		expect(verdicts([a, b, c])).toEqual(["none", "blocked", "blocked"]);
		const aDone = { ...a, status: "completed" as const };
		expect(verdicts([aDone, b, c])).toEqual(["none", "ready", "blocked"]);
		const bDone = { ...b, status: "completed" as const };
		expect(verdicts([aDone, bDone, c])).toEqual(["none", "ready", "ready"]);

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

	it("is satisfied by any completed variant and drops a deleted dependency", () => {
		const v1 = task({ id: "v1", seq: 1, groupId: "g", status: "cancelled" });
		const v2 = task({ id: "v2", seq: 1, groupId: "g", status: "in-progress" });
		const b = task({ id: "b", seq: 2, relations: dependsOn("v1", "gone") });
		expect(summarizeDependencies(b, [v1, v2, b]).verdict).toBe("blocked");
		const done = summarizeDependencies(b, [v1, { ...v2, status: "completed" }, b]);
		expect(done.verdict).toBe("ready");
		expect(done.dependencies.map((d) => d.state)).toEqual(["done"]);
		expect(summarizeDependencies(b, [b]).verdict).toBe("none");
	});

	it("stops blocking on a dependency cancelled in every variant, but names it cancelled, never done", () => {
		const v1 = task({ id: "v1", seq: 1, groupId: "g", status: "cancelled" });
		const v2 = task({ id: "v2", seq: 1, groupId: "g", status: "cancelled" });
		const b = task({ id: "b", seq: 2, relations: dependsOn("v1") });
		const summary = summarizeDependencies(b, [v1, v2, b]);
		expect(summary.verdict).toBe("ready");
		expect(summary.open).toEqual([]);
		expect(summary.cancelled.map((d) => d.seq)).toEqual([1]);
		expect(summary.dependencies[0].state).toBe("cancelled");
	});

	it("lists both directions for task show, resolving the same against a prebuilt index as against the board", () => {
		const tasks = [task({ id: "a", seq: 1, status: "cancelled" }), task({ id: "b", seq: 2, relations: dependsOn("a") }), task({ id: "c", seq: 3, relations: dependsOn("a", "b") })];
		const index = indexDependencies(tasks);
		for (const t of tasks) expect(dependencyInfo(t, index)).toEqual(dependencyInfo(t, tasks));
		expect(dependencyInfo(tasks[0], index)?.blocks.map((d) => d.seq)).toEqual([2, 3]);
		expect(dependencyInfo(tasks[2], index)?.dependsOn.map((d) => d.seq)).toEqual([1, 2]);
		expect(dependencyInfo(task({ id: "lonely", seq: 9 }), tasks)).toBeNull();
	});
});

describe("dependency refusals", () => {
	const a = task({ id: "a", seq: 1 });
	const b = task({ id: "b", seq: 2, relations: dependsOn("a") });
	const c = task({ id: "c", seq: 3, relations: dependsOn("b") });

	it("refuses a self-link, another board, and a cycle — including one mixing a dependency with a start-after condition, in both directions", () => {
		expect(dependencyRefusal(a, a, [a, b, c])).toMatch(/itself/);
		expect(dependencyRefusal(a, task({ id: "z", projectId: "proj-2" }), [a, b, c])).toMatch(/another board/);
		expect(dependencyRefusal(a, c, [a, b, c])).toMatch(/cycle/);
		expect(dependencyRefusal(c, a, [a, b, c])).toBeNull();

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
		const remove = async (drop: Task[] | "all") => writeDependencyPlan(project, store[2], planDependencyChange(store[2], store, { drop }));
		expect((await remove([store[0]])).relations).toEqual([...dependsOn("b"), { type: "relates-to", taskId: "a" }]);
		await expect(remove([store[0]])).rejects.toThrow("does not depend on #1");
		expect((await remove("all")).relations).toEqual([{ type: "relates-to", taskId: "a" }]);

		// The link is the start-after condition: point at --no-start-after instead.
		const waits = [task({ id: "a", seq: 1 }), task({ id: "b", seq: 2, launchAfter: { taskId: "a", seq: 1, until: "completed", armedAt: "t" } })];
		expect(() => planDependencyChange(waits[1], waits, { drop: [waits[0]] })).toThrow("--no-start-after");
	});

	it("swaps a link in one write, and writes nothing when the added half is refused", async () => {
		store = [task({ id: "a", seq: 1 }), task({ id: "b", seq: 2 }), task({ id: "c", seq: 3, relations: dependsOn("a") })];
		expect(() => planDependencyChange(store[2], store, { drop: [store[0]], add: [store[2]] })).toThrow(/itself/);
		expect(store[2].relations).toEqual(dependsOn("a"));
		const swapped = await writeDependencyPlan(project, store[2], planDependencyChange(store[2], store, { drop: [store[0]], add: [store[1]] }));
		expect(swapped.relations).toEqual(dependsOn("b"));
		expect(pushMessage).toHaveBeenCalledTimes(1);
	});
});
