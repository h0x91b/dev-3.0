import type { ApplicationMenuItemConfig } from "electrobun/bun";

/**
 * Canonical action identifiers for the native macOS menu bar.
 *
 * Naming convention: `<domain>-<verb>-<object>` where `<domain>` is one of
 * `task`, `project`, `view`, `term`, `help`. Top-level / standard actions
 * (about, settings, zoom, etc.) skip the domain prefix.
 *
 * Adding a new action: add it here, reference it in the menu builder below,
 * and route it in `src/bun/index.ts` ("application-menu-clicked" handler).
 * Unimplemented items are emitted with `enabled: false` so they appear in the
 * menu as a roadmap but cannot be triggered.
 */
export const MENU_ACTIONS = {
	// ── App menu ──
	about: "about",
	checkForUpdates: "check-for-updates",
	openSettings: "open-settings",
	setThemeLight: "set-theme-light",
	setThemeDark: "set-theme-dark",
	setThemeAuto: "set-theme-auto",
	setLocaleEn: "set-locale-en",
	setLocaleRu: "set-locale-ru",
	setLocaleEs: "set-locale-es",

	// ── File ──
	newWindow: "new-window",
	openNewTask: "open-new-task",
	openAddProject: "open-add-project",
	openCloneRepository: "open-clone-repository",
	revealProjectFolder: "reveal-project-folder",

	// ── Edit (extras, beyond clipboard roles) ──
	findInTasks: "find-in-tasks",
	findInTerminal: "find-in-terminal",

	// ── Task ──
	taskRename: "task-rename",
	taskSetOverview: "task-set-overview",
	taskAddNote: "task-add-note",
	taskMoveToDo: "task-move-todo",
	taskMoveInProgress: "task-move-in-progress",
	taskMoveUserQuestions: "task-move-user-questions",
	taskMoveReviewAi: "task-move-review-ai",
	taskMoveReviewUser: "task-move-review-user",
	taskMarkCompleted: "task-mark-completed",
	taskMarkCancelled: "task-mark-cancelled",
	taskToggleWatch: "task-toggle-watch",
	taskSpawnVariants: "task-spawn-variants",
	taskAddAttempts: "task-add-attempts",
	taskDuplicate: "task-duplicate",
	taskDelete: "task-delete",
	taskOpenInIde: "task-open-in-ide",
	taskOpenInFinder: "task-open-in-finder",
	taskCopyWorktreePath: "task-copy-worktree-path",
	taskRunScript: "task-run-script",

	// ── Project ──
	projectPullMain: "project-pull-main",
	projectPushBranch: "project-push-branch",
	projectCreatePr: "project-create-pr",
	projectMergeToMain: "project-merge-to-main",
	projectRebaseOnMain: "project-rebase-on-main",
	projectShowBranchStatus: "project-show-branch-status",
	projectDevServerStart: "project-dev-server-start",
	projectDevServerStop: "project-dev-server-stop",
	projectDevServerRestart: "project-dev-server-restart",
	projectDevServerStatus: "project-dev-server-status",
	projectSettings: "project-settings",
	projectCustomColumns: "project-custom-columns",
	projectCustomLabels: "project-custom-labels",

	// ── View ──
	openProjectSwitch: "open-project-switch",
	openCommandPalette: "open-command-palette",
	viewDashboard: "view-dashboard",
	viewKanban: "view-kanban",
	viewChangelog: "view-changelog",
	viewStats: "view-stats",
	viewTips: "view-tips",
	zoomIn: "zoom-in",
	zoomOut: "zoom-out",
	zoomReset: "zoom-reset",
	hardRefresh: "hard-refresh",
	toggleDevtools: "toggle-devtools",
	openLogsDirectory: "open-logs-directory",
	gaugeDemo: "gauge-demo",
	viewportLab: "viewport-lab",
	updatePopoverPreview: "update-popover-preview",

	// ── Terminal — pane ──
	termSplitH: "term-split-h",
	termSplitV: "term-split-v",
	termClosePane: "term-close-pane",
	termZoomPane: "term-zoom-pane",
	termShowPaneNumbers: "term-show-pane-numbers",
	termSetPaneTitle: "term-set-pane-title",
	termLastPane: "term-last-pane",
	termSelectNext: "term-select-next",
	termSelectPrev: "term-select-prev",
	termSelectUp: "term-select-up",
	termSelectDown: "term-select-down",
	termSelectLeft: "term-select-left",
	termSelectRight: "term-select-right",
	termChoosePane: "term-choose-pane",
	termMarkPane: "term-mark-pane",
	termSwapMarked: "term-swap-marked",
	termSwapNext: "term-swap-next",
	termSwapPrev: "term-swap-prev",
	termRotateCw: "term-rotate-cw",
	termRotateCcw: "term-rotate-ccw",
	termResizeWiden: "term-resize-widen",
	termResizeNarrow: "term-resize-narrow",
	termResizeTaller: "term-resize-taller",
	termResizeShorter: "term-resize-shorter",
	termBreakPane: "term-break-pane",
	termJoinPane: "term-join-pane",
	termSyncPanes: "term-sync-panes",
	termSendToAll: "term-send-to-all",
	termCapturePane: "term-capture-pane",
	termStartRecording: "term-start-recording",
	termStopRecording: "term-stop-recording",
	termRespawnPane: "term-respawn-pane",
	termKillOtherPanes: "term-kill-other-panes",

	// ── Terminal — layout ──
	termLayoutTiled: "term-layout-tiled",
	termLayoutEvenH: "term-layout-even-h",
	termLayoutEvenV: "term-layout-even-v",
	termLayoutMainH: "term-layout-main-h",
	termLayoutMainV: "term-layout-main-v",
	termLayoutCycle: "term-layout-cycle",
	termLayoutSave: "term-layout-save",
	termLayoutReset: "term-layout-reset",

	// ── Terminal — window ──
	termNewWindow: "term-new-window",
	termRenameWindow: "term-rename-window",
	termCloseWindow: "term-close-window",
	termNextWindow: "term-next-window",
	termPrevWindow: "term-prev-window",
	termLastWindow: "term-last-window",
	termFindWindow: "term-find-window",
	termMarkWindow: "term-mark-window",
	termSwapMarkedWindow: "term-swap-marked-window",
	termMoveWindow: "term-move-window",
	termRenumberWindows: "term-renumber-windows",

	// ── Terminal — session ──
	termSessions: "term-sessions",
	termNewSession: "term-new-session",
	termRenameSession: "term-rename-session",
	termDetach: "term-detach",
	termReattachLatest: "term-reattach-latest",
	termKillOtherSessions: "term-kill-other-sessions",

	// ── Terminal — copy mode & buffers ──
	termEnterCopyMode: "term-enter-copy-mode",
	termCopyFindForward: "term-copy-find-forward",
	termCopyFindBackward: "term-copy-find-backward",
	termListBuffers: "term-list-buffers",
	termChooseBuffer: "term-choose-buffer",
	termSaveBuffer: "term-save-buffer",
	termClearBuffers: "term-clear-buffers",
	termToggleMouse: "term-toggle-mouse",

	// ── Terminal — misc ──
	termToggleProjectTerminal: "term-toggle-project-terminal",
	termOpenQuickShell: "term-open-quick-shell",
	termKeymapDefault: "term-keymap-default",
	termKeymapIterm2: "term-keymap-iterm2",
	termCheatSheet: "term-cheat-sheet",
	termClearBuffer: "term-clear-buffer",
	termSoftReset: "terminal-soft-reset",
	termHardReset: "terminal-hard-reset",
	termResumeRestart: "term-resume-restart",

	// ── Help ──
	helpDocumentation: "help-documentation",
	helpKeyboardShortcuts: "help-keyboard-shortcuts",
	helpExplainScreen: "help-explain-screen",
	helpReportBug: "help-report-bug",
	helpGithub: "help-github",
	showRemoteQr: "show-remote-qr",
	helpDiagnostics: "help-diagnostics",
} as const;

