import { reducer, initialState } from "../state";
import type { AppState, AppAction } from "../state";
import type { Project, Task } from "../../shared/types";

const mockProject: Project = {
	id: "p1",
	name: "Test Project",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	clonePaths: [],
	createdAt: "2025-01-01T00:00:00Z",
};

const mockTask: Task = {
	id: "t1",
	seq: 1,
	projectId: "p1",
	title: "Test Task",
	description: "Test Task",
	status: "todo",
	baseBranch: "main",
	worktreePath: null,
	branchName: null,
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	createdAt: "2025-01-01T00:00:00Z",
	updatedAt: "2025-01-01T00:00:00Z",
};

describe("initialState", () => {
	it("has expected defaults", () => {
		expect(initialState).toEqual({
			route: { screen: "dashboard" },
			previousRoute: null,
			projects: [],
			currentProjectTasks: [],
			loading: true,
			bellCounts: new Map(),
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

	it("updateTask: adds new task when viewing the same project", () => {
		const newTask: Task = { ...mockTask, id: "t-new", title: "Created via CLI" };
		const state: AppState = {
			...initialState,
			route: { screen: "project", projectId: "p1" },
			currentProjectTasks: [mockTask],
		};
		const next = reducer(state, { type: "updateTask", task: newTask });
		expect(next.currentProjectTasks).toHaveLength(2);
		expect(next.currentProjectTasks[1].id).toBe("t-new");
	});

	it("updateTask: ignores new task from a different project", () => {
		const foreignTask: Task = { ...mockTask, id: "t-other", projectId: "p-other" };
		const state: AppState = {
			...initialState,
			route: { screen: "project", projectId: "p1" },
			currentProjectTasks: [mockTask],
		};
		const next = reducer(state, { type: "updateTask", task: foreignTask });
		expect(next.currentProjectTasks).toHaveLength(1);
	});

	it("updateTask: ignores new task when on dashboard (no project context)", () => {
		const newTask: Task = { ...mockTask, id: "t-new" };
		const state: AppState = {
			...initialState,
			route: { screen: "dashboard" },
			currentProjectTasks: [],
		};
		const next = reducer(state, { type: "updateTask", task: newTask });
		expect(next.currentProjectTasks).toHaveLength(0);
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

	it("spawnVariants: removes source task and adds variants", () => {
		const state: AppState = {
			...initialState,
			currentProjectTasks: [mockTask],
		};
		const variant1: Task = {
			...mockTask,
			id: "v1",
			status: "in-progress",
			groupId: "g1",
			variantIndex: 1,
			agentId: "builtin-claude",
			configId: "claude-default",
		};
		const variant2: Task = {
			...mockTask,
			id: "v2",
			status: "in-progress",
			groupId: "g1",
			variantIndex: 2,
			agentId: "builtin-gemini",
			configId: "gemini-default",
		};
		const next = reducer(state, {
			type: "spawnVariants",
			sourceTaskId: "t1",
			variants: [variant1, variant2],
		});
		expect(next.currentProjectTasks).toHaveLength(2);
		expect(next.currentProjectTasks.find((t) => t.id === "t1")).toBeUndefined();
		expect(next.currentProjectTasks[0].id).toBe("v1");
		expect(next.currentProjectTasks[1].id).toBe("v2");
	});

	it("spawnVariants: deduplicates variants already added by pushMessage race", () => {
		// Simulate the race: updateTask (from pushMessage) adds variant BEFORE
		// spawnVariants action arrives. The reducer must not duplicate it.
		const variant1: Task = {
			...mockTask,
			id: "v1",
			status: "in-progress",
			groupId: "g1",
			variantIndex: 1,
			agentId: "builtin-claude",
			configId: "claude-default",
		};
		const state: AppState = {
			...initialState,
			// Source task + variant already added by updateTask push
			currentProjectTasks: [mockTask, variant1],
		};
		const next = reducer(state, {
			type: "spawnVariants",
			sourceTaskId: "t1",
			variants: [variant1],
		});
		expect(next.currentProjectTasks).toHaveLength(1);
		expect(next.currentProjectTasks[0].id).toBe("v1");
	});

	it("spawnVariants: preserves other tasks", () => {
		const otherTask: Task = { ...mockTask, id: "t2", title: "Other" };
		const state: AppState = {
			...initialState,
			currentProjectTasks: [mockTask, otherTask],
		};
		const variant1: Task = {
			...mockTask,
			id: "v1",
			status: "in-progress",
			groupId: "g1",
			variantIndex: 1,
		};
		const next = reducer(state, {
			type: "spawnVariants",
			sourceTaskId: "t1",
			variants: [variant1],
		});
		expect(next.currentProjectTasks).toHaveLength(2);
		expect(next.currentProjectTasks.find((t) => t.id === "t2")).toBeDefined();
		expect(next.currentProjectTasks.find((t) => t.id === "v1")).toBeDefined();
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
