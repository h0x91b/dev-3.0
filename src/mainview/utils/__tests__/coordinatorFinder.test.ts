import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import { coordinatorCandidates } from "../coordinatorFinder";

function task(id: string, over: Partial<Task> = {}): Task {
	return {
		id,
		seq: Number(id.replace(/\D/g, "")) || 1,
		projectId: "p1",
		title: `Task ${id}`,
		status: "in-progress",
		taskType: "coordinator",
		worktreePath: `/tmp/${id}`,
		...over,
	} as Task;
}

describe("coordinatorCandidates", () => {
	it("selects by taskType, never by title text", () => {
		const tasks = [
			task("t1"),
			task("t2", { taskType: undefined, title: "Coordinator of everything" }),
			task("t3", { taskType: "pr-review", title: "Review the coordinator" }),
		];
		expect(coordinatorCandidates(tasks, null, []).map((c) => c.task.id)).toEqual(["t1"]);
	});

	it("drops coordinators outside an active status", () => {
		const tasks = [task("t1"), task("t2", { status: "completed" }), task("t3", { status: "todo" })];
		expect(coordinatorCandidates(tasks, null, []).map((c) => c.task.id)).toEqual(["t1"]);
	});

	it("keeps coordinators from every project and ignores Active Tasks hiding", () => {
		const tasks = [task("t1", { projectId: "p1" }), task("t2", { projectId: "p2", hidden: true })];
		expect(coordinatorCandidates(tasks, null, []).map((c) => c.task.id).sort()).toEqual(["t1", "t2"]);
	});

	it("labels state and sinks disconnected then hibernated below live", () => {
		const tasks = [
			task("t1", { hibernated: true }),
			task("t2", { runtimeState: { runtime: "idle" } as Task["runtimeState"] }),
			task("t3"),
			task("t4"),
		];
		const result = coordinatorCandidates(tasks, "t4", []);
		expect(result.map((c) => [c.task.id, c.state])).toEqual([
			["t4", "current"],
			["t3", "live"],
			["t2", "disconnected"],
			["t1", "hibernated"],
		]);
	});

	it("orders by MRU inside a band, then newest seq", () => {
		const tasks = [task("t1"), task("t2"), task("t3")];
		expect(coordinatorCandidates(tasks, null, ["t1"]).map((c) => c.task.id)).toEqual(["t1", "t3", "t2"]);
	});
});
