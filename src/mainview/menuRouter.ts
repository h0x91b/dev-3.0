import { api } from "./rpc";
import { startClosePanePicker } from "./close-pane-picker";
import { openAgentTrafficLog } from "./agent-traffic-events";
import { toast } from "./toast";
import { playTaskCompletionSound, taskSoundDiagnostics } from "./task-sounds";
import type { TaskStatus } from "../shared/types";
import type { TaskPaneAction } from "../shared/task-panes";
import { parseBoardViewAction } from "./board-views/view-commands";
import {
	applyTheme,
	copyTaskWorktreePath,
	createPullRequest,
	currentTaskId,
	emitAppEvent,
	importConversations,
	moveCurrentTask,
	navigateTo,
	openBoard,
	openBoardView,
	openProjectSettings,
	openProjectTerminal,
	openSessions,
	openLibrary,
	openTaskInFinder,
	pullProjectMain,
	runDevServerOp,
	runTaskScript,
	toggleFileExplorerForRoute,
	toggleTaskWatch,
	type AppActionContext,
} from "./app-actions";
import { reloadPage } from "./tab-close-guard";
import { toggleFullscreen } from "./fullscreen";

/** The browser menu bar's stand-in for the native `toggleFullScreen` role. */
export const BROWSER_TOGGLE_FULLSCREEN_ACTION = "toggle-fullscreen";

/**
 * Dispatch for native menu actions: the bun side forwards `application-menu-clicked`
 * and swipe navigation through the `menuAction` push channel, and the browser-mode
 * menu bar calls it directly. The command palette does not route through here —
 * each palette command carries its own `run()` (`commands/builtins.ts`); both reach
 * the same code in `app-actions.ts`.
 *
 * An action that needs task / project context is a no-op outside the matching
 * view; the menu item stays enabled because the renderer can't tell ahead of time
 * what view the user will be on.
 */
