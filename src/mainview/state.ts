import { useReducer } from "react";
import type { DevServerSummary, PortInfo, Project, Task, ResourceUsage } from "../shared/types";
import type { SettingsRouteSectionId } from "./settings-registry";
import type { TaskInlineDiffRequest } from "./components/task-inline-diff";

// ---- Routes ----

/**
 * Global Settings route vocabulary. New callers use category ids; legacy
 * section ids remain accepted so existing events and deep links keep working.
 */
export type SettingsSectionId = SettingsRouteSectionId;
export type { LegacySettingsSectionId, SettingsCategoryId } from "./settings-registry";

/** Fired by any surface that wants to jump the user to a Global Settings
 *  section (e.g. clicking a proxy-gated preset in the launch picker). App
 *  listens and navigates to `{ screen: "settings", section }`. Legacy details
 *  are normalized by GlobalSettings using the registry map. */
export const OPEN_SETTINGS_SECTION_EVENT = "dev3:openSettingsSection";

/** One preset a deep-link wants opened and scrolled to in Settings → Agents.
 *  A section alone lands the user on a screen and leaves them to find the row. */
export interface SettingsPresetTarget {
	agentId: string;
	configId: string;
}

/** What the event carries. A bare section id is still the common case; the
 *  object form exists for callers that know exactly which record they mean. */
export type OpenSettingsSectionDetail =
	| SettingsSectionId
	| { section: SettingsSectionId; preset?: SettingsPresetTarget };

/**
 * The diff viewer is a full-bleed surface that replaces the task workspace, so
 * it reads as a page and Back must return to the task. It is NOT a destination
 * (no new `screen`, no breadcrumb, no nav entry) — it rides on the task route
 * as an extra field, which is what puts it on the back/forward stack.
 */
export type Route =
	| { screen: "dashboard" }
	| { screen: "project"; projectId: string; activeTaskId?: string; taskView?: boolean; openUnresolvedComments?: boolean; diff?: TaskInlineDiffRequest }
	| { screen: "project-terminal"; projectId: string }
	| { screen: "task"; projectId: string; taskId: string; openUnresolvedComments?: boolean; diff?: TaskInlineDiffRequest }
	| { screen: "project-settings"; projectId: string; tab?: "global" | "project" | "worktree" | "automations"; worktreeTaskId?: string }
	| { screen: "settings"; section?: SettingsSectionId; preset?: SettingsPresetTarget }
	| { screen: "changelog" }
	| { screen: "stats" }
	| { screen: "gauge-demo" }
	| { screen: "viewport-lab" }
	| { screen: "native-pane-layout-lab" };

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
	 * lifecycle (cleared when the badge is cleared). Repeated reasons are kept
	 * once and moved to the newest position; terminal-bell badges / empty reasons
	 * add nothing here.
	 */
	bellReasons: Map<string, string[]>;
	taskPorts: Map<string, PortInfo[]>;
	/** Live dev-server state per task, feeding the dev control on the Kanban card. */
	taskDevServers: Map<string, DevServerSummary>;
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
	taskDevServers: new Map(),
	taskResourceUsage: new Map(),
	taskMru: [],
};

/** The task id a route lands on, or null if the route is not a task view. */
export function routeTaskId(route: Route): string | null {
	if (route.screen === "task") return route.taskId;
	if (route.screen === "project" && route.activeTaskId) return route.activeTaskId;
	return null;
}

/** The inline-diff request a route carries, or null when the diff is closed. */
export function routeDiffRequest(route: Route): TaskInlineDiffRequest | null {
	if (route.screen === "task") return route.diff ?? null;
	if (route.screen === "project" && route.activeTaskId) return route.diff ?? null;
	return null;
}

/**
 * The same route with the diff open. Returns null for routes that cannot hold
 * one (no task in view) so the reducer can ignore a stray open.
 */
export function routeWithDiff(route: Route, request: TaskInlineDiffRequest): Route | null {
	if (route.screen === "task") return { ...route, diff: request };
	if (route.screen === "project" && route.activeTaskId) return { ...route, diff: request };
	return null;
}

/** The same route with the diff closed. */
export function routeWithoutDiff(route: Route): Route {
	if (route.screen === "task" || route.screen === "project") {
		const { diff: _diff, ...rest } = route;
		return rest;
	}
	return route;
}

/** True when two routes are the same task surface, ignoring the diff field. */
function sameTaskLocation(a: Route, b: Route): boolean {
	if (a.screen !== b.screen) return false;
	if (a.screen === "task" && b.screen === "task") return a.projectId === b.projectId && a.taskId === b.taskId;
	if (a.screen === "project" && b.screen === "project") {
		return a.projectId === b.projectId && a.activeTaskId === b.activeTaskId && a.taskView === b.taskView;
	}
	return false;
}

/** The task open-mode preference (`dev3-task-open-mode`); "split" is the default. */
export type TaskOpenMode = "split" | "fullscreen";

/** Read the persisted task open-mode preference; "split" is the default. */
export function getTaskOpenMode(): TaskOpenMode {
	return localStorage.getItem("dev3-task-open-mode") === "fullscreen" ? "fullscreen" : "split";
}

/**
 * The home surface a user lands on after leaving a closed task's view:
 * fullscreen open-mode → the project's Kanban board; split open-mode → the
 * split task view with no task selected. Call sites that already know the user
 * is on the closing task's surface (info panel, task terminal) use this
 * directly; App-level dialog flows that may fire while the user is elsewhere
 * go through routeAfterTaskClosed, which adds the "viewing this task?" gate.
 */