export type MenuAction = (typeof MENU_ACTIONS)[keyof typeof MENU_ACTIONS];

/**
 * Items that are declared in the menu structure but not yet wired up
 * end-to-end. They render disabled (grayed out) so users see the roadmap but
 * cannot trigger no-op actions.
 *
 * Move an action out of this set once it has a working handler in
 * `application-menu-clicked` (bun side) or `menuRouter` (renderer side).
 */
const NOT_YET_IMPLEMENTED: ReadonlySet<MenuAction> = new Set<MenuAction>([
	// File
	MENU_ACTIONS.openCloneRepository,
	MENU_ACTIONS.revealProjectFolder,

	// Edit
	MENU_ACTIONS.findInTasks,
	MENU_ACTIONS.findInTerminal,

	// Task — most need modal/inline UX wiring; first commit ships only finder-
	// reveal, copy-worktree-path, mark-completed and mark-cancelled.
	MENU_ACTIONS.taskRename,
	MENU_ACTIONS.taskSetOverview,
	MENU_ACTIONS.taskAddNote,
	MENU_ACTIONS.taskToggleWatch,
	MENU_ACTIONS.taskSpawnVariants,
	MENU_ACTIONS.taskAddAttempts,
	MENU_ACTIONS.taskDuplicate,
	MENU_ACTIONS.taskDelete,
	MENU_ACTIONS.taskOpenInIde,
	MENU_ACTIONS.taskMoveToDo,
	MENU_ACTIONS.taskMoveInProgress,
	MENU_ACTIONS.taskMoveUserQuestions,
	MENU_ACTIONS.taskMoveReviewAi,
	MENU_ACTIONS.taskMoveReviewUser,

	// Project — extras beyond the working git ops + dev server + settings
	MENU_ACTIONS.projectPushBranch,
	MENU_ACTIONS.projectMergeToMain,
	MENU_ACTIONS.projectRebaseOnMain,
	MENU_ACTIONS.projectShowBranchStatus,
	MENU_ACTIONS.projectCustomColumns,
	MENU_ACTIONS.projectCustomLabels,

	// View
	MENU_ACTIONS.viewTips,

	// Terminal — keep the structure visible but disable everything outside the
	// core split / close / zoom / layout / toggle-terminal / reset paths. These
	// require new `tmuxAction` enum values, new RPC handlers, or modal UI that
	// the follow-up commits will land.
	MENU_ACTIONS.termSetPaneTitle,
	MENU_ACTIONS.termShowPaneNumbers,
	MENU_ACTIONS.termLastPane,
	MENU_ACTIONS.termSelectNext,
	MENU_ACTIONS.termSelectPrev,
	MENU_ACTIONS.termSelectUp,
	MENU_ACTIONS.termSelectDown,
	MENU_ACTIONS.termSelectLeft,
	MENU_ACTIONS.termSelectRight,
	MENU_ACTIONS.termChoosePane,
	MENU_ACTIONS.termMarkPane,
	MENU_ACTIONS.termSwapMarked,
	MENU_ACTIONS.termSwapNext,
	MENU_ACTIONS.termSwapPrev,
	MENU_ACTIONS.termRotateCw,
	MENU_ACTIONS.termRotateCcw,
	MENU_ACTIONS.termResizeWiden,
	MENU_ACTIONS.termResizeNarrow,
	MENU_ACTIONS.termResizeTaller,
	MENU_ACTIONS.termResizeShorter,
	MENU_ACTIONS.termBreakPane,
	MENU_ACTIONS.termJoinPane,
	MENU_ACTIONS.termSyncPanes,
	MENU_ACTIONS.termSendToAll,
	MENU_ACTIONS.termCapturePane,
	MENU_ACTIONS.termStartRecording,
	MENU_ACTIONS.termStopRecording,
	MENU_ACTIONS.termRespawnPane,
	MENU_ACTIONS.termKillOtherPanes,
	MENU_ACTIONS.termLayoutSave,
	MENU_ACTIONS.termLayoutReset,
	MENU_ACTIONS.termNewWindow,
	MENU_ACTIONS.termRenameWindow,
	MENU_ACTIONS.termCloseWindow,
	MENU_ACTIONS.termNextWindow,
	MENU_ACTIONS.termPrevWindow,
	MENU_ACTIONS.termLastWindow,
	MENU_ACTIONS.termFindWindow,
	MENU_ACTIONS.termMarkWindow,
	MENU_ACTIONS.termSwapMarkedWindow,
	MENU_ACTIONS.termMoveWindow,
	MENU_ACTIONS.termRenumberWindows,
	MENU_ACTIONS.termSessions,
	MENU_ACTIONS.termNewSession,
	MENU_ACTIONS.termRenameSession,
	MENU_ACTIONS.termDetach,
	MENU_ACTIONS.termReattachLatest,
	MENU_ACTIONS.termKillOtherSessions,
	MENU_ACTIONS.termEnterCopyMode,
	MENU_ACTIONS.termCopyFindForward,
	MENU_ACTIONS.termCopyFindBackward,
	MENU_ACTIONS.termListBuffers,
	MENU_ACTIONS.termChooseBuffer,
	MENU_ACTIONS.termSaveBuffer,
	MENU_ACTIONS.termClearBuffers,
	MENU_ACTIONS.termToggleMouse,
	MENU_ACTIONS.termKeymapDefault,
	MENU_ACTIONS.termKeymapIterm2,
	MENU_ACTIONS.termResumeRestart,
	MENU_ACTIONS.termClearBuffer,

	// Help
	MENU_ACTIONS.helpKeyboardShortcuts,
	MENU_ACTIONS.helpDiagnostics,
]);

