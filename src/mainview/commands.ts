import type { TranslationKey } from "./i18n";

/**
 * Registry for the Cmd/Ctrl+Shift+P action palette. Each command is a thin
 * descriptor over an existing `handleMenuAction` action string (see
 * `menuRouter.ts`) — the palette is a DOM mirror of the native application menu,
 * not a second command runner. To add a command: add an entry here AND make sure
 * `handleMenuAction` handles its `id`.
 *
 * Deliberately excluded from the quick palette (UX-canon: destructive actions
 * need friction, not a fuzzy-Enter away): task delete / cancel / complete, and
 * modal/inline flows (rename, set-overview, add-note, spawn-variants, duplicate).
 * Those keep living on their own surfaces (inspector, context menu, native menu).
 */

export type CommandCategory = "app" | "create" | "nav" | "git" | "devserver" | "task" | "terminal";

/** What context a command needs to be runnable in the current route. */
export type CommandScope = "always" | "project" | "task";

export interface PaletteCommand {
	/** The `handleMenuAction` action string this command dispatches. */
	id: string;
	/** i18n key for the human label shown (and fuzzy-matched) in the palette. */
	labelKey: TranslationKey;
	category: CommandCategory;
	scope: CommandScope;
}

export const COMMAND_CATEGORY_KEY: Record<CommandCategory, TranslationKey> = {
	app: "command.category.app",
	create: "command.category.create",
	nav: "command.category.nav",
	git: "command.category.git",
	devserver: "command.category.devserver",
	task: "command.category.task",
	terminal: "command.category.terminal",
};

export const ALL_COMMANDS: PaletteCommand[] = [
	// ── Create ──
	{ id: "open-new-task", labelKey: "command.newTask", category: "create", scope: "always" },
	{ id: "open-add-project", labelKey: "command.addProject", category: "create", scope: "always" },

	// ── Navigation ──
	{ id: "view-dashboard", labelKey: "command.viewDashboard", category: "nav", scope: "always" },
	{ id: "view-kanban", labelKey: "command.viewKanban", category: "nav", scope: "project" },
	{ id: "view-changelog", labelKey: "command.viewChangelog", category: "nav", scope: "always" },
	{ id: "open-settings", labelKey: "command.openSettings", category: "nav", scope: "always" },
	{ id: "project-settings", labelKey: "command.projectSettings", category: "nav", scope: "project" },
	{ id: "go-back", labelKey: "command.goBack", category: "nav", scope: "always" },
	{ id: "go-forward", labelKey: "command.goForward", category: "nav", scope: "always" },

	// ── App: theme / locale ──
	{ id: "set-theme-light", labelKey: "command.themeLight", category: "app", scope: "always" },
	{ id: "set-theme-dark", labelKey: "command.themeDark", category: "app", scope: "always" },
	{ id: "set-theme-auto", labelKey: "command.themeAuto", category: "app", scope: "always" },
	{ id: "set-locale-en", labelKey: "command.localeEn", category: "app", scope: "always" },
	{ id: "set-locale-ru", labelKey: "command.localeRu", category: "app", scope: "always" },
	{ id: "set-locale-es", labelKey: "command.localeEs", category: "app", scope: "always" },

	// ── Git ──
	{ id: "project-pull-main", labelKey: "command.pullMain", category: "git", scope: "project" },
	{ id: "project-create-pr", labelKey: "command.createPr", category: "git", scope: "task" },

	// ── Dev server ──
	{ id: "project-dev-server-start", labelKey: "command.devServerStart", category: "devserver", scope: "task" },
	{ id: "project-dev-server-stop", labelKey: "command.devServerStop", category: "devserver", scope: "task" },
	{ id: "project-dev-server-restart", labelKey: "command.devServerRestart", category: "devserver", scope: "task" },
	{ id: "project-dev-server-status", labelKey: "command.devServerStatus", category: "devserver", scope: "task" },

	// ── Task (safe, non-destructive) ──
	{ id: "task-toggle-watch", labelKey: "command.toggleWatch", category: "task", scope: "task" },
	{ id: "task-open-in-finder", labelKey: "command.openInFinder", category: "task", scope: "task" },
	{ id: "task-copy-worktree-path", labelKey: "command.copyWorktreePath", category: "task", scope: "task" },
	{ id: "task-run-script", labelKey: "command.runScript", category: "task", scope: "task" },
	{ id: "task-move-todo", labelKey: "command.moveToDo", category: "task", scope: "task" },
	{ id: "task-move-in-progress", labelKey: "command.moveInProgress", category: "task", scope: "task" },
	{ id: "task-move-user-questions", labelKey: "command.moveUserQuestions", category: "task", scope: "task" },
	{ id: "task-move-review-ai", labelKey: "command.moveReviewAi", category: "task", scope: "task" },
	{ id: "task-move-review-user", labelKey: "command.moveReviewUser", category: "task", scope: "task" },

	// ── Terminal ──
	{ id: "term-toggle-project-terminal", labelKey: "command.openProjectTerminal", category: "terminal", scope: "project" },
	{ id: "term-open-quick-shell", labelKey: "command.openQuickShell", category: "terminal", scope: "always" },
	{ id: "term-cheat-sheet", labelKey: "command.tmuxCheatSheet", category: "terminal", scope: "always" },
	{ id: "help-keyboard-shortcuts", labelKey: "command.keyboardShortcuts", category: "app", scope: "always" },
];

export interface CommandContext {
	hasProject: boolean;
	hasTask: boolean;
	/**
	 * The current project is a virtual ("Operations") board, which has no git,
	 * dev server, setup/run scripts, or project terminal (its synthetic path is
	 * created lazily per-task and has no repo). Those command categories are
	 * hidden so the palette matches the inspector (which already hides the same
	 * affordances) and to avoid the "Project path does not exist" crash.
	 */
	isVirtual?: boolean;
}

/** Commands runnable in the current route context, in registry order. */
export function availableCommands(ctx: CommandContext): PaletteCommand[] {
	return ALL_COMMANDS.filter((c) => {
		if (
			ctx.isVirtual &&
			(c.category === "git" ||
				c.category === "devserver" ||
				c.id === "task-run-script" ||
				c.id === "term-toggle-project-terminal")
		) {
			return false;
		}
		if (c.scope === "task") return ctx.hasTask;
		if (c.scope === "project") return ctx.hasProject;
		return true;
	});
}
