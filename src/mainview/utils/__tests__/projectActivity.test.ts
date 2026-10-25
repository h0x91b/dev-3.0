import { orderByRecentActivity, projectLastActivityMs, taskLastActivityMs } from "../projectActivity";
import { FOCUS_HOUR_MS, type Task } from "../../../shared/types";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function task(over: Partial<Task>): Task {
	return { id: "t", status: "todo", createdAt: iso(T0), updatedAt: iso(T0), ...over } as Task;
}

describe("taskLastActivityMs", () => {
	it("counts creation", () => {
		expect(taskLastActivityMs(task({}))).toBe(T0);
	});

	it("counts a (re)start of the delivery cycle", () => {
		expect(taskLastActivityMs(task({ status: "in-progress", lifecycleStartedAt: iso(T0 + 3 * DAY) }))).toBe(T0 + 3 * DAY);
	});

	it("counts the completion move of a finished task", () => {
		expect(taskLastActivityMs(task({ status: "completed", movedAt: iso(T0 + 5 * DAY) }))).toBe(T0 + 5 * DAY);
		expect(taskLastActivityMs(task({ status: "cancelled", movedAt: iso(T0 + 6 * DAY) }))).toBe(T0 + 6 * DAY);
	});

	// A broadcast message wakes a forgotten agent; its Stop hook moves the card.
	it("ignores hook-driven moves of a live task and updatedAt churn", () => {
		const woken = task({
			status: "review-by-user",
			lifecycleStartedAt: iso(T0),
			movedAt: iso(T0 + 20 * DAY),
			updatedAt: iso(T0 + 21 * DAY),
		});
		expect(taskLastActivityMs(woken)).toBe(T0);
	});

	it("counts an hour the user really spent on the task, not a glance", () => {
		const hour = Math.floor((T0 + 9 * DAY) / FOCUS_HOUR_MS);
		const glanceHour = hour + 24;
		const t = task({ status: "review-by-user", focusByHour: { [hour]: 5 * 60_000, [glanceHour]: 10_000 } });
		expect(taskLastActivityMs(t)).toBe(hour * FOCUS_HOUR_MS);
	});

	it("survives malformed timestamps", () => {
		expect(taskLastActivityMs(task({ createdAt: "garbage" }))).toBe(0);
	});
});

describe("projectLastActivityMs", () => {
	it("is the latest task's activity, 0 for a project with no tasks", () => {
		expect(projectLastActivityMs([])).toBe(0);
		expect(projectLastActivityMs([task({}), task({ createdAt: iso(T0 + DAY) })])).toBe(T0 + DAY);
	});
});

describe("orderByRecentActivity", () => {
	const p = (id: string) => ({ id });

	it("puts the most recent first, keeps ties and never-active projects in incoming order", () => {
		const projects = [p("never-a"), p("old"), p("tie-1"), p("never-b"), p("new"), p("tie-2")];
		const activity = { old: T0, "tie-1": T0 + DAY, "tie-2": T0 + DAY, new: T0 + 2 * DAY, "never-a": 0 };
		expect(orderByRecentActivity(projects, activity).map((x) => x.id)).toEqual([
			"new", "tie-1", "tie-2", "old", "never-a", "never-b",
		]);
	});

	it("leaves the order alone without data and never mutates its input", () => {
		const projects = [p("b"), p("a")];
		expect(orderByRecentActivity(projects, {}).map((x) => x.id)).toEqual(["b", "a"]);
		orderByRecentActivity(projects, { a: 1 });
		expect(projects.map((x) => x.id)).toEqual(["b", "a"]);
	});
});