/**
 * True for actions on the roadmap (declared in the menu but not yet wired up
 * end-to-end). The native menu renders these disabled; the browser-mode React
 * menu bar (`AppMenuBar.tsx`) drops them entirely so it only ever lists actions
 * the current build can actually run. Accepts a plain string so renderer code
 * can test arbitrary action ids without importing the `MenuAction` type.
 */
export function isComingSoonAction(action: string): boolean {
	return (NOT_YET_IMPLEMENTED as ReadonlySet<string>).has(action);
}

type Item = {
	label: string;
	action?: MenuAction;
	accelerator?: string;
};

/**
 * Context-aware enable rules. Each menu action either has no context
 * requirement (always enabled unless on the roadmap), or it requires the user
 * to be in a specific view — a task is in scope, a project is in scope, or a
 * terminal is visible on screen.
 *
 * The renderer pushes the current `MenuContext` whenever the route changes
 * (`api.request.updateMenuContext({...})`) and the bun side rebuilds the menu.
 * That keeps native-menu items grey when they wouldn't do anything useful.
 */
export interface MenuContext {
	/** A current task is selected (task view, or a project view with an activeTaskId). */
	hasTask: boolean;
	/** A current project is selected (any project-scoped view). */
	hasProject: boolean;
	/** A terminal is visible on screen (task / project-terminal). */
	hasTerminal: boolean;
}

export const EMPTY_MENU_CONTEXT: MenuContext = {
	hasTask: false,
	hasProject: false,
	hasTerminal: false,
};