export async function handleMenuAction(action: string, ctx: AppActionContext): Promise<void> {
	const boardViewId = parseBoardViewAction(action);
	if (boardViewId) {
		openBoardView(ctx, boardViewId);
		return;
	}

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

		// ── App: About / hard refresh ──
		// On desktop these are handled by the bun `application-menu-clicked`
		// handler and never reach the renderer. In browser (Remote Access) mode
		// there is no bun handler in the click path, so the React menu bar routes
		// them here directly.
		case "about": {
			try {
				const { version, buildChannel } = await api.request.getAppVersion();
				emitAppEvent("rpc:showAbout", { version, buildChannel });
			} catch (err) {
				console.error("[menu] getAppVersion failed", err);
			}
			return;
		}
		case "hard-refresh":
			reloadPage();
			return;
		// Browser menu bar only: element fullscreen, which is what lets Keyboard
		// Lock hand ⌘W / Ctrl+W to the page. The native menu keeps its own role.
		case BROWSER_TOGGLE_FULLSCREEN_ACTION:
			void toggleFullscreen();
			return;

		// ── Debug screens (browser equivalents of the bun navigate-to-* pushes) ──
		case "feature-flags":
			emitAppEvent("rpc:showFeatureFlags");
			return;
		case "terminal-perf-overlay":
			emitAppEvent("rpc:toggleTerminalPerf");
			return;
		case "gauge-demo":
			navigateTo(ctx, { screen: "gauge-demo" });
			return;
		case "viewport-lab":
			navigateTo(ctx, { screen: "viewport-lab" });
			return;
		case "native-pane-layout-lab":
			navigateTo(ctx, { screen: "native-pane-layout-lab" });
			return;

		// ── Debug: task-sound probes ──
		// Deliberately the same calls the real flows make, so a silent chime here
		// means the pipeline is broken, not the trigger. The toast is raw
		// diagnostics (like terminal output), not localized product copy.
		case "debug-play-sound-completed":
		case "debug-play-sound-cancelled": {
			const status = action === "debug-play-sound-completed" ? "completed" : "cancelled";
			playTaskCompletionSound(status);
			// `play()` resolves or rejects asynchronously, so a same-tick snapshot
			// would report the previous attempt's verdict.
			await new Promise((resolve) => setTimeout(resolve, 300));
			const probe = taskSoundDiagnostics();
			const outcome = !probe.enabled
				? "skipped — setting off"
				: probe.blocked
					? "refused by autoplay policy — queued until the next click"
					: "playing";
			const line = `sound ${status}: ${outcome} · queued ${probe.queued}`;
			console.info("[menu][sound-probe]", line);
			toast.info(line, { source: "menu" });
			return;
		}
		case "debug-push-sound-completed": {
			const { pushed } = await api.request.debugEmitTaskSound({ status: "completed" });
			const line = `backend taskSound push: ${pushed ? "sent" : "suppressed — setting off"}`;
			console.info("[menu][sound-probe]", line);
			toast.info(line, { source: "menu" });
			return;
		}

		// ── Help: external links (bun uses Utils.openExternal; browser uses window.open) ──
		case "help-documentation":
			window.open("https://h0x91b.github.io/dev-3.0/", "_blank", "noopener,noreferrer");
			return;
		case "help-github":
			window.open("https://github.com/h0x91b/dev-3.0", "_blank", "noopener,noreferrer");
			return;
		case "help-report-bug":
			window.open("https://github.com/h0x91b/dev-3.0/issues/new", "_blank", "noopener,noreferrer");
			return;

		// ── View navigation ──
		case "view-dashboard":
			navigateTo(ctx, { screen: "dashboard" });
			return;
		case "view-board":
			openBoard(ctx);
			return;
		case "view-changelog":
			navigateTo(ctx, { screen: "changelog" });
			return;
		case "view-stats":
			navigateTo(ctx, { screen: "stats" });
			return;
		case "view-sessions":
			openSessions(ctx);
			return;
		case "view-library":
			openLibrary(ctx);
			return;
		case "open-settings":
			navigateTo(ctx, { screen: "settings" });
			return;
		case "go-back":
			ctx.dispatch({ type: "goBack" });
			return;
		case "go-forward":
			ctx.dispatch({ type: "goForward" });
			return;

		// ── Create flows and keyboard palettes — App.tsx owns the modals ──
		case "open-new-task":
			emitAppEvent("menu:open-new-task");
			return;
		case "open-add-project":
			emitAppEvent("menu:open-add-project");
			return;
		case "open-project-switch":
			emitAppEvent("menu:open-project-switch");
			return;
		case "open-task-switch":
			emitAppEvent("menu:open-task-switch");
			return;
		case "open-combined-switch":
			emitAppEvent("menu:open-combined-switch");
			return;
		case "open-command-palette":
			emitAppEvent("menu:open-command-palette");
			return;

		// ── Project ──
		case "project-settings":
			openProjectSettings(ctx);
			return;
		case "project-import-conversations":
			importConversations(ctx);
			return;
		case "project-pull-main":
			await pullProjectMain(ctx);
			return;
		case "project-create-pr":
			await createPullRequest(ctx);
			return;
		case "project-dev-server-start":
			await runDevServerOp(ctx, "start");
			return;
		case "project-dev-server-stop":
			await runDevServerOp(ctx, "stop");
			return;
		case "project-dev-server-restart":
			await runDevServerOp(ctx, "restart");
			return;
		case "project-dev-server-status":
			await runDevServerOp(ctx, "status");
			return;

		// ── Task ──
		case "task-toggle-watch":
			await toggleTaskWatch(ctx);
			return;
		case "task-mark-completed":
			await moveCurrentTask(ctx, "completed", true);
			return;
		case "task-mark-cancelled":
			await moveCurrentTask(ctx, "cancelled", true);
			return;
		case "task-move-todo":
		case "task-move-in-progress":
		case "task-move-user-questions":
		case "task-move-review-ai":
		case "task-move-review-user":
			await moveCurrentTask(ctx, TASK_MOVE_STATUS[action]);
			return;
		case "task-run-script":
			runTaskScript(ctx);
			return;
		case "task-open-in-finder":
			await openTaskInFinder(ctx);
			return;
		case "task-copy-worktree-path":
			await copyTaskWorktreePath(ctx);
			return;

		// ── Terminal: pane ops via taskPaneAction (taskId required) ──
		case "term-close-pane": {
			// Close Pane opens the two-step visual picker (overlay in TaskTerminal),
			// matching the toolbar button. Desktop-only menu → no narrow fallback.
			const taskId = currentTaskId(ctx.state);
			if (!taskId) return;
			startClosePanePicker(taskId);
			return;
		}
		case "term-split-h":
		case "term-split-v":
		case "term-zoom-pane":
		case "term-swap-next":
		case "term-swap-prev":
		case "term-layout-tiled":
		case "term-layout-even-h":
		case "term-layout-even-v":
		case "term-layout-main-h":
		case "term-layout-main-v":
		case "term-layout-cycle": {
			const taskId = currentTaskId(ctx.state);
			if (!taskId) return;
			const paneAction = PANE_ACTION_MAP[action];
			try {
				await api.request.taskPaneAction({ taskId, action: paneAction });
			} catch (err) {
				console.error(`[menu] taskPaneAction(${action}) failed`, err);
			}
			return;
		}
		case "term-toggle-project-terminal":
			openProjectTerminal(ctx);
			return;
		case "term-open-quick-shell":
			emitAppEvent("menu:open-quick-shell");
			return;

		// ── Overlays App.tsx wires ──
		case "term-cheat-sheet":
			emitAppEvent("menu:show-tmux-cheat-sheet");
			return;
		case "view-agent-traffic-log":
			openAgentTrafficLog();
			return;
		case "view-toggle-file-explorer":
			toggleFileExplorerForRoute(ctx);
			return;
		case "help-keyboard-shortcuts":
			emitAppEvent("menu:show-keyboard-shortcuts");
			return;
		case "update-popover-preview":
			emitAppEvent("menu:show-update-popover-preview");
			return;
		case "help-explain-screen":
			emitAppEvent("menu:enter-help-mode");
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

/**
 * Every action string `handleMenuAction` can actually execute. The browser-mode
 * menu bar (`AppMenuBar.tsx`) uses this as the source of truth for which menu
 * items are live: an item whose action is NOT in this set cannot run in the
 * browser (it is handled only by the bun-side `application-menu-clicked` handler
 * — e.g. new-window, check-for-updates, devtools, zoom, open-logs, remote-QR),
 * so the menu bar hides it. Keep this in lockstep with the `switch` above; a
 * unit test guards a representative slice against drift.
 */
export const BROWSER_HANDLED_ACTIONS: ReadonlySet<string> = new Set<string>([
	// App
	"set-theme-light", "set-theme-dark", "set-theme-auto",
	"set-locale-en", "set-locale-ru", "set-locale-es",
	"about", "hard-refresh", BROWSER_TOGGLE_FULLSCREEN_ACTION,
	// View / navigation
	"view-dashboard", "view-board",
	"view-board:builtin:kanban", "view-board:builtin:table", "view-board:builtin:tree", "view-board:builtin:attention",
	"view-changelog", "view-stats", "view-sessions", "view-library", "open-settings",
	// The traffic log is a renderer overlay, so it works in a browser tab too — it
	// was only ever missing here, which left remote users on ⇧⌘M and the palette.
	"view-agent-traffic-log",
	"view-toggle-file-explorer",
	"go-back", "go-forward", "gauge-demo", "viewport-lab", "native-pane-layout-lab", "update-popover-preview", "feature-flags",
	"terminal-perf-overlay",
	"debug-play-sound-completed", "debug-play-sound-cancelled", "debug-push-sound-completed",
	"open-new-task", "open-add-project", "open-project-switch", "open-task-switch", "open-combined-switch", "open-command-palette",
	// Project
	"project-settings", "project-import-conversations", "project-pull-main", "project-create-pr",
	"project-dev-server-start", "project-dev-server-stop", "project-dev-server-restart", "project-dev-server-status",
	// Task (safe, non-destructive)
	"task-toggle-watch", "task-run-script", "task-open-in-finder", "task-copy-worktree-path",
	"task-move-todo", "task-move-in-progress", "task-move-user-questions", "task-move-review-ai", "task-move-review-user",
	// Destructive, but always behind the terminal-move confirmation.
	"task-mark-completed", "task-mark-cancelled",
	// Terminal
	"term-split-h", "term-split-v", "term-zoom-pane", "term-close-pane", "term-swap-next", "term-swap-prev",
	"term-layout-tiled", "term-layout-even-h", "term-layout-even-v", "term-layout-main-h", "term-layout-main-v", "term-layout-cycle",
	"term-toggle-project-terminal", "term-open-quick-shell", "term-cheat-sheet",
	// Help
	"help-keyboard-shortcuts", "help-explain-screen", "help-documentation", "help-github", "help-report-bug",
]);

const PANE_ACTION_MAP: Record<string, TaskPaneAction> = {
	"term-split-h": { kind: "splitH" },
	"term-split-v": { kind: "splitV" },
	"term-zoom-pane": { kind: "zoom", mode: "toggle" },
	"term-swap-next": { kind: "swapStep", step: "next" },
	"term-swap-prev": { kind: "swapStep", step: "prev" },
	"term-layout-tiled": { kind: "layoutPreset", preset: "tiled" },
	"term-layout-even-h": { kind: "layoutPreset", preset: "evenH" },
	"term-layout-even-v": { kind: "layoutPreset", preset: "evenV" },
	"term-layout-main-h": { kind: "layoutPreset", preset: "mainH" },
	"term-layout-main-v": { kind: "layoutPreset", preset: "mainV" },
	"term-layout-cycle": { kind: "layoutCycle" },
};
