import { reducer, initialState } from "../state";
import type { AppState, AppAction } from "../state";
import type { Project, Task } from "../../shared/types";

const mockProject: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	defaultTmuxCommand: "claude",
	defaultAgentId: "builtin-claude",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const mockTask: Task = {
	id: "t1",
	projectId: "p1",
	title: "Test Task",
	status: "todo",
	baseBranch: "main",
	worktreePath: null,
	branchName: null,
	createdAt: "2025-01-01T00:00:00Z",
	updatedAt: "2025-01-01T00:00:00Z",
};

describe("initialState", () => {
	it("has expected defaults", () => {
		expect(initialState).toEqual({
			route: { screen: "dashboard" },
			projects: [],
			currentProjectTasks: [],
			loading: true,
		});
	});
});

describe("reducer", () => {
	it("navigate: updates route", () => {
		const next = reducer(initialState, {
			type: "navigate",
			route: { screen: "project", projectId: "p1" },
		});
		expect(next.route).toEqual({ screen: "project", projectId: "p1" });
	});

	it("setProjects: replaces projects array", () => {
		const next = reducer(initialState, {
			type: "setProjects",
			projects: [mockProject],
		});
		expect(next.projects).toEqual([mockProject]);
	});

	it("setTasks: replaces currentProjectTasks", () => {
		const next = reducer(initialState, {
			type: "setTasks",
			tasks: [mockTask],
		});
		expect(next.currentProjectTasks).toEqual([mockTask]);
	});

	it("updateTask: updates matching task", () => {
		const state: AppState = {
			...initialState,
			currentProjectTasks: [mockTask],
		};
		const updated = { ...mockTask, title: "Updated" };
		const next = reducer(state, { type: "updateTask", task: updated });
		expect(next.currentProjectTasks[0].title).toBe("Updated");
	});

	it("updateTask: leaves non-matching tasks unchanged", () => {
		const other: Task = { ...mockTask, id: "t2", title: "Other" };
		const state: AppState = {
			...initialState,
			currentProjectTasks: [mockTask, other],
		};
		const updated = { ...mockTask, title: "Updated" };
		const next = reducer(state, { type: "updateTask", task: updated });
		expect(next.currentProjectTasks[1]).toBe(other);
	});

	it("addTask: appends to currentProjectTasks", () => {
		const next = reducer(initialState, {
			type: "addTask",
			task: mockTask,
		});
		expect(next.currentProjectTasks).toEqual([mockTask]);
	});

	it("removeTask: removes by id", () => {
		const state: AppState = {
			...initialState,
			currentProjectTasks: [mockTask],
		};
		const next = reducer(state, {
			type: "removeTask",
			taskId: "t1",
		});
		expect(next.currentProjectTasks).toEqual([]);
	});

	it("addProject: appends to projects", () => {
		const next = reducer(initialState, {
			type: "addProject",
			project: mockProject,
		});
		expect(next.projects).toEqual([mockProject]);
	});

	it("removeProject: removes by id", () => {
		const state: AppState = {
			...initialState,
			projects: [mockProject],
		};
		const next = reducer(state, {
			type: "removeProject",
			projectId: "p1",
		});
		expect(next.projects).toEqual([]);
	});

	it("updateProject: updates matching project", () => {
		const state: AppState = {
			...initialState,
			projects: [mockProject],
		};
		const updated = { ...mockProject, name: "Renamed" };
		const next = reducer(state, {
			type: "updateProject",
			project: updated,
		});
		expect(next.projects[0].name).toBe("Renamed");
	});

	it("setLoading: updates loading flag", () => {
		const next = reducer(initialState, {
			type: "setLoading",
			loading: false,
		});
		expect(next.loading).toBe(false);
	});

	it("unknown action: returns state unchanged", () => {
		const next = reducer(initialState, {
			type: "unknownAction" as AppAction["type"],
		} as AppAction);
		expect(next).toBe(initialState);
	});
});