const REQUIRES_TASK: ReadonlySet<MenuAction> = new Set<MenuAction>([
	MENU_ACTIONS.taskRename,
	MENU_ACTIONS.taskSetOverview,
	MENU_ACTIONS.taskAddNote,
	MENU_ACTIONS.taskMoveToDo,
	MENU_ACTIONS.taskMoveInProgress,
	MENU_ACTIONS.taskMoveUserQuestions,
	MENU_ACTIONS.taskMoveReviewAi,
	MENU_ACTIONS.taskMoveReviewUser,
	MENU_ACTIONS.taskMarkCompleted,
	MENU_ACTIONS.taskMarkCancelled,
	MENU_ACTIONS.taskToggleWatch,
	MENU_ACTIONS.taskSpawnVariants,
	MENU_ACTIONS.taskAddAttempts,
	MENU_ACTIONS.taskDuplicate,
	MENU_ACTIONS.taskDelete,
	MENU_ACTIONS.taskOpenInIde,
	MENU_ACTIONS.taskOpenInFinder,
	MENU_ACTIONS.taskCopyWorktreePath,
	MENU_ACTIONS.taskRunScript,
	// Task-scoped project ops (need a task branch to push / create-PR)
	MENU_ACTIONS.projectCreatePr,
	MENU_ACTIONS.projectPushBranch,
	MENU_ACTIONS.projectMergeToMain,
	MENU_ACTIONS.projectRebaseOnMain,
	MENU_ACTIONS.projectShowBranchStatus,
	MENU_ACTIONS.projectDevServerStart,
	MENU_ACTIONS.projectDevServerStop,
	MENU_ACTIONS.projectDevServerRestart,
	MENU_ACTIONS.projectDevServerStatus,
]);

const REQUIRES_PROJECT: ReadonlySet<MenuAction> = new Set<MenuAction>([
	MENU_ACTIONS.revealProjectFolder,
	MENU_ACTIONS.projectPullMain,
	MENU_ACTIONS.projectSettings,
	MENU_ACTIONS.projectCustomColumns,
	MENU_ACTIONS.projectCustomLabels,
	MENU_ACTIONS.termToggleProjectTerminal,
]);

const REQUIRES_TERMINAL: ReadonlySet<MenuAction> = new Set<MenuAction>([
	MENU_ACTIONS.termSplitH,
	MENU_ACTIONS.termSplitV,
	MENU_ACTIONS.termClosePane,
	MENU_ACTIONS.termZoomPane,
	MENU_ACTIONS.termShowPaneNumbers,
	MENU_ACTIONS.termSetPaneTitle,
	MENU_ACTIONS.termLastPane,
	MENU_ACTIONS.termSelectNext,
	MENU_ACTIONS.termSelectPrev,
	MENU_ACTIONS.termSelectUp,
	MENU_ACTIONS.termSelectDown,
	MENU_ACTIONS.termSelectLeft,
	MENU_ACTIONS.termSelectRight,
	MENU_ACTIONS.termChoosePane,
	MENU_ACTIONS.termMarkPane,
	MENU_ACTIONS.termSwapMarked,
	MENU_ACTIONS.termSwapNext,
	MENU_ACTIONS.termSwapPrev,
	MENU_ACTIONS.termRotateCw,
	MENU_ACTIONS.termRotateCcw,
	MENU_ACTIONS.termResizeWiden,
	MENU_ACTIONS.termResizeNarrow,
	MENU_ACTIONS.termResizeTaller,
	MENU_ACTIONS.termResizeShorter,
	MENU_ACTIONS.termBreakPane,
	MENU_ACTIONS.termJoinPane,
	MENU_ACTIONS.termSyncPanes,
	MENU_ACTIONS.termSendToAll,
	MENU_ACTIONS.termCapturePane,
	MENU_ACTIONS.termStartRecording,
	MENU_ACTIONS.termStopRecording,
	MENU_ACTIONS.termRespawnPane,
	MENU_ACTIONS.termKillOtherPanes,
	MENU_ACTIONS.termLayoutTiled,
	MENU_ACTIONS.termLayoutEvenH,
	MENU_ACTIONS.termLayoutEvenV,
	MENU_ACTIONS.termLayoutMainH,
	MENU_ACTIONS.termLayoutMainV,
	MENU_ACTIONS.termLayoutCycle,
	MENU_ACTIONS.termLayoutSave,
	MENU_ACTIONS.termLayoutReset,
	MENU_ACTIONS.termNewWindow,
	MENU_ACTIONS.termRenameWindow,
	MENU_ACTIONS.termCloseWindow,
	MENU_ACTIONS.termNextWindow,
	MENU_ACTIONS.termPrevWindow,
	MENU_ACTIONS.termLastWindow,
	MENU_ACTIONS.termFindWindow,
	MENU_ACTIONS.termMarkWindow,
	MENU_ACTIONS.termSwapMarkedWindow,
	MENU_ACTIONS.termMoveWindow,
	MENU_ACTIONS.termRenumberWindows,
	MENU_ACTIONS.termRenameSession,
	MENU_ACTIONS.termDetach,
	MENU_ACTIONS.termEnterCopyMode,
	MENU_ACTIONS.termCopyFindForward,
	MENU_ACTIONS.termCopyFindBackward,
	MENU_ACTIONS.termListBuffers,
	MENU_ACTIONS.termChooseBuffer,
	MENU_ACTIONS.termSaveBuffer,
	MENU_ACTIONS.termClearBuffers,
	MENU_ACTIONS.termToggleMouse,
	MENU_ACTIONS.termKeymapDefault,
	MENU_ACTIONS.termKeymapIterm2,
	MENU_ACTIONS.termResumeRestart,
	MENU_ACTIONS.termClearBuffer,
	MENU_ACTIONS.termSoftReset,
	MENU_ACTIONS.termHardReset,
]);

