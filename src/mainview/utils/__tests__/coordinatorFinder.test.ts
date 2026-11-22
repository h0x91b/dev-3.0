import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import { coordinatorCandidates, digitCoordinator, hasListedActiveTask } from "../coordinatorFinder";

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

	it("labels state and sinks no-agent then hibernated below live", () => {
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
			["t2", "no-agent"],
			["t1", "hibernated"],
		]);
	});

	it("files a coordinator whose agent exited under the same no-agent state", () => {
		const exited = task("t1", { agentExitedAt: "2026-11-13T10:00:00.000Z" });
		expect(coordinatorCandidates([exited, task("t2")], null, []).map((c) => [c.task.id, c.state])).toEqual([["t2", "live"], ["t1", "no-agent"]]);
	});

	it("orders by MRU inside a band, then newest seq", () => {
		const tasks = [task("t1"), task("t2"), task("t3")];
		expect(coordinatorCandidates(tasks, null, ["t1"]).map((c) => c.task.id)).toEqual(["t1", "t3", "t2"]);
	});
});

describe("digitCoordinator", () => {
	it("picks the first candidate among the target's projects only", () => {
		const tasks = [task("t1", { projectId: "p1" }), task("t2", { projectId: "p2", hibernated: true }), task("t3", { projectId: "p2" })];
		expect(digitCoordinator(tasks, ["p2"], null, [])?.id).toBe("t3");
	});

	it("prefers the most recently used one inside a band", () => {
		const tasks = [task("t1", { projectId: "p2" }), task("t2", { projectId: "p2" })];
		expect(digitCoordinator(tasks, ["p2"], null, ["t1", "t2"])?.id).toBe("t1");
	});

	it("spans every member project of a space", () => {
		const tasks = [task("t1", { projectId: "p3" })];
		expect(digitCoordinator(tasks, ["p2", "p3"], null, [])?.id).toBe("t1");
	});

	it("is null with no active coordinator", () => {
		const tasks = [task("t1", { projectId: "p2", status: "completed" }), task("t2", { projectId: "p2", taskType: undefined })];
		expect(digitCoordinator(tasks, ["p2"], null, [])).toBeNull();
	});
});

describe("hasListedActiveTask", () => {
	it("counts a running, visible active task on the target", () => {
		expect(hasListedActiveTask([task("t1", { projectId: "p2", taskType: undefined })], ["p2"])).toBe(true);
	});

	it("ignores hidden and hibernated tasks, which Active Tasks does not list by default", () => {
		const tasks = [task("t1", { projectId: "p2", hidden: true }), task("t2", { projectId: "p2", hibernated: true })];
		expect(hasListedActiveTask(tasks, ["p2"])).toBe(false);
	});

	it("ignores other projects and finished or to-do tasks", () => {
		const tasks = [task("t1", { projectId: "p1" }), task("t2", { projectId: "p2", status: "completed" }), task("t3", { projectId: "p2", status: "todo" })];
		expect(hasListedActiveTask(tasks, ["p2"])).toBe(false);
	});
});
