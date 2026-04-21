import {
	buildQuickSwitchOpenTaskRoute,
	buildTasksQuickSwitchItems,
	getActiveQuickSwitchRouteTaskId,
	getInitialTasksQuickSwitchIndex,
	getQuickSwitchDirection,
	moveTasksQuickSwitchSelection,
	syncTasksQuickSwitchProjectTasks,
} from "../tasks-quick-switch";
import {
	makeTasksQuickSwitchCustomFilter,
	type Project,
	type Task,
} from "../../shared/types";
import type { Route } from "../state";

const projectAlpha: Project = {
	id: "p1",
	name: "Alpha",
	path: "/alpha",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2026-04-15T10:00:00.000Z",
};

const projectBeta: Project = {
	...projectAlpha,
	id: "p2",
	name: "Beta",
	path: "/beta",
	customColumns: [
		{
			id: "col-waiting",
			name: "Waiting on API",
			color: "#22c55e",
			llmInstruction: "",
		},
	],
};

function makeTask(overrides: Partial<Task>): Task {
	return {
		id: "t1",
		seq: 1,
		projectId: "p1",
		title: "Task",
		description: "Task",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: "/tmp/worktree",
		branchName: "feat/test",
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-04-15T10:00:00.000Z",
		updatedAt: "2026-04-15T10:00:00.000Z",
		...overrides,
	};
}

