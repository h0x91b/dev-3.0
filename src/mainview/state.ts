import { useReducer } from "react";
import type { Project, Task } from "../shared/types";

// ---- Routes ----

export type Route =
	| { screen: "dashboard" }
	| { screen: "project"; projectId: string }
	| { screen: "task"; projectId: string; taskId: string }
	| { screen: "project-settings"; projectId: string }
	| { screen: "settings" };

// ---- State ----

export interface AppState {
	route: Route;
	projects: Project[];
	currentProjectTasks: Task[];
	loading: boolean;
}

export const initialState: AppState = {
	route: { screen: "dashboard" },
	projects: [],
	currentProjectTasks: [],
	loading: true,
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
	| { type: "setLoading"; loading: boolean };

export function reducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "navigate":
			return { ...state, route: action.route };
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
		default:
			return state;
	}
}

export function useAppState() {
	return useReducer(reducer, initialState);
}