function meetsContext(action: MenuAction, ctx: MenuContext): boolean {
	if (REQUIRES_TERMINAL.has(action) && !ctx.hasTerminal) return false;
	if (REQUIRES_TASK.has(action) && !ctx.hasTask) return false;
	if (REQUIRES_PROJECT.has(action) && !ctx.hasProject) return false;
	return true;
}

// Mutated by `buildApplicationMenu` right before menu construction so every
// `item()` call inside the per-menu builders can see the current context
// without threading it through every nested helper.
let currentContext: MenuContext = EMPTY_MENU_CONTEXT;

/**
 * Shorthand for an actionable menu item. Items render disabled when either:
 *   1. Their action is in `NOT_YET_IMPLEMENTED` (roadmap placeholder), or
 *   2. The current `MenuContext` doesn't satisfy the action's requirement
 *      (e.g. tmux pane splits with no terminal visible).
 */
function item(spec: Item): ApplicationMenuItemConfig {
	const action = spec.action;
	const inRoadmap = action ? NOT_YET_IMPLEMENTED.has(action) : false;
	const contextOk = action ? meetsContext(action, currentContext) : true;
	const enabled = !inRoadmap && contextOk;
	return {
		label: spec.label,
		...(spec.action ? { action: spec.action } : {}),
		...(spec.accelerator ? { accelerator: spec.accelerator } : {}),
		enabled,
	} as ApplicationMenuItemConfig;
}

const SEP: ApplicationMenuItemConfig = { type: "separator" };

function appMenu(): ApplicationMenuItemConfig {
	return {
		label: "dev-3.0",
		submenu: [
			item({ label: "About dev-3.0", action: MENU_ACTIONS.about }),
			item({ label: "Check for Updates...", action: MENU_ACTIONS.checkForUpdates }),
			SEP,
			item({ label: "Settings...", action: MENU_ACTIONS.openSettings, accelerator: "," }),
			SEP,
			{
				label: "Theme",
				submenu: [
					item({ label: "Light", action: MENU_ACTIONS.setThemeLight }),
					item({ label: "Dark", action: MENU_ACTIONS.setThemeDark }),
					item({ label: "Auto (System)", action: MENU_ACTIONS.setThemeAuto }),
				],
			},
			{
				label: "Language",
				submenu: [
					item({ label: "English", action: MENU_ACTIONS.setLocaleEn }),
					item({ label: "Русский", action: MENU_ACTIONS.setLocaleRu }),
					item({ label: "Español", action: MENU_ACTIONS.setLocaleEs }),
				],
			},
			SEP,
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "showAll" },
			SEP,
			{ role: "quit" },
		],
	};
}

function fileMenu(): ApplicationMenuItemConfig {
	return {
		label: "File",
		submenu: [
			item({ label: "New Window", action: MENU_ACTIONS.newWindow }),
			SEP,
			item({ label: "New Task", action: MENU_ACTIONS.openNewTask, accelerator: "n" }),
			SEP,
			item({ label: "Add Local Project...", action: MENU_ACTIONS.openAddProject, accelerator: "p" }),
			item({ label: "Clone Repository...", action: MENU_ACTIONS.openCloneRepository }),
			SEP,
			item({ label: "Reveal Project Folder in Finder", action: MENU_ACTIONS.revealProjectFolder }),
			SEP,
			{ role: "close" },
		],
	};
}

function editMenu(): ApplicationMenuItemConfig {
	return {
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			SEP,
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "pasteAndMatchStyle" },
			{ role: "delete" },
			{ role: "selectAll" },
			SEP,
			item({ label: "Find in Tasks...", action: MENU_ACTIONS.findInTasks, accelerator: "f" }),
			item({ label: "Find in Terminal...", action: MENU_ACTIONS.findInTerminal }),
		],
	};
}

function taskMenu(): ApplicationMenuItemConfig {
	return {
		label: "Task",
		submenu: [
			item({ label: "Rename Task…", action: MENU_ACTIONS.taskRename }),
			item({ label: "Set Overview…", action: MENU_ACTIONS.taskSetOverview }),
			item({ label: "Add Note", action: MENU_ACTIONS.taskAddNote }),
			SEP,
			{
				label: "Move to Status",
				submenu: [
					item({ label: "To Do", action: MENU_ACTIONS.taskMoveToDo }),
					item({ label: "In Progress", action: MENU_ACTIONS.taskMoveInProgress }),
					item({ label: "User Questions", action: MENU_ACTIONS.taskMoveUserQuestions }),
					item({ label: "Review by AI", action: MENU_ACTIONS.taskMoveReviewAi }),
					item({ label: "Review by User", action: MENU_ACTIONS.taskMoveReviewUser }),
					SEP,
					item({ label: "Mark Completed", action: MENU_ACTIONS.taskMarkCompleted }),
					item({ label: "Mark Cancelled", action: MENU_ACTIONS.taskMarkCancelled }),
				],
			},
			item({ label: "Watch / Unwatch", action: MENU_ACTIONS.taskToggleWatch }),
			SEP,
			item({ label: "Spawn Variants…", action: MENU_ACTIONS.taskSpawnVariants }),
			item({ label: "Add Attempts…", action: MENU_ACTIONS.taskAddAttempts }),
			item({ label: "Duplicate Task", action: MENU_ACTIONS.taskDuplicate }),
			item({ label: "Delete Task", action: MENU_ACTIONS.taskDelete }),
			SEP,
			item({ label: "Open in IDE…", action: MENU_ACTIONS.taskOpenInIde }),
			item({ label: "Reveal Worktree in Finder", action: MENU_ACTIONS.taskOpenInFinder }),
			item({ label: "Copy Worktree Path", action: MENU_ACTIONS.taskCopyWorktreePath }),
			SEP,
			item({ label: "Run Script…", action: MENU_ACTIONS.taskRunScript, accelerator: "r" }),
		],
	};
}