export function taskClosedHomeRoute(projectId: string, openMode: TaskOpenMode): Route {
	return openMode === "fullscreen"
		? { screen: "project", projectId }
		: { screen: "project", projectId, taskView: true };
}

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
	return taskClosedHomeRoute(route.projectId, openMode);
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
	| { type: "openTaskDiff"; request: TaskInlineDiffRequest }
	| { type: "closeTaskDiff" }
	| { type: "setProjects"; projects: Project[] }
	| { type: "reorderProjects"; projectIds: string[] }
	| { type: "setTasks"; projectId: string; tasks: Task[] }
	| { type: "updateTask"; task: Task }
	| { type: "addTask"; task: Task }
	| { type: "removeTask"; taskId: string; projectId?: string }
	| { type: "spawnVariants"; sourceTaskId: string; variants: Task[] }
	| { type: "addAttempts"; sourceTaskId: string; newAttempts: Task[]; updatedSource: Task }
	| { type: "addProject"; project: Project }
	| { type: "removeProject"; projectId: string }
	| { type: "updateProject"; project: Project }
	| { type: "setLoading"; loading: boolean }
	| { type: "addBell"; taskId: string; reason?: string; force?: boolean }
	| { type: "clearBell"; taskId: string }
	| { type: "setPorts"; taskId: string; ports: PortInfo[] }
	| { type: "clearPorts"; taskId: string }
	| { type: "setDevServer"; summary: DevServerSummary }
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

/** Push `route` onto the history stack, truncating any forward entries. */
function pushRoute(state: AppState, route: Route): AppState {
	const { bellCounts, bellReasons } = clearBellForRoute(state.bellCounts, state.bellReasons, route);
	const currentProjectId = projectIdForRoute(state.route);
	const nextProjectId = projectIdForRoute(route);
	// Truncate any forward history beyond the current index, then push
	const base = state.routeHistory.slice(0, state.historyIndex + 1);
	base.push(route);
	// Trim oldest entries if over the limit
	const routeHistory = base.length > HISTORY_LIMIT ? base.slice(base.length - HISTORY_LIMIT) : base;
	return {
		...state,
		route,
		routeHistory,
		historyIndex: routeHistory.length - 1,
		bellCounts,
		bellReasons,
		taskMru: bumpMru(state.taskMru, route),
		currentProjectTasks: currentProjectId === nextProjectId ? state.currentProjectTasks : [],
	};
}

/** Overwrite the current history entry instead of stacking a new one. */
function replaceRoute(state: AppState, route: Route): AppState {
	const routeHistory = state.routeHistory.slice();
	routeHistory[state.historyIndex] = route;
	return { ...state, route, routeHistory };
}

/** Move to an existing history entry (Back / Forward). */
function stepHistory(state: AppState, newIndex: number): AppState {
	if (newIndex < 0 || newIndex >= state.routeHistory.length) return state;
	const route = state.routeHistory[newIndex];
	const { bellCounts, bellReasons } = clearBellForRoute(state.bellCounts, state.bellReasons, route);
	return {
		...state,
		route,
		historyIndex: newIndex,
		bellCounts,
		bellReasons,
		taskMru: bumpMru(state.taskMru, route),
		currentProjectTasks:
			projectIdForRoute(state.route) === projectIdForRoute(route) ? state.currentProjectTasks : [],
	};
}

export function reducer(state: AppState, action: AppAction): AppState {
	switch (action.type) {
		case "navigate":
			return pushRoute(state, action.route);
		case "goBack":
			return stepHistory(state, state.historyIndex - 1);
		case "goForward":
			return stepHistory(state, state.historyIndex + 1);
		case "openTaskDiff": {
			const route = routeWithDiff(state.route, action.request);
			if (!route) return state;
			// Re-opening while already in the diff (a PR deep link, a different
			// focus file) retargets the current entry — it must not stack a second
			// diff step that Back would then have to walk through twice.
			if (routeDiffRequest(state.route)) return replaceRoute(state, route);
			return pushRoute(state, route);
		}
		case "closeTaskDiff": {
			if (!routeDiffRequest(state.route)) return state;
			const previous = state.routeHistory[state.historyIndex - 1];
			// Closing is the same movement as Back when the diff was opened from
			// this very task: step back so Forward still returns to the diff.
			if (previous && sameTaskLocation(previous, state.route)) return stepHistory(state, state.historyIndex - 1);
			return replaceRoute(state, routeWithoutDiff(state.route));
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
			// Task fetches are asynchronous. Ignore a response that belongs to a
			// project the user has already left instead of repopulating the new
			// project's board with stale cards.
			if (projectIdForRoute(state.route) !== action.projectId) return state;
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
			// When scoped to a project (cross-project move sync), only clear the card
			// if that project's board is the one currently shown — otherwise a
			// `taskRemoved` for the SOURCE project would also strip the freshly-added
			// card from a window viewing the TARGET (same task id). Unscoped removals
			// (local delete) always filter, preserving prior behavior.
			if (action.projectId && projectIdForRoute(state.route) !== action.projectId) return state;
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
			if (!action.force &&
				state.route.screen === "task" &&
				state.route.taskId === action.taskId
			) {
				return state;
			}
			// Also suppress bell when viewing task in split view
			if (!action.force &&
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
			// Keep reasons unique while moving repeated text to the newest position,
			// then retain only the most recent MAX_ATTENTION_REASONS entries.
			const nextList = [
				...(bellReasons.get(action.taskId) ?? []).filter((reason) => reason !== trimmed),
				trimmed,
			].slice(-MAX_ATTENTION_REASONS);
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
		case "setDevServer": {
			const { summary } = action;
			const taskDevServers = new Map(state.taskDevServers);
			// A task with no dev script has nothing to show and nothing to act on —
			// keeping an entry would only make the card ask about it every render.
			if (!summary.hasDevScript) taskDevServers.delete(summary.taskId);
			else taskDevServers.set(summary.taskId, summary);
			return { ...state, taskDevServers };
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
