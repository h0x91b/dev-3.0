import { api } from "./rpc";
import { showFileExplorer, toggleFileExplorer } from "./file-explorer-prefs";
import { moveTaskToStatus } from "./utils/moveTaskToStatus";
import { isBoardMounted, runBoardViewCommand } from "./board-views/view-commands";
import type { TFunction } from "./i18n";
import type { AppState, AppAction, Route } from "./state";
import type { Locale } from "./i18n/types";
import type { TaskStatus } from "../shared/types";
import { applyThemeToDocument } from "./theme-bootstrap";

/**
 * The actions the native menu and the command palette share. Each one reads the
 * route it runs in and does nothing where it has no target, so a stale menu item
 * or palette row can never act on the wrong task.
 */
export interface AppActionContext {
	state: AppState;
	dispatch: (action: AppAction) => void;
	setLocale: (locale: Locale) => void;
	/** Needed by the shared move helper for its confirmation copy and toasts. */
	t: TFunction;
}

export function navigateTo(ctx: AppActionContext, route: Route): void {
	ctx.dispatch({ type: "navigate", route });
}

export function currentProjectId(state: AppState): string | undefined {
	const r = state.route;
	if (r.screen === "project" || r.screen === "task" || r.screen === "project-settings" || r.screen === "project-terminal") {
		return r.projectId;
	}
	return undefined;
}

export function currentTaskId(state: AppState): string | undefined {
	const r = state.route;
	if (r.screen === "task") return r.taskId;
	if (r.screen === "project" && r.activeTaskId) return r.activeTaskId;
	return undefined;
}

function currentTask(state: AppState) {
	const taskId = currentTaskId(state);
	if (!taskId) return undefined;
	return state.currentProjectTasks.find((t) => t.id === taskId);
}

function currentProject(state: AppState) {
	const projectId = currentProjectId(state);
	return state.projects?.find((p) => p.id === projectId);
}

/** App-owned modals and overlays open through a window event; App.tsx listens. */
export function emitAppEvent(name: string, detail?: unknown): void {
	window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
}

export function applyTheme(preference: "light" | "dark" | "system"): void {
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	const resolved = preference === "system" ? (prefersDark ? "dark" : "light") : preference;
	applyThemeToDocument(preference, resolved);
	localStorage.setItem("dev3-theme", preference);
	api.request.setTmuxTheme({ theme: resolved, preference }).catch(() => {});
}

/** The board the current route belongs to, the space board included; null off a project. */
function boardRouteFor(state: AppState): Route | null {
	const r = state.route;
	const projectId = currentProjectId(state);
	if (!projectId) return null;
	const spaceId = r.screen === "project" || r.screen === "task" ? r.spaceId : undefined;
	return spaceId ? { screen: "project", projectId, spaceId } : { screen: "project", projectId };
}

export function openBoard(ctx: AppActionContext): void {
	navigateTo(ctx, boardRouteFor(ctx.state) ?? { screen: "dashboard" });
}

/** On a board this only switches the view; anywhere else it opens the board first. */
export function openBoardView(ctx: AppActionContext, viewId: string): void {
	if (!isBoardMounted()) {
		const board = boardRouteFor(ctx.state);
		if (!board) return;
		navigateTo(ctx, board);
	}
	runBoardViewCommand({ kind: "pick", viewId });
}

export function openSessions(ctx: AppActionContext): void {
	const projectId = currentProjectId(ctx.state);
	navigateTo(ctx, projectId ? { screen: "sessions", scopeProjectId: projectId } : { screen: "sessions" });
}

export function openLibrary(ctx: AppActionContext): void {
	const projectId = currentProjectId(ctx.state);
	navigateTo(ctx, projectId ? { screen: "library", scopeProjectId: projectId } : { screen: "library" });
}

export function openProjectSettings(ctx: AppActionContext): void {
	const projectId = currentProjectId(ctx.state);
	if (projectId) navigateTo(ctx, { screen: "project-settings", projectId });
}

export function importConversations(ctx: AppActionContext): void {
	const projectId = currentProjectId(ctx.state);
	if (projectId) emitAppEvent("menu:import-conversations", { projectId });
}

export async function pullProjectMain(ctx: AppActionContext): Promise<void> {
	const projectId = currentProjectId(ctx.state);
	if (!projectId) return;
	try {
		await api.request.pullProjectMain({ projectId });
	} catch (err) {
		console.error("[menu] pullProjectMain failed", err);
	}
}