function projectMenu(): ApplicationMenuItemConfig {
	return {
		label: "Project",
		submenu: [
			item({ label: "Pull main", action: MENU_ACTIONS.projectPullMain }),
			item({ label: "Push Branch", action: MENU_ACTIONS.projectPushBranch }),
			item({ label: "Create Pull Request…", action: MENU_ACTIONS.projectCreatePr }),
			SEP,
			item({ label: "Merge to main…", action: MENU_ACTIONS.projectMergeToMain }),
			item({ label: "Rebase on main…", action: MENU_ACTIONS.projectRebaseOnMain }),
			item({ label: "Show Branch Status", action: MENU_ACTIONS.projectShowBranchStatus }),
			SEP,
			{
				label: "Dev Server",
				submenu: [
					item({ label: "Start", action: MENU_ACTIONS.projectDevServerStart }),
					item({ label: "Stop", action: MENU_ACTIONS.projectDevServerStop }),
					item({ label: "Restart", action: MENU_ACTIONS.projectDevServerRestart }),
					item({ label: "Status", action: MENU_ACTIONS.projectDevServerStatus }),
				],
			},
			SEP,
			item({ label: "Project Settings…", action: MENU_ACTIONS.projectSettings }),
			item({ label: "Custom Columns…", action: MENU_ACTIONS.projectCustomColumns }),
			item({ label: "Custom Labels…", action: MENU_ACTIONS.projectCustomLabels }),
		],
	};
}

function viewMenu(): ApplicationMenuItemConfig {
	return {
		label: "View",
		submenu: [
			// Keyboard-summoned palettes (App.tsx owns the real shortcuts: Cmd+K /
			// Cmd+Shift+P toggle). Electrobun menu accelerators only support single
			// characters, not chords like Shift+P (decision 044), and the palettes
			// toggle — so we add no native accelerator and show the chord in the
			// label instead. Clicking opens the palette via menuRouter.
			item({ label: "Go to Project… (⌘K)", action: MENU_ACTIONS.openProjectSwitch }),
			item({ label: "Command Palette… (⇧⌘P)", action: MENU_ACTIONS.openCommandPalette }),
			SEP,
			item({ label: "Show Dashboard", action: MENU_ACTIONS.viewDashboard }),
			item({ label: "Show Kanban", action: MENU_ACTIONS.viewKanban }),
			item({ label: "Show Productivity Stats", action: MENU_ACTIONS.viewStats }),
			item({ label: "Show Changelog", action: MENU_ACTIONS.viewChangelog }),
			item({ label: "Show Tips", action: MENU_ACTIONS.viewTips }),
			item({ label: "Keyboard Shortcuts (⌘/)", action: MENU_ACTIONS.helpKeyboardShortcuts }),
			SEP,
			item({ label: "Zoom In", action: MENU_ACTIONS.zoomIn, accelerator: "=" }),
			// Ctrl+- belongs to route history; keep zoom-out available through the
			// renderer's Cmd+- / Ctrl+Alt+- shortcuts and this menu item.
			item({ label: "Zoom Out (⌘- / Ctrl+Alt+-)", action: MENU_ACTIONS.zoomOut }),
			// Reset Zoom moved off ⌘0 (now "Jump to Operations") to ⇧⌘0. Electrobun
			// menu accelerators are single-char only (decision 044), so the ⇧⌘0 chord
			// is owned by the renderer (App.tsx) and only hinted in the label here.
			item({ label: "Reset Zoom (⇧⌘0)", action: MENU_ACTIONS.zoomReset }),
			SEP,
			{ role: "toggleFullScreen" },
			SEP,
			item({ label: "Hard Refresh", action: MENU_ACTIONS.hardRefresh, accelerator: "r" }),
			item({ label: "Toggle Developer Tools", action: MENU_ACTIONS.toggleDevtools }),
			item({ label: "Open Logs Directory", action: MENU_ACTIONS.openLogsDirectory }),
			SEP,
			{
				label: "Debug",
				submenu: [
					item({ label: "Gauge Demo", action: MENU_ACTIONS.gaugeDemo }),
					item({ label: "Viewport Lab", action: MENU_ACTIONS.viewportLab }),
					item({ label: "Update Popover Preview", action: MENU_ACTIONS.updatePopoverPreview }),
				],
			},
		],
	};
}

