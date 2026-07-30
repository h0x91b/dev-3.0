import { partitionTasksByStatus } from "../partitionTasks";
import { ALL_STATUSES, type Task, type TaskStatus } from "../../../shared/types";

function task(id: string, status: string, customColumnId: string | null = null): Task {
	return { id, status, customColumnId } as unknown as Task;
}

const noCustomColumns = () => false;

describe("partitionTasksByStatus", () => {
	it("creates a bucket for every built-in status, even when empty", () => {
		const byStatus = partitionTasksByStatus([], noCustomColumns);
		expect([...byStatus.keys()]).toEqual(ALL_STATUSES);
		expect([...byStatus.values()].every((tasks) => tasks.length === 0)).toBe(true);
	});

	it("buckets tasks by their own status, preserving input order", () => {
		const byStatus = partitionTasksByStatus(
			[task("a", "todo"), task("b", "completed"), task("c", "todo")],
			noCustomColumns,
		);
		expect(byStatus.get("todo")!.map((t) => t.id)).toEqual(["a", "c"]);
		expect(byStatus.get("completed")!.map((t) => t.id)).toEqual(["b"]);
	});

	it("skips tasks that live in a custom column", () => {
		const byStatus = partitionTasksByStatus(
			[task("a", "todo"), task("b", "todo", "deploy")],
			(t) => t.customColumnId === "deploy",
		);
		expect(byStatus.get("todo")!.map((t) => t.id)).toEqual(["a"]);
	});

	// A dropped card is invisible on the board while still sitting in tasks.json and
	// answering to the CLI — and a restart does not bring it back. Land it in To Do
	// instead, where the user can at least see and move it.
	it("puts a task with an unrecognized status into To Do instead of dropping it", () => {
		const byStatus = partitionTasksByStatus([task("ghost", "archived-by-future-version")], noCustomColumns);
		expect(byStatus.get("todo")!.map((t) => t.id)).toEqual(["ghost"]);
	});

	it("loses no task, whatever the status", () => {
		const tasks = [
			...ALL_STATUSES.map((s: TaskStatus, i) => task(`ok-${i}`, s)),
			task("weird", ""),
			task("weirder", "not-a-status"),
		];
		const total = [...partitionTasksByStatus(tasks, noCustomColumns).values()].reduce((n, list) => n + list.length, 0);
		expect(total).toBe(tasks.length);
	});
});
