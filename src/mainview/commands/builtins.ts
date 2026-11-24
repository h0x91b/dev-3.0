import type { Context, Fiber } from "cordis";
import type { BuiltinPlugin } from "../plugins/runtime";
import { getAgentTrafficEnabled } from "../agent-traffic-flag";
import { openAgentTrafficLog } from "../agent-traffic-events";
import { isControlHidden } from "../hidden-controls";
import { toggleStreamerMode } from "../streamer-mode";
import {
	applyTheme,
	copyTaskWorktreePath,
	createPullRequest,
	emitAppEvent,
	importConversations,
	moveCurrentTask,
	navigateTo,
	openBoard,
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
} from "../app-actions";
// Defines the slot before the plugin injects it.
import "./registry";
import type { CommandItem } from "./registry";

type BuiltinCommand = Omit<CommandItem, "id" | "order"> & { name: string };

/**
 * The palette's own commands, in palette order. Deliberately absent (UX canon:
 * destructive actions need friction, not a fuzzy-Enter away): task delete /
 * cancel / complete, and modal or inline flows (rename, set-overview, add-note,
 * spawn-variants, duplicate). Those live on their own surfaces.
 */
const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
	// ── Create ──
	{ name: "open-new-task", shortcutId: "new-task", labelKey: "command.newTask", category: "create", scope: "always", run: () => emitAppEvent("menu:open-new-task") },
	{ name: "open-add-project", shortcutId: "add-project", labelKey: "command.addProject", category: "create", scope: "always", run: () => emitAppEvent("menu:open-add-project") },

	// ── Import ──
	{ name: "project-import-conversations", labelKey: "command.importConversations", category: "import", scope: "project", run: importConversations },

	// ── App: help ──
	{ name: "help-explain-screen", shortcutId: "help-mode", labelKey: "keymap.shortcut.helpMode", category: "app", scope: "always", run: () => emitAppEvent("menu:enter-help-mode") },

	// ── Navigation ──
	{ name: "view-dashboard", labelKey: "command.viewDashboard", category: "nav", scope: "always", run: (ctx) => navigateTo(ctx, { screen: "dashboard" }) },
	// The board-view commands are listed right after this one (`BOARD_COMMAND_ID`).
	{ name: "view-board", labelKey: "command.viewBoard", category: "nav", scope: "project", run: openBoard },
	// A cross-project picker, so it needs no current project.
	{ name: "find-coordinator", labelKey: "command.findCoordinator", category: "nav", scope: "always", run: () => emitAppEvent("menu:open-coordinator-finder") },
	// The "Go to" palette's task / combined modes; projects mode keeps its own ⇧⌘K.
	{ name: "open-task-switch", shortcutId: "go-to-task", labelKey: "command.goToTask", category: "nav", scope: "always", run: () => emitAppEvent("menu:open-task-switch") },
	{ name: "open-combined-switch", shortcutId: "go-to-combined", labelKey: "command.goToCombined", category: "nav", scope: "always", run: () => emitAppEvent("menu:open-combined-switch") },
	{ name: "view-changelog", labelKey: "command.viewChangelog", category: "nav", scope: "always", run: (ctx) => navigateTo(ctx, { screen: "changelog" }) },
	{
		name: "view-stats",
		labelKey: "command.openStats",
		category: "nav",
		scope: "always",
		// Hidden everywhere, palette included, while the Stats nav entry is (Simplify View).
		when: () => !isControlHidden("stats-nav"),
		run: (ctx) => navigateTo(ctx, { screen: "stats" }),
	},
	{ name: "view-sessions", labelKey: "command.openSessions", category: "nav", scope: "always", run: openSessions },
	{ name: "view-library", labelKey: "command.openLibrary", category: "nav", scope: "always", run: openLibrary },
	{ name: "open-settings", shortcutId: "settings", labelKey: "command.openSettings", category: "nav", scope: "always", run: (ctx) => navigateTo(ctx, { screen: "settings" }) },
	{ name: "project-settings", labelKey: "command.projectSettings", category: "nav", scope: "project", run: openProjectSettings },
	{ name: "go-back", shortcutId: "back", labelKey: "command.goBack", category: "nav", scope: "always", run: (ctx) => ctx.dispatch({ type: "goBack" }) },
	{ name: "go-forward", shortcutId: "forward", labelKey: "command.goForward", category: "nav", scope: "always", run: (ctx) => ctx.dispatch({ type: "goForward" }) },

	// ── App: theme / locale ──
	{ name: "set-theme-light", labelKey: "command.themeLight", category: "app", scope: "always", run: () => applyTheme("light") },
	{ name: "set-theme-dark", labelKey: "command.themeDark", category: "app", scope: "always", run: () => applyTheme("dark") },
	{ name: "set-theme-auto", labelKey: "command.themeAuto", category: "app", scope: "always", run: () => applyTheme("system") },
	{ name: "set-locale-en", labelKey: "command.localeEn", category: "app", scope: "always", run: (ctx) => ctx.setLocale("en") },
	{ name: "set-locale-ru", labelKey: "command.localeRu", category: "app", scope: "always", run: (ctx) => ctx.setLocale("ru") },
	{ name: "set-locale-es", labelKey: "command.localeEs", category: "app", scope: "always", run: (ctx) => ctx.setLocale("es") },
	{ name: "toggle-streamer-mode", labelKey: "command.toggleStreamerMode", category: "app", scope: "always", run: () => void toggleStreamerMode() },

	// ── Git ──
	{ name: "project-pull-main", labelKey: "command.pullMain", category: "git", scope: "project", run: pullProjectMain },
	{ name: "project-create-pr", labelKey: "command.createPr", category: "git", scope: "task", run: createPullRequest },

	// ── Dev server ──
	{ name: "project-dev-server-start", labelKey: "command.devServerStart", category: "devserver", scope: "task", run: (ctx) => runDevServerOp(ctx, "start") },
	{ name: "project-dev-server-stop", labelKey: "command.devServerStop", category: "devserver", scope: "task", run: (ctx) => runDevServerOp(ctx, "stop") },
	{ name: "project-dev-server-restart", labelKey: "command.devServerRestart", category: "devserver", scope: "task", run: (ctx) => runDevServerOp(ctx, "restart") },
	{ name: "project-dev-server-status", labelKey: "command.devServerStatus", category: "devserver", scope: "task", run: (ctx) => runDevServerOp(ctx, "status") },

	// ── Task (safe, non-destructive) ──
	{ name: "task-toggle-watch", labelKey: "command.toggleWatch", category: "task", scope: "task", run: toggleTaskWatch },
	// Its effect lands on the server host, so a remote user would see nothing happen.
	{ name: "task-open-in-finder", labelKey: "command.openInFinder", category: "task", scope: "task", when: (c) => !c.remote, run: openTaskInFinder },
	{ name: "task-copy-worktree-path", labelKey: "command.copyWorktreePath", category: "task", scope: "task", run: copyTaskWorktreePath },
	{ name: "task-run-script", labelKey: "command.runScript", category: "task", scope: "task", when: (c) => !c.isVirtual, run: runTaskScript },
	{ name: "task-move-todo", labelKey: "command.moveToDo", category: "task", scope: "task", run: (ctx) => moveCurrentTask(ctx, "todo") },
	{ name: "task-move-in-progress", labelKey: "command.moveInProgress", category: "task", scope: "task", run: (ctx) => moveCurrentTask(ctx, "in-progress") },
	{ name: "task-move-user-questions", labelKey: "command.moveUserQuestions", category: "task", scope: "task", run: (ctx) => moveCurrentTask(ctx, "user-questions") },
	{ name: "task-move-review-ai", labelKey: "command.moveReviewAi", category: "task", scope: "task", run: (ctx) => moveCurrentTask(ctx, "review-by-ai") },
	{ name: "task-move-review-user", labelKey: "command.moveReviewUser", category: "task", scope: "task", run: (ctx) => moveCurrentTask(ctx, "review-by-user") },

	// ── Terminal ──
	{
		name: "term-toggle-project-terminal",
		shortcutId: "toggle-project-terminal",
		labelKey: "command.openProjectTerminal",
		category: "terminal",
		scope: "project",
		when: (c) => !c.isVirtual,
		run: openProjectTerminal,
	},
	// Stays on an Operations board: it is the entry point INTO that board.
	{ name: "term-open-quick-shell", shortcutId: "open-quick-shell", labelKey: "command.openQuickShell", category: "terminal", scope: "always", run: () => emitAppEvent("menu:open-quick-shell") },
	{ name: "term-cheat-sheet", labelKey: "command.tmuxCheatSheet", category: "terminal", scope: "always", run: () => emitAppEvent("menu:show-tmux-cheat-sheet") },
	{ name: "help-keyboard-shortcuts", shortcutId: "keyboard-shortcuts", labelKey: "command.keyboardShortcuts", category: "app", scope: "always", run: () => emitAppEvent("menu:show-keyboard-shortcuts") },
	{
		name: "view-agent-traffic-log",
		shortcutId: "agent-traffic-log",
		labelKey: "command.agentTrafficLog",
		category: "app",
		scope: "project",
		// A beta, off by default, and individually hideable (§5.10): a row that opens nothing is worse than none.
		when: () => getAgentTrafficEnabled() && !isControlHidden("agent-traffic"),
		run: () => openAgentTrafficLog(),
	},
	{ name: "view-toggle-file-explorer", shortcutId: "toggle-file-explorer", labelKey: "command.toggleFileExplorer", category: "app", scope: "project", run: toggleFileExplorerForRoute },
];

export const BUILTIN_COMMANDS_PLUGIN: BuiltinPlugin = {
	id: "builtin:commands",
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: "builtin:commands",
			inject: ["commands"],
			apply(pluginCtx: Context) {
				BUILTIN_COMMANDS.forEach(({ name, ...command }, order) => {
					pluginCtx.commands.register({ ...command, id: `builtin:${name}`, order });
				});
			},
		});
	},
};