function terminalMenu(): ApplicationMenuItemConfig {
	return {
		label: "Terminal",
		submenu: [
			item({ label: "Split Horizontal", action: MENU_ACTIONS.termSplitH, accelerator: "d" }),
			item({ label: "Split Vertical", action: MENU_ACTIONS.termSplitV }),
			item({ label: "Close Pane", action: MENU_ACTIONS.termClosePane }),
			SEP,
			{
				label: "Pane",
				submenu: [
					item({ label: "Zoom Pane (Toggle)", action: MENU_ACTIONS.termZoomPane }),
					item({ label: "Show Pane Numbers", action: MENU_ACTIONS.termShowPaneNumbers }),
					item({ label: "Set Pane Title…", action: MENU_ACTIONS.termSetPaneTitle }),
					item({ label: "Last Pane", action: MENU_ACTIONS.termLastPane }),
					SEP,
					{
						label: "Select",
						submenu: [
							item({ label: "Next", action: MENU_ACTIONS.termSelectNext }),
							item({ label: "Previous", action: MENU_ACTIONS.termSelectPrev }),
							SEP,
							item({ label: "Up", action: MENU_ACTIONS.termSelectUp }),
							item({ label: "Down", action: MENU_ACTIONS.termSelectDown }),
							item({ label: "Left", action: MENU_ACTIONS.termSelectLeft }),
							item({ label: "Right", action: MENU_ACTIONS.termSelectRight }),
							SEP,
							item({ label: "Choose Pane Visually…", action: MENU_ACTIONS.termChoosePane }),
						],
					},
					{
						label: "Swap",
						submenu: [
							item({ label: "Mark Pane", action: MENU_ACTIONS.termMarkPane }),
							item({ label: "Swap with Marked", action: MENU_ACTIONS.termSwapMarked }),
							SEP,
							item({ label: "Swap with Next", action: MENU_ACTIONS.termSwapNext }),
							item({ label: "Swap with Previous", action: MENU_ACTIONS.termSwapPrev }),
							SEP,
							item({ label: "Rotate Panes Clockwise", action: MENU_ACTIONS.termRotateCw }),
							item({ label: "Rotate Panes Counter-Clockwise", action: MENU_ACTIONS.termRotateCcw }),
						],
					},
					{
						label: "Resize",
						submenu: [
							item({ label: "Widen", action: MENU_ACTIONS.termResizeWiden }),
							item({ label: "Narrow", action: MENU_ACTIONS.termResizeNarrow }),
							item({ label: "Taller", action: MENU_ACTIONS.termResizeTaller }),
							item({ label: "Shorter", action: MENU_ACTIONS.termResizeShorter }),
						],
					},
					SEP,
					item({ label: "Break Pane to New Window", action: MENU_ACTIONS.termBreakPane }),
					item({ label: "Join Pane from Window…", action: MENU_ACTIONS.termJoinPane }),
					SEP,
					item({ label: "Synchronize Panes (Toggle)", action: MENU_ACTIONS.termSyncPanes }),
					item({ label: "Send Command to All Panes…", action: MENU_ACTIONS.termSendToAll }),
					SEP,
					item({ label: "Capture Pane to File…", action: MENU_ACTIONS.termCapturePane }),
					item({ label: "Start Recording Output…", action: MENU_ACTIONS.termStartRecording }),
					item({ label: "Stop Recording", action: MENU_ACTIONS.termStopRecording }),
					SEP,
					item({ label: "Respawn Dead Pane", action: MENU_ACTIONS.termRespawnPane }),
					item({ label: "Kill Other Panes", action: MENU_ACTIONS.termKillOtherPanes }),
				],
			},
			SEP,
			{
				label: "Layout",
				submenu: [
					item({ label: "Tiled", action: MENU_ACTIONS.termLayoutTiled }),
					item({ label: "Even Horizontal", action: MENU_ACTIONS.termLayoutEvenH }),
					item({ label: "Even Vertical", action: MENU_ACTIONS.termLayoutEvenV }),
					item({ label: "Main Horizontal", action: MENU_ACTIONS.termLayoutMainH }),
					item({ label: "Main Vertical", action: MENU_ACTIONS.termLayoutMainV }),
					SEP,
					item({ label: "Cycle Next Layout", action: MENU_ACTIONS.termLayoutCycle }),
					SEP,
					item({ label: "Save Layout as Preset…", action: MENU_ACTIONS.termLayoutSave }),
					item({ label: "Reset to Default", action: MENU_ACTIONS.termLayoutReset }),
				],
			},
			{
				label: "Window",
				submenu: [
					item({ label: "New Window", action: MENU_ACTIONS.termNewWindow }),
					item({ label: "Rename Window…", action: MENU_ACTIONS.termRenameWindow }),
					item({ label: "Close Window", action: MENU_ACTIONS.termCloseWindow }),
					SEP,
					item({ label: "Next Window", action: MENU_ACTIONS.termNextWindow }),
					item({ label: "Previous Window", action: MENU_ACTIONS.termPrevWindow }),
					item({ label: "Last Active Window", action: MENU_ACTIONS.termLastWindow }),
					item({ label: "Find Window by Text…", action: MENU_ACTIONS.termFindWindow }),
					SEP,
					item({ label: "Mark Window", action: MENU_ACTIONS.termMarkWindow }),
					item({ label: "Swap with Marked Window", action: MENU_ACTIONS.termSwapMarkedWindow }),
					SEP,
					item({ label: "Move Window to Position…", action: MENU_ACTIONS.termMoveWindow }),
					item({ label: "Renumber Windows", action: MENU_ACTIONS.termRenumberWindows }),
				],
			},
			{
				label: "Session",
				submenu: [
					item({ label: "Tmux Sessions Manager…", action: MENU_ACTIONS.termSessions }),
					item({ label: "New Session…", action: MENU_ACTIONS.termNewSession }),
					item({ label: "Rename Session…", action: MENU_ACTIONS.termRenameSession }),
					SEP,
					item({ label: "Detach from Session", action: MENU_ACTIONS.termDetach }),
					item({ label: "Reattach Latest Session", action: MENU_ACTIONS.termReattachLatest }),
					SEP,
					item({ label: "Kill Other Sessions", action: MENU_ACTIONS.termKillOtherSessions }),
				],
			},
			{
				label: "Copy Mode & Buffers",
				submenu: [
					item({ label: "Enter Copy Mode", action: MENU_ACTIONS.termEnterCopyMode }),
					item({ label: "Find Forward…", action: MENU_ACTIONS.termCopyFindForward }),
					item({ label: "Find Backward…", action: MENU_ACTIONS.termCopyFindBackward }),
					SEP,
					item({ label: "List Buffers…", action: MENU_ACTIONS.termListBuffers }),
					item({ label: "Choose Buffer to Paste…", action: MENU_ACTIONS.termChooseBuffer }),
					item({ label: "Save Buffer to File…", action: MENU_ACTIONS.termSaveBuffer }),
					item({ label: "Clear All Buffers", action: MENU_ACTIONS.termClearBuffers }),
					SEP,
					item({ label: "Toggle Mouse Mode", action: MENU_ACTIONS.termToggleMouse }),
				],
			},
			SEP,
			item({ label: "Toggle Project Terminal", action: MENU_ACTIONS.termToggleProjectTerminal, accelerator: "`" }),
			item({ label: "Quick Shell", action: MENU_ACTIONS.termOpenQuickShell }),
			SEP,
			{
				label: "Keyboard Mode",
				submenu: [
					item({ label: "Default", action: MENU_ACTIONS.termKeymapDefault }),
					item({ label: "iTerm2", action: MENU_ACTIONS.termKeymapIterm2 }),
				],
			},
			item({ label: "Show Tmux Cheat Sheet", action: MENU_ACTIONS.termCheatSheet }),
			SEP,
			item({ label: "Clear Scrollback Buffer", action: MENU_ACTIONS.termClearBuffer, accelerator: "k" }),
			item({ label: "Soft Reset Terminal", action: MENU_ACTIONS.termSoftReset }),
			item({ label: "Hard Reset Terminal", action: MENU_ACTIONS.termHardReset }),
			SEP,
			item({ label: "Resume / Restart Task Session", action: MENU_ACTIONS.termResumeRestart }),
		],
	};
}

