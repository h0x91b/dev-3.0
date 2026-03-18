import { useReducer } from "react";
import type { PortInfo, Project, Task } from "../shared/types";

// ---- Routes ----

export type Route =
	| { screen: "dashboard" }
	| { screen: "project"; projectId: string; activeTaskId?: string }
	| { screen: "project-terminal"; projectId: string }
	| { screen: "task"; projectId: string; taskId: string }
	| { screen: "project-settings"; projectId: string; tab?: "global" | "project" | "worktree"; worktreeTaskId?: string }
	| { screen: "settings" }
	| { screen: "changelog" }
	| { screen: "gauge-demo" }
	| { screen: "viewport-lab" };

// ---- State ----

/** Maximum number of entries kept in the navigation history stack. */
export const HISTORY_LIMIT = 15;

export interface AppState {
	route: Route;
	routeHistory: Route[];
	historyIndex: number;
	projects: Project[];
	currentProjectTasks: Task[];
	loading: boolean;
	bellCounts: Map<string, number>;
	taskPorts: Map<string, PortInfo[]>;
}

export const initialState: AppState = {
	route: { screen: "dashboard" },
	routeHistory: [{ screen: "dashboard" }],
	historyIndex: 0,
	projects: [],
	currentProjectTasks: [],
	loading: true,
	bellCounts: new Map(),
	taskPorts: new Map(),
};

// ---- Actions ----

export type AppAction =
	| { type: "navigate"; route: Route }
	| { type: "goBack" }
	| { type: "goForward" }
	| { type: "setProjects"; projects: Project[] }
	| { type: "setTasks"; tasks: Task[] }
	| { type: "updateTask"; task: Task }
	| { type: "addTask"; task: Task }
	| { type: "removeTask"; taskId: string }
	| { type: "spawnVariants"; sourceTaskId: string; variants: Task[] }
	| { type: "addAttempts"; sourceTaskId: string; newAttempts: Task[]; updatedSource: Task }
	| { type: "addProject"; project: Project }
	| { type: "removeProject"; projectId: string }
	| { type: "updateProject"; project: Project }
	| { type: "setLoading"; loading: boolean }
	| { type: "addBell"; taskId: string }
	| { type: "clearBell"; taskId: string }
	| { type: "setPorts"; taskId: string; ports: PortInfo[] }
	| { type: "clearPorts"; taskId: string };

function clearBellForRoute(bellCounts: Map<string, number>, route: Route): Map<string, number> {
	if (route.screen === "task" && bellCounts.has(route.taskId)) {
		const next = new Map(bellCounts);
		next.delete(route.taskId);
		return next;
	}
	if (route.screen === "project" && route.activeTaskId && bellCounts.has(route.activeTaskId)) {
		const next = new Map(bellCounts);
		next.delete(route.activeTaskId);
		return next;
	}
	return bellCounts;
}

export function reducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "navigate": {
			const bellCounts = clearBellForRoute(state.bellCounts, action.route);
			// Truncate any forward history beyond the current index, then push
			const base = state.routeHistory.slice(0, state.historyIndex + 1);
			base.push(action.route);
			// Trim oldest entries if over the limit
			const routeHistory = base.length > HISTORY_LIMIT ? base.slice(base.length - HISTORY_LIMIT) : base;
			const historyIndex = routeHistory.length - 1;
			return { ...state, route: action.route, routeHistory, historyIndex, bellCounts };
		}
		case "goBack": {
			if (state.historyIndex <= 0) return state;
			const newIndex = state.historyIndex - 1;
			const route = state.routeHistory[newIndex];
			const bellCounts = clearBellForRoute(state.bellCounts, route);
			return { ...state, route, historyIndex: newIndex, bellCounts };
		}
		case "goForward": {
			if (state.historyIndex >= state.routeHistory.length - 1) return state;
			const newIndex = state.historyIndex + 1;
			const route = state.routeHistory[newIndex];
			const bellCounts = clearBellForRoute(state.bellCounts, route);
			return { ...state, route, historyIndex: newIndex, bellCounts };
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
			if (state.currentProjectTasks.some((t) => t.id === action.task.id))
				return state;
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
		case "addAttempts": {
			const attemptIds = new Set(action.newAttempts.map((v) => v.id));
			return {
				...state,
				currentProjectTasks: [
					...state.currentProjectTasks
						.filter((t) => !attemptIds.has(t.id))
						.map((t) => t.id === action.sourceTaskId ? action.updatedSource : t),
					...action.newAttempts,
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
		case "setPorts": {
			const taskPorts = new Map(state.taskPorts);
			if (action.ports.length === 0) {
				taskPorts.delete(action.taskId);
			} else {
				taskPorts.set(action.taskId, action.ports);
			}
			return { ...state, taskPorts };
		}
		case "clearPorts": {
			if (!state.taskPorts.has(action.taskId)) return state;
			const taskPorts = new Map(state.taskPorts);
			taskPorts.delete(action.taskId);
			return { ...state, taskPorts };
		}
		default:
			return state;
	}
}

export function canGoBack(state: AppState): boolean {
	return state.historyIndex > 0;
}

export function canGoForward(state: AppState): boolean {
	return state.historyIndex < state.routeHistory.length - 1;
}

export function useAppState() {
	return useReducer(reducer, initialState);
}
