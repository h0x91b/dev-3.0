import { useReducer } from "react";
import type { PortInfo, Project, Task, ResourceUsage } from "../shared/types";

// ---- Routes ----

export type Route =
	| { screen: "dashboard" }
	| { screen: "project"; projectId: string; activeTaskId?: string; taskView?: boolean }
	| { screen: "project-terminal"; projectId: string }
	| { screen: "task"; projectId: string; taskId: string }
	| { screen: "project-settings"; projectId: string; tab?: "global" | "project" | "worktree"; worktreeTaskId?: string }
	| { screen: "settings" }
	| { screen: "changelog" }
	| { screen: "stats" }
	| { screen: "gauge-demo" }
	| { screen: "viewport-lab" };

// ---- State ----

/** Maximum number of entries kept in the navigation history stack. */
export const HISTORY_LIMIT = 15;

/** Max attention reasons kept per task in the hover preview; oldest drop off. */
export const MAX_ATTENTION_REASONS = 5;

export interface AppState {
	route: Route;
	routeHistory: Route[];
	historyIndex: number;
	projects: Project[];
	currentProjectTasks: Task[];
	loading: boolean;
	bellCounts: Map<string, number>;
	/**
	 * Accumulated human-readable reasons per attention badge, set by repeated
	 * `dev3 attention "reason"` calls. Keyed by task id, mirrors `bellCounts`
	 * lifecycle (cleared when the badge is cleared). Each call appends one entry;
	 * the hover preview shows them all. Terminal-bell badges / empty reasons add
	 * nothing here.
	 */
	bellReasons: Map<string, string[]>;
	taskPorts: Map<string, PortInfo[]>;
	taskResourceUsage: Map<string, ResourceUsage>;
	/**
	 * Most-recently-used task ids, newest first. Bumped whenever navigation
	 * lands on a task (full-page or split). Powers the Option+Tab switcher's
	 * order so a quick tap-tap toggles the two most recent tasks. In-memory
	 * only — reset on reload.
	 */
	taskMru: string[];
}

export const initialState: AppState = {
	route: { screen: "dashboard" },
	routeHistory: [{ screen: "dashboard" }],
	historyIndex: 0,
	projects: [],
	currentProjectTasks: [],
	loading: true,
	bellCounts: new Map(),
	bellReasons: new Map(),
	taskPorts: new Map(),
	taskResourceUsage: new Map(),
	taskMru: [],
};

/** The task id a route lands on, or null if the route is not a task view. */
export function routeTaskId(route: Route): string | null {
	if (route.screen === "task") return route.taskId;
	if (route.screen === "project" && route.activeTaskId) return route.activeTaskId;
	return null;
}

/** The task open-mode preference (`dev3-task-open-mode`); "split" is the default. */
export type TaskOpenMode = "split" | "fullscreen";

/**
 * Where to land after `taskId` is completed/cancelled and its worktree is
 * destroyed. The destination is driven by the user's *configured* open-mode,
 * not the transient route, so each user lands back on the surface they live in:
 *
 *  - fullscreen open-mode → that project's Kanban board (their home surface)
 *  - split open-mode      → the split task view with the task deselected
 *                           (`{ screen: "project", taskView: true }`, no
 *                           `activeTaskId`) — the "select a task" placeholder pane
 *  - not viewing this task (Kanban, a different task) → null (don't navigate)
 *
 * Why gate on the preference and not the route: a full-page task view
 * (`screen: "task"`) is reached both by fullscreen-mode users *and* by a
 * split-mode user who temporarily "zoomed" a task. Fullscreen users have no
 * split task list, so collapsing to `{ taskView: true }` would dump them into a
 * layout (board columns / task-list sidebar on the left) they never use — they
 * want the board. A split-mode user, even mid-zoom, should return to their
 * split task view, not the bare board. Returning null means the caller should
 * not navigate at all (the completed card simply leaves the board).
 */
export function routeAfterTaskClosed(route: Route, taskId: string, openMode: TaskOpenMode): Route | null {
	const viewingClosingTask =
		(route.screen === "task" && route.taskId === taskId) ||
		(route.screen === "project" && route.activeTaskId === taskId);
	if (!viewingClosingTask) return null;
	return openMode === "fullscreen"
		? { screen: "project", projectId: route.projectId }
		: { screen: "project", projectId: route.projectId, taskView: true };
}

/** The project id a route lands on, or null for project-less screens (dashboard, settings…). */
export function projectIdForRoute(route: Route): string | null {
	switch (route.screen) {
		case "project":
		case "project-terminal":
		case "task":
		case "project-settings":
			return route.projectId;
		default:
			return null;
	}
}

/** Move `taskId` to the front of the MRU list (newest first); no-op if null. */
function bumpMru(mru: string[], route: Route): string[] {
	const taskId = routeTaskId(route);
	if (!taskId) return mru;
	if (mru[0] === taskId) return mru;
	return [taskId, ...mru.filter((id) => id !== taskId)];
}

// ---- Actions ----

export type AppAction =
	| { type: "navigate"; route: Route }
	| { type: "goBack" }
	| { type: "goForward" }
	| { type: "setProjects"; projects: Project[] }
	| { type: "reorderProjects"; projectIds: string[] }
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
	| { type: "addBell"; taskId: string; reason?: string }
	| { type: "clearBell"; taskId: string }
	| { type: "setPorts"; taskId: string; ports: PortInfo[] }
	| { type: "clearPorts"; taskId: string }
	| { type: "setResourceUsage"; taskId: string; usage: ResourceUsage }
	| { type: "clearResourceUsage"; taskId: string };

