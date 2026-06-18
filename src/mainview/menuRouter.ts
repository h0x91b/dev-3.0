import { api } from "./rpc";
import type { AppState, AppAction, Route } from "./state";
import type { Locale } from "./i18n/types";
import type { TaskStatus } from "../shared/types";

/**
 * Universal dispatch for `application-menu-clicked` events that the bun side
 * forwards through the `menuAction` push channel.
 *
 * Most actions map 1:1 to either a navigation, a CustomEvent (so existing
 * components can hook in without state plumbing), or a backend RPC. Anything
 * that requires task / project context is no-op when the user is not in the
 * matching view — we surface that as a warning in the console; the action item
 * itself is enabled in the menu because the renderer can't tell ahead of time
 * what view the user will be on.
 */

interface RouterCtx {
	state: AppState;
	dispatch: (action: AppAction) => void;
	setLocale: (locale: Locale) => void;
}

function navigate(ctx: RouterCtx, route: Route): void {
	ctx.dispatch({ type: "navigate", route });
}

function currentProjectId(state: AppState): string | undefined {
	const r = state.route;
	if (r.screen === "project" || r.screen === "task" || r.screen === "project-settings" || r.screen === "project-terminal") {
		return r.projectId;
	}
	return undefined;
}

function currentTaskId(state: AppState): string | undefined {
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

function applyTheme(preference: "light" | "dark" | "system"): void {
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	const resolved = preference === "system" ? (prefersDark ? "dark" : "light") : preference;
	document.documentElement.dataset.theme = resolved;
	localStorage.setItem("dev3-theme", preference);
	api.request.setTmuxTheme({ theme: resolved, preference }).catch(() => {});
}

export async function handleMenuAction(action: string, ctx: RouterCtx): Promise<void> {
	const { state } = ctx;

	switch (action) {
		// ── App: theme / locale ──
		case "set-theme-light":
			applyTheme("light");
			return;
		case "set-theme-dark":
			applyTheme("dark");
			return;
		case "set-theme-auto":
			applyTheme("system");
			return;
		case "set-locale-en":
			ctx.setLocale("en");
			return;
		case "set-locale-ru":
			ctx.setLocale("ru");
			return;
		case "set-locale-es":
			ctx.setLocale("es");
			return;

		// ── View navigation ──
		case "view-dashboard":
			navigate(ctx, { screen: "dashboard" });
			return;
		case "view-kanban": {
			const projectId = currentProjectId(state);
			if (projectId) navigate(ctx, { screen: "project", projectId });
			else navigate(ctx, { screen: "dashboard" });
			return;
		}
		case "view-changelog":
			navigate(ctx, { screen: "changelog" });
			return;
		case "open-settings":
			navigate(ctx, { screen: "settings" });
			return;
		case "go-back":
			ctx.dispatch({ type: "goBack" });
			return;
		case "go-forward":
			ctx.dispatch({ type: "goForward" });
			return;

		// ── Create flows — open the App-owned modals via CustomEvent ──
		case "open-new-task":
			window.dispatchEvent(new CustomEvent("menu:open-new-task"));
			return;
		case "open-add-project":
			window.dispatchEvent(new CustomEvent("menu:open-add-project"));
			return;

		// ── Project: navigation ──
		case "project-settings": {
			const projectId = currentProjectId(state);
			if (projectId) navigate(ctx, { screen: "project-settings", projectId });
			return;
		}

		// ── Project: git ──
		case "project-pull-main": {
			const projectId = currentProjectId(state);
			if (!projectId) return;
			try {
				await api.request.pullProjectMain({ projectId });
			} catch (err) {
				console.error("[menu] pullProjectMain failed", err);
			}
			return;
		}
		case "project-create-pr": {
			const projectId = currentProjectId(state);
			const taskId = currentTaskId(state);
			if (!projectId || !taskId) return;
			try {
				await api.request.createPullRequest({ taskId, projectId });
			} catch (err) {
				console.error("[menu] createPullRequest failed", err);
			}
			return;
		}

		// ── Project: dev server ──
		case "project-dev-server-start": {
			const projectId = currentProjectId(state);
			const taskId = currentTaskId(state);
			if (!projectId || !taskId) return;
			try {
				await api.request.runDevServer({ taskId, projectId });
			} catch (err) {
				console.error("[menu] runDevServer failed", err);
			}
			return;
		}
		case "project-dev-server-stop": {
			const projectId = currentProjectId(state);
			const taskId = currentTaskId(state);
			if (!projectId || !taskId) return;
			try {
				await api.request.stopDevServer({ taskId, projectId });
			} catch (err) {
				console.error("[menu] stopDevServer failed", err);
			}
			return;
		}
		case "project-dev-server-restart": {
			const projectId = currentProjectId(state);
			const taskId = currentTaskId(state);
			if (!projectId || !taskId) return;
			try {
				await api.request.stopDevServer({ taskId, projectId });
				await api.request.runDevServer({ taskId, projectId });
			} catch (err) {
				console.error("[menu] dev server restart failed", err);
			}
			return;
		}
		case "project-dev-server-status": {
			const projectId = currentProjectId(state);
			const taskId = currentTaskId(state);
			if (!projectId || !taskId) return;
			try {
				const status = await api.request.getDevServerStatus({ taskId, projectId });
				// surface via custom event so the renderer can show a toast in a follow-up commit
				window.dispatchEvent(new CustomEvent("menu:dev-server-status", { detail: status }));
			} catch (err) {
				console.error("[menu] getDevServerStatus failed", err);
			}
			return;
		}

		// ── Task: watch toggle ──
		case "task-toggle-watch": {
			const projectId = currentProjectId(state);
			const task = currentTask(state);
			if (!projectId || !task) return;
			try {
				await api.request.toggleTaskWatch({ taskId: task.id, projectId, watched: !task.watched });
			} catch (err) {
				console.error("[menu] toggleTaskWatch failed", err);
			}
			return;
		}

		// ── Task: lifecycle moves (safe statuses only; destructive
		// complete/cancel are intentionally not palette/menu quick-actions) ──
		case "task-move-todo":
		case "task-move-in-progress":
		case "task-move-user-questions":
		case "task-move-review-ai":
		case "task-move-review-user": {
			const projectId = currentProjectId(state);
			const taskId = currentTaskId(state);
			if (!projectId || !taskId) return;
			try {
				await api.request.moveTask({ taskId, projectId, newStatus: TASK_MOVE_STATUS[action] });
			} catch (err) {
				console.error(`[menu] moveTask(${TASK_MOVE_STATUS[action]}) failed`, err);
			}
			return;
		}

		// ── Task: scripts ──
		case "task-run-script": {
			const taskId = currentTaskId(state);
			if (!taskId) return;
			window.dispatchEvent(new CustomEvent("menu:task-run-script", { detail: { taskId } }));
			return;
		}
		// ── Task: backend ops we can run with just an id ──
		case "task-open-in-finder": {
			const task = currentTask(state);
			if (!task?.worktreePath) return;
			try {
				await api.request.openFolder({ path: task.worktreePath });
			} catch (err) {
				console.error("[menu] openFolder failed", err);
			}
			return;
		}
		case "task-copy-worktree-path": {
			const task = currentTask(state);
			if (!task?.worktreePath) return;
			try {
				await navigator.clipboard.writeText(task.worktreePath);
			} catch (err) {
				console.error("[menu] clipboard.writeText failed", err);
			}
			return;
		}

		// ── Terminal: pane ops piggy-back on tmuxAction (taskId required) ──
		case "term-split-h":
		case "term-split-v":
		case "term-zoom-pane":
		case "term-close-pane":
		case "term-layout-tiled":
		case "term-layout-even-h":
		case "term-layout-even-v":
		case "term-layout-main-h":
		case "term-layout-main-v":
		case "term-layout-cycle": {
			const taskId = currentTaskId(state);
			if (!taskId) return;
			const tmuxAction = TMUX_ACTION_MAP[action];
			try {
				await api.request.tmuxAction({ taskId, action: tmuxAction });
			} catch (err) {
				console.error(`[menu] tmuxAction(${tmuxAction}) failed`, err);
			}
			return;
		}

		// ── Terminal: open the project / home terminal screen directly ──
		case "term-toggle-project-terminal": {
			const projectId = currentProjectId(state);
			if (projectId) navigate(ctx, { screen: "project-terminal", projectId });
			return;
		}
		case "term-toggle-home-terminal":
			navigate(ctx, { screen: "home-terminal" });
			return;

		// ── Cheat sheet modal: open via CustomEvent — App.tsx wires the modal. ──
		case "term-cheat-sheet":
			window.dispatchEvent(new CustomEvent("menu:show-tmux-cheat-sheet"));
			return;

		default:
			console.warn("[menu] Unhandled menu action", action);
	}
}

const TASK_MOVE_STATUS: Record<string, TaskStatus> = {
	"task-move-todo": "todo",
	"task-move-in-progress": "in-progress",
	"task-move-user-questions": "user-questions",
	"task-move-review-ai": "review-by-ai",
	"task-move-review-user": "review-by-user",
};

const TMUX_ACTION_MAP = {
	"term-split-h": "splitH",
	"term-split-v": "splitV",
	"term-zoom-pane": "zoom",
	"term-close-pane": "killPane",
	"term-layout-tiled": "layoutTiled",
	"term-layout-even-h": "layoutEvenH",
	"term-layout-even-v": "layoutEvenV",
	"term-layout-main-h": "layoutMainH",
	"term-layout-main-v": "layoutMainV",
	"term-layout-cycle": "nextLayout",
} as const satisfies Record<string, "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" | "nextLayout" | "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV">;