export async function createPullRequest(ctx: AppActionContext): Promise<void> {
	const projectId = currentProjectId(ctx.state);
	const taskId = currentTaskId(ctx.state);
	if (!projectId || !taskId) return;
	try {
		await api.request.createPullRequest({ taskId, projectId });
	} catch (err) {
		console.error("[menu] createPullRequest failed", err);
	}
}

export type DevServerOp = "start" | "stop" | "restart" | "status";

export async function runDevServerOp(ctx: AppActionContext, op: DevServerOp): Promise<void> {
	const projectId = currentProjectId(ctx.state);
	const taskId = currentTaskId(ctx.state);
	if (!projectId || !taskId) return;
	const target = { taskId, projectId };
	try {
		if (op === "stop" || op === "restart") await api.request.stopDevServer(target);
		if (op === "start" || op === "restart") await api.request.runDevServer({ ...target, focus: true });
		if (op === "status") emitAppEvent("menu:dev-server-status", await api.request.getDevServerStatus(target));
	} catch (err) {
		console.error(`[menu] dev server ${op} failed`, err);
	}
}

export async function toggleTaskWatch(ctx: AppActionContext): Promise<void> {
	const projectId = currentProjectId(ctx.state);
	const task = currentTask(ctx.state);
	if (!projectId || !task) return;
	try {
		await api.request.toggleTaskWatch({ taskId: task.id, projectId, watched: !task.watched });
	} catch (err) {
		console.error("[menu] toggleTaskWatch failed", err);
	}
}

/**
 * Routed through the same helper the board uses, so the chime, the optimistic
 * update and every confirmation are identical. Terminal moves pass
 * `alwaysConfirm`: a menu entry is as easy to mis-hit as the card's one-click ✓.
 */
export async function moveCurrentTask(ctx: AppActionContext, newStatus: TaskStatus, alwaysConfirm?: boolean): Promise<void> {
	const task = currentTask(ctx.state);
	const project = currentProject(ctx.state);
	if (!task || !project) return;
	await moveTaskToStatus({ task, project, newStatus, dispatch: ctx.dispatch, t: ctx.t, ...(alwaysConfirm ? { alwaysConfirm } : {}) });
}

export function runTaskScript(ctx: AppActionContext): void {
	const taskId = currentTaskId(ctx.state);
	if (taskId) emitAppEvent("menu:task-run-script", { taskId });
}

export async function openTaskInFinder(ctx: AppActionContext): Promise<void> {
	const task = currentTask(ctx.state);
	if (!task?.worktreePath) return;
	try {
		await api.request.openFolder({ path: task.worktreePath });
	} catch (err) {
		console.error("[menu] openFolder failed", err);
	}
}

export async function copyTaskWorktreePath(ctx: AppActionContext): Promise<void> {
	const task = currentTask(ctx.state);
	if (!task?.worktreePath) return;
	try {
		await navigator.clipboard.writeText(task.worktreePath);
	} catch (err) {
		console.error("[menu] clipboard.writeText failed", err);
	}
}

/**
 * Virtual ("Operations") boards have no project terminal: their synthetic path is
 * created lazily per task, so opening one throws "Project path does not exist".
 */
export function openProjectTerminal(ctx: AppActionContext): void {
	const projectId = currentProjectId(ctx.state);
	if (projectId && currentProject(ctx.state)?.kind !== "virtual") navigateTo(ctx, { screen: "project-terminal", projectId });
}

/**
 * The explorer lives beside a terminal: a task's, or the project's own on the
 * Repo screen. From a plain board the toggle takes you to Repo with the tree
 * shown; where there is no terminal to sit beside, it does nothing.
 */
export function toggleFileExplorerForRoute(ctx: AppActionContext): void {
	const r = ctx.state.route;
	if (r.screen === "task" || r.screen === "project-terminal" || (r.screen === "project" && r.activeTaskId)) {
		toggleFileExplorer();
		return;
	}
	if (r.screen !== "project" || r.spaceId || r.taskView) return;
	if (ctx.state.projects.find((p) => p.id === r.projectId)?.kind === "virtual") return;
	showFileExplorer();
	navigateTo(ctx, { screen: "project-terminal", projectId: r.projectId });
}