function windowMenu(): ApplicationMenuItemConfig {
	return {
		label: "Window",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			SEP,
			{ role: "bringAllToFront" },
			{ role: "cycleThroughWindows" },
			SEP,
			{ role: "close" },
		],
	};
}

function helpMenu(): ApplicationMenuItemConfig {
	return {
		label: "Help",
		submenu: [
			item({ label: "dev-3.0 Documentation", action: MENU_ACTIONS.helpDocumentation }),
			item({ label: "Explain This Screen (⇧⌘/)", action: MENU_ACTIONS.helpExplainScreen }),
			item({ label: "Keyboard Shortcuts (⌘/)", action: MENU_ACTIONS.helpKeyboardShortcuts }),
			item({ label: "Tmux Cheat Sheet", action: MENU_ACTIONS.termCheatSheet }),
			SEP,
			item({ label: "View Changelog", action: MENU_ACTIONS.viewChangelog }),
			SEP,
			item({ label: "Report a Bug…", action: MENU_ACTIONS.helpReportBug }),
			item({ label: "View on GitHub", action: MENU_ACTIONS.helpGithub }),
			SEP,
			item({ label: "Remote Access QR Code…", action: MENU_ACTIONS.showRemoteQr }),
			item({ label: "Run Diagnostics", action: MENU_ACTIONS.helpDiagnostics }),
		],
	};
}

export function buildApplicationMenu(context: MenuContext = EMPTY_MENU_CONTEXT): ApplicationMenuItemConfig[] {
	currentContext = context;
	const menu = [
		appMenu(),
		fileMenu(),
		editMenu(),
		taskMenu(),
		projectMenu(),
		viewMenu(),
		terminalMenu(),
		windowMenu(),
		helpMenu(),
	];
	currentContext = EMPTY_MENU_CONTEXT;
	return menu;
}

// ── Live menu-context store ──────────────────────────────────────────────
//
// The renderer pushes a fresh `MenuContext` every time the route changes via
// the `updateMenuContext` RPC. The handler stores it here and notifies any
// listener (registered by `src/bun/index.ts`) so the native menu can be
// rebuilt with the new enabled/disabled state.

let liveContext: MenuContext = EMPTY_MENU_CONTEXT;
let contextListener: ((ctx: MenuContext) => void) | null = null;

export function getMenuContext(): MenuContext {
	return liveContext;
}

export function applyMenuContext(ctx: MenuContext): void {
	const changed =
		ctx.hasTask !== liveContext.hasTask ||
		ctx.hasProject !== liveContext.hasProject ||
		ctx.hasTerminal !== liveContext.hasTerminal;
	liveContext = ctx;
	if (changed) contextListener?.(ctx);
}

export function onMenuContextChange(fn: (ctx: MenuContext) => void): void {
	contextListener = fn;
}
