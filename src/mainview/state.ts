import { useReducer } from "react";
import type { Project, Task } from "../shared/types";

// ---- Routes ----

export type Route =
	| { screen: "dashboard" }
	| { screen: "project"; projectId: string; activeTaskId?: string }
	| { screen: "task"; projectId: string; taskId: string }
	| { screen: "project-settings"; projectId: string }
	| { screen: "settings" }
	| { screen: "changelog" }
	| { screen: "gauge-demo" };

// ---- State ----

export interface AppState {
	route: Route;
	previousRoute: Route | null;
	projects: Project[];
	currentProjectTasks: Task[];
	loading: boolean;
	bellCounts: Map<string, number>;
}

export const initialState: AppState = {
	route: { screen: "dashboard" },
	previousRoute: null,
	projects: [],
	currentProjectTasks: [],
	loading: true,
	bellCounts: new Map(),
};

// ---- Actions ----

export type AppAction =
	| { type: "navigate"; route: Route }
	| { type: "setProjects"; projects: Project[] }
	| { type: "setTasks"; tasks: Task[] }
	| { type: "updateTask"; task: Task }
	| { type: "addTask"; task: Task }
	| { type: "removeTask"; taskId: string }
	| { type: "spawnVariants"; sourceTaskId: string; variants: Task[] }
	| { type: "addProject"; project: Project }
	| { type: "removeProject"; projectId: string }
	| { type: "updateProject"; project: Project }
	| { type: "setLoading"; loading: boolean }
	| { type: "addBell"; taskId: string }
	| { type: "clearBell"; taskId: string };

export function reducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "navigate": {
			// Auto-clear bell when user opens the task terminal
			let bellCounts = state.bellCounts;
			if (action.route.screen === "task" && bellCounts.has(action.route.taskId)) {
				bellCounts = new Map(bellCounts);
				bellCounts.delete(action.route.taskId);
			}
			// Also clear bell when opening task in split view
			if (action.route.screen === "project" && action.route.activeTaskId && bellCounts.has(action.route.activeTaskId)) {
				bellCounts = new Map(bellCounts);
				bellCounts.delete(action.route.activeTaskId);
			}
			return { ...state, route: action.route, previousRoute: state.route, bellCounts };
		}
		case "setProjects":
			return { ...state, projects: action.projects };
		case "setTasks":
			return { ...state, currentProjectTasks: action.tasks };
		case "updateTask": {
			const exists = state.currentProjectTasks.some((t) => t.id === action.task.id);
			if (exists) {
				return {
					...state,
					currentProjectTasks: state.currentProjectTasks.map((t) =>
						t.id === action.task.id ? action.task : t,
					),
				};
			}
			// New task (e.g. created via CLI) — add if we're viewing the same project
			const viewingProjectId =
				state.route.screen === "project" || state.route.screen === "task" || state.route.screen === "project-settings"
					? state.route.projectId
					: null;
			if (viewingProjectId && action.task.projectId === viewingProjectId) {
				return {
					...state,
					currentProjectTasks: [...state.currentProjectTasks, action.task],
				};
			}
			return state;
		}
		case "addTask":
			return {
				...state,
				currentProjectTasks: [...state.currentProjectTasks, action.task],
			};
		case "removeTask":
			return {
				...state,
				currentProjectTasks: state.currentProjectTasks.filter(
					(t) => t.id !== action.taskId,
				),
			};
		case "spawnVariants": {
			// Collect variant IDs to filter out any duplicates already added
			// by a concurrent pushMessage("taskUpdated") race
			const variantIds = new Set(action.variants.map((v) => v.id));
			return {
				...state,
				currentProjectTasks: [
					...state.currentProjectTasks.filter(
						(t) => t.id !== action.sourceTaskId && !variantIds.has(t.id),
					),
					...action.variants,
				],
			};
		}
		case "addProject":
			return { ...state, projects: [...state.projects, action.project] };
		case "removeProject":
			return {
				...state,
				projects: state.projects.filter((p) => p.id !== action.projectId),
			};
		case "updateProject":
			return {
				...state,
				projects: state.projects.map((p) =>
					p.id === action.project.id ? action.project : p,
				),
			};
		case "setLoading":
			return { ...state, loading: action.loading };
		case "addBell": {
			// Don't add bell if user is already viewing this task's terminal
			if (
				state.route.screen === "task" &&
				state.route.taskId === action.taskId
			) {
				return state;
			}
			// Also suppress bell when viewing task in split view
			if (
				state.route.screen === "project" &&
				state.route.activeTaskId === action.taskId
			) {
				return state;
			}
			const bellCounts = new Map(state.bellCounts);
			bellCounts.set(action.taskId, (bellCounts.get(action.taskId) ?? 0) + 1);
			return { ...state, bellCounts };
		}
		case "clearBell": {
			if (!state.bellCounts.has(action.taskId)) return state;
			const bellCounts = new Map(state.bellCounts);
			bellCounts.delete(action.taskId);
			return { ...state, bellCounts };
		}
		default:
			return state;
	}
}

export function useAppState() {
	return useReducer(reducer, initialState);
}