describe("tasks quick switch helpers", () => {
	it("prioritizes recently visited task ids over timestamps", () => {
		const items = buildTasksQuickSwitchItems({
			projects: [projectAlpha, projectBeta],
			recentTaskIds: ["t2", "t1"],
			allowedFilters: ["in-progress", "review-by-user"],
			tasksByProject: new Map([
				[
					"p1",
					[
						makeTask({
							id: "t1",
							title: "Alpha Task",
							updatedAt: "2026-04-15T10:10:00.000Z",
						}),
					],
				],
				[
					"p2",
					[
						makeTask({
							id: "t2",
							projectId: "p2",
							title: "Beta Task",
							updatedAt: "2026-04-15T10:05:00.000Z",
						}),
					],
				],
			]),
		});

		expect(items.map((item) => item.taskId)).toEqual(["t2", "t1"]);
	});

	it("falls back to most recently updated tasks when visit history is empty", () => {
		const items = buildTasksQuickSwitchItems({
			projects: [projectAlpha],
			recentTaskIds: [],
			allowedFilters: ["in-progress", "review-by-user"],
			tasksByProject: new Map([
				[
					"p1",
					[
						makeTask({
							id: "older",
							title: "Older",
							updatedAt: "2026-04-15T10:05:00.000Z",
						}),
						makeTask({
							id: "newer",
							title: "Newer",
							updatedAt: "2026-04-15T10:15:00.000Z",
						}),
					],
				],
			]),
		});

		expect(items.map((item) => item.taskId)).toEqual(["newer", "older"]);
	});

	it("filters custom-column tasks by custom column id instead of underlying status", () => {
		const items = buildTasksQuickSwitchItems({
			projects: [projectBeta],
			recentTaskIds: [],
			allowedFilters: [makeTasksQuickSwitchCustomFilter("col-waiting")],
			tasksByProject: new Map([
				[
					"p2",
					[
						makeTask({
							id: "waiting",
							projectId: "p2",
							title: "Waiting",
							customColumnId: "col-waiting",
						}),
						makeTask({
							id: "plain",
							projectId: "p2",
							title: "Plain",
						}),
					],
				],
			]),
		});

		expect(items).toEqual([
			expect.objectContaining({
				taskId: "waiting",
				customColumnName: "Waiting on API",
				customColumnColor: "#22c55e",
			}),
		]);
	});

	it("starts on the next task when the current task is already in the list", () => {
		const index = getInitialTasksQuickSwitchIndex(
			[
				{ projectId: "p1", projectName: "Alpha", taskId: "t1", taskTitle: "One", status: "in-progress" },
				{ projectId: "p1", projectName: "Alpha", taskId: "t2", taskTitle: "Two", status: "review-by-user" },
			],
			"t1",
			1,
		);

		expect(index).toBe(1);
	});

	it("wraps backward selection when starting from a non-task route", () => {
		const index = getInitialTasksQuickSwitchIndex(
			[
				{ projectId: "p1", projectName: "Alpha", taskId: "t1", taskTitle: "One", status: "in-progress" },
				{ projectId: "p1", projectName: "Alpha", taskId: "t2", taskTitle: "Two", status: "review-by-user" },
			],
			null,
			-1,
		);

		expect(index).toBe(1);
	});

	it("moves selection cyclically in either direction", () => {
		expect(moveTasksQuickSwitchSelection(0, 3, 1)).toBe(1);
		expect(moveTasksQuickSwitchSelection(2, 3, 1)).toBe(0);
		expect(moveTasksQuickSwitchSelection(0, 3, -1)).toBe(2);
	});

	it("reads the active task id from supported routes", () => {
		expect(
			getActiveQuickSwitchRouteTaskId({
				screen: "task",
				projectId: "p1",
				taskId: "t1",
			} satisfies Route),
		).toBe("t1");
		expect(
			getActiveQuickSwitchRouteTaskId({
				screen: "project",
				projectId: "p1",
				activeTaskId: "t2",
			} satisfies Route),
		).toBe("t2");
		expect(getActiveQuickSwitchRouteTaskId({ screen: "dashboard" })).toBeNull();
	});

	it("builds the open route according to the preferred open mode", () => {
		expect(buildQuickSwitchOpenTaskRoute("p1", "t1", "fullscreen")).toEqual({
			screen: "task",
			projectId: "p1",
			taskId: "t1",
		});
		expect(buildQuickSwitchOpenTaskRoute("p1", "t1", "split")).toEqual({
			screen: "project",
			projectId: "p1",
			activeTaskId: "t1",
		});
	});

	it("reverses quick-switch direction only when Shift is extra to the shortcut", () => {
		expect(
			getQuickSwitchDirection({ shiftKey: true }, { modifiers: ["alt"] }),
		).toBe(-1);
		expect(
			getQuickSwitchDirection(
				{ shiftKey: true },
				{ modifiers: ["alt", "shift"] },
			),
		).toBe(1);
	});

	it("updates the cached project tasks for quick-switch-eligible transitions", () => {
		const activeTask = makeTask({ id: "active-1", projectId: "p1" });
		const updatedTask = makeTask({
			id: "active-1",
			projectId: "p1",
			title: "Updated",
		});
		const inactiveTask = makeTask({
			id: "active-1",
			projectId: "p1",
			status: "completed",
		});

		const withTask = syncTasksQuickSwitchProjectTasks(new Map(), activeTask);
		expect(withTask.get("p1")).toEqual([activeTask]);

		const updated = syncTasksQuickSwitchProjectTasks(withTask, updatedTask);
		expect(updated.get("p1")).toEqual([updatedTask]);

		const completed = syncTasksQuickSwitchProjectTasks(updated, inactiveTask);
		expect(completed.get("p1")).toEqual([inactiveTask]);

		const removed = syncTasksQuickSwitchProjectTasks(
			completed,
			makeTask({
				id: "active-1",
				projectId: "p1",
				status: "todo",
				worktreePath: null,
				branchName: null,
			}),
		);
		expect(removed.get("p1")).toEqual([]);
	});

	it("keeps completed, cancelled, and question tasks in the quick-switch cache", () => {
		const completedTask = makeTask({
			id: "completed-1",
			projectId: "p1",
			status: "completed",
			worktreePath: null,
			branchName: null,
		});
		const cancelledTask = makeTask({
			id: "cancelled-1",
			projectId: "p1",
			status: "cancelled",
			worktreePath: null,
			branchName: null,
		});
		const questionsTask = makeTask({
			id: "questions-1",
			projectId: "p1",
			status: "user-questions",
		});

		const completed = syncTasksQuickSwitchProjectTasks(new Map(), completedTask);
		const cancelled = syncTasksQuickSwitchProjectTasks(completed, cancelledTask);
		const withQuestions = syncTasksQuickSwitchProjectTasks(cancelled, questionsTask);

		expect(withQuestions.get("p1")).toEqual([
			completedTask,
			cancelledTask,
			questionsTask,
		]);
	});
});
