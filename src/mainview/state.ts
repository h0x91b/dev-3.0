import { useReducer } from "react";
import type { Label, Project, Task } from "../shared/types";

// ---- Routes ----

export type Route =
	| { screen: "dashboard" }
	| { screen: "project"; projectId: string }
	| { screen: "task"; projectId: string; taskId: string }
	| { screen: "project-settings"; projectId: string }
	| { screen: "settings" }
	| { screen: "changelog" };

// ---- State ----

export interface AppState {
	route: Route;
	previousRoute: Route | null;
	projects: Project[];
	currentProjectTasks: Task[];
	currentProjectLabels: Label[];
	activeLabelFilter: string[];
	loading: boolean;
	bellCounts: Map<string, number>;
}

export const initialState: AppState = {
	route: { screen: "dashboard" },
	previousRoute: null,
	projects: [],
	currentProjectTasks: [],
	currentProjectLabels: [],
	activeLabelFilter: [],
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
	| { type: "clearBell"; taskId: string }
	| { type: "setLabels"; labels: Label[] }
	| { type: "addLabel"; label: Label }
	| { type: "updateLabel"; label: Label }
	| { type: "removeLabel"; labelId: string }
	| { type: "toggleLabelFilter"; labelId: string }
	| { type: "clearLabelFilter" };

export function reducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "navigate": {
			// Auto-clear bell when user opens the task terminal
			let bellCounts = state.bellCounts;
			if (action.route.screen === "task" && bellCounts.has(action.route.taskId)) {
				bellCounts = new Map(bellCounts);
				bellCounts.delete(action.route.taskId);
			}
			return { ...state, route: action.route, previousRoute: state.route, bellCounts };
		}
		case "setProjects":
			return { ...state, projects: action.projects };
		case "setTasks":
			return { ...state, currentProjectTasks: action.tasks };
		case "updateTask":
			return {
				...state,
				currentProjectTasks: state.currentProjectTasks.map((t) =>
					t.id === action.task.id ? action.task : t,
				),
			};
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
		case "spawnVariants":
			return {
				...state,
				currentProjectTasks: [
					...state.currentProjectTasks.filter(
						(t) => t.id !== action.sourceTaskId,
					),
					...action.variants,
				],
			};
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
		case "setLabels":
			return { ...state, currentProjectLabels: action.labels, activeLabelFilter: [] };
		case "addLabel":
			return { ...state, currentProjectLabels: [...state.currentProjectLabels, action.label] };
		case "updateLabel":
			return {
				...state,
				currentProjectLabels: state.currentProjectLabels.map((l) =>
					l.id === action.label.id ? action.label : l,
				),
			};
		case "removeLabel":
			return {
				...state,
				currentProjectLabels: state.currentProjectLabels.filter((l) => l.id !== action.labelId),
				activeLabelFilter: state.activeLabelFilter.filter((id) => id !== action.labelId),
				currentProjectTasks: state.currentProjectTasks.map((t) =>
					t.labelIds.includes(action.labelId)
						? { ...t, labelIds: t.labelIds.filter((id) => id !== action.labelId) }
						: t,
				),
			};
		case "toggleLabelFilter": {
			const active = state.activeLabelFilter;
			const next = active.includes(action.labelId)
				? active.filter((id) => id !== action.labelId)
				: [...active, action.labelId];
			return { ...state, activeLabelFilter: next };
		}
		case "clearLabelFilter":
			return { ...state, activeLabelFilter: [] };
		default:
			return state;
	}
}

export function useAppState() {
	return useReducer(reducer, initialState);
}