/**
 * Clear the attention badge (count + reason) for whichever task the given route
 * is now focused on. Returns the same map references untouched when there is
 * nothing to clear, so callers can spread them without forcing a re-render.
 */
function clearBellForRoute(
	bellCounts: Map<string, number>,
	bellReasons: Map<string, string[]>,
	route: Route,
): { bellCounts: Map<string, number>; bellReasons: Map<string, string[]> } {
	let focusedTaskId: string | null = null;
	if (route.screen === "task") focusedTaskId = route.taskId;
	else if (route.screen === "project" && route.activeTaskId) focusedTaskId = route.activeTaskId;

	if (!focusedTaskId) return { bellCounts, bellReasons };

	const nextCounts = bellCounts.has(focusedTaskId) ? new Map(bellCounts) : bellCounts;
	if (nextCounts !== bellCounts) nextCounts.delete(focusedTaskId);

	const nextReasons = bellReasons.has(focusedTaskId) ? new Map(bellReasons) : bellReasons;
	if (nextReasons !== bellReasons) nextReasons.delete(focusedTaskId);

	return { bellCounts: nextCounts, bellReasons: nextReasons };
}

function normalizeProjectPath(path: string): string {
	return path.replace(/\/+$/, "");
}

export function reducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "navigate": {
			const { bellCounts, bellReasons } = clearBellForRoute(state.bellCounts, state.bellReasons, action.route);
			// Truncate any forward history beyond the current index, then push
			const base = state.routeHistory.slice(0, state.historyIndex + 1);
			base.push(action.route);
			// Trim oldest entries if over the limit
			const routeHistory = base.length > HISTORY_LIMIT ? base.slice(base.length - HISTORY_LIMIT) : base;
			const historyIndex = routeHistory.length - 1;
			const taskMru = bumpMru(state.taskMru, action.route);
			return { ...state, route: action.route, routeHistory, historyIndex, bellCounts, bellReasons, taskMru };
		}
		case "goBack": {
			if (state.historyIndex <= 0) return state;
			const newIndex = state.historyIndex - 1;
			const route = state.routeHistory[newIndex];
			const { bellCounts, bellReasons } = clearBellForRoute(state.bellCounts, state.bellReasons, route);
			const taskMru = bumpMru(state.taskMru, route);
			return { ...state, route, historyIndex: newIndex, bellCounts, bellReasons, taskMru };
		}
		case "goForward": {
			if (state.historyIndex >= state.routeHistory.length - 1) return state;
			const newIndex = state.historyIndex + 1;
			const route = state.routeHistory[newIndex];
			const { bellCounts, bellReasons } = clearBellForRoute(state.bellCounts, state.bellReasons, route);
			const taskMru = bumpMru(state.taskMru, route);
			return { ...state, route, historyIndex: newIndex, bellCounts, bellReasons, taskMru };
		}
		case "setProjects":
			return { ...state, projects: action.projects };
		case "reorderProjects": {
			const byId = new Map(state.projects.map((project) => [project.id, project]));
			const seen = new Set<string>();
			const reordered: Project[] = [];
			for (const projectId of action.projectIds) {
				const project = byId.get(projectId);
				if (!project || seen.has(project.id)) continue;
				reordered.push(project);
				seen.add(project.id);
			}
			for (const project of state.projects) {
				if (!seen.has(project.id)) reordered.push(project);
			}
			return { ...state, projects: reordered };
		}
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
		case "addProject": {
			const normalizedPath = normalizeProjectPath(action.project.path);
			const existingIndex = state.projects.findIndex((project) =>
				project.id === action.project.id ||
				normalizeProjectPath(project.path) === normalizedPath,
			);
			if (existingIndex === -1) {
				return { ...state, projects: [...state.projects, action.project] };
			}
			return {
				...state,
				projects: state.projects.map((project, index) =>
					index === existingIndex ? action.project : project,
				),
			};
		}
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
			// Only attention calls carry a reason; bare terminal bells don't.
			const trimmed = action.reason?.trim();
			if (!trimmed) {
				return { ...state, bellCounts };
			}
			const bellReasons = new Map(state.bellReasons);
			// Keep only the most recent MAX_ATTENTION_REASONS; oldest drop off.
			const nextList = [...(bellReasons.get(action.taskId) ?? []), trimmed].slice(-MAX_ATTENTION_REASONS);
			bellReasons.set(action.taskId, nextList);
			return { ...state, bellCounts, bellReasons };
		}
		case "clearBell": {
			if (!state.bellCounts.has(action.taskId) && !state.bellReasons.has(action.taskId)) return state;
			const bellCounts = new Map(state.bellCounts);
			bellCounts.delete(action.taskId);
			const bellReasons = new Map(state.bellReasons);
			bellReasons.delete(action.taskId);
			return { ...state, bellCounts, bellReasons };
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
		case "setResourceUsage": {
			const taskResourceUsage = new Map(state.taskResourceUsage);
			taskResourceUsage.set(action.taskId, action.usage);
			return { ...state, taskResourceUsage };
		}
		case "clearResourceUsage": {
			if (!state.taskResourceUsage.has(action.taskId)) return state;
			const taskResourceUsage = new Map(state.taskResourceUsage);
			taskResourceUsage.delete(action.taskId);
			return { ...state, taskResourceUsage };
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
