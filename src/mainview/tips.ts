import type { TranslationKey } from "./i18n/translations/en";
import type { TipState } from "../shared/types";

export interface Tip {
	id: string;
	titleKey: TranslationKey;
	bodyKey: TranslationKey;
	icon: string; // Nerd Font codepoint
	/**
	 * Coolness / priority tier, 1–5 where 5 is the coolest.
	 * Tips are surfaced highest-tier-first (all 5s before any 4, etc.),
	 * picked at random within a tier. See selectTip().
	 * When adding a new tip, score it with the rubric in AGENTS.md
	 * ("Feature discovery tips").
	 */
	score: number;
}

const ALL_TIPS: Tip[] = [
	{
		id: "diff-review-persists",
		titleKey: "tip.diffReviewPersists.title",
		bodyKey: "tip.diffReviewPersists.body",
		icon: "\u{F0193}", // nf-md-content_save
		score: 3,
	},
	{
		id: "create-task-inline-label",
		titleKey: "tip.createTaskInlineLabel.title",
		bodyKey: "tip.createTaskInlineLabel.body",
		icon: "\u{F0403}", // nf-md-label_outline
		score: 2,
	},
	{
		id: "back-forward-nav",
		titleKey: "tip.backForwardNav.title",
		bodyKey: "tip.backForwardNav.body",
		icon: "\u{F0141}", // nf-md-chevron_left
		score: 2,
	},
	{
		id: "status-age-badge",
		titleKey: "tip.statusAgeBadge.title",
		bodyKey: "tip.statusAgeBadge.body",
		icon: "\u{F0954}", // nf-md-clock_outline
		score: 3,
	},
	{
		id: "cmd-switch-keeps-view",
		titleKey: "tip.cmdSwitchKeepsView.title",
		bodyKey: "tip.cmdSwitchKeepsView.body",
		icon: "\u{F0600}", // nf-md-keyboard
		score: 3,
	},
	{
		id: "project-quick-switch",
		titleKey: "tip.projectQuickSwitch.title",
		bodyKey: "tip.projectQuickSwitch.body",
		icon: "\u{F0969}", // nf-md-magnify
		score: 3,
	},
	{
		id: "command-palette",
		titleKey: "tip.commandPalette.title",
		bodyKey: "tip.commandPalette.body",
		icon: "\u{F0E7}", // nf-fa-bolt
		score: 4,
	},
	{
		id: "agent-create-tasks",
		titleKey: "tip.agentCreateTasks.title",
		bodyKey: "tip.agentCreateTasks.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 4,
	},
	{
		id: "agent-sees-tasks",
		titleKey: "tip.agentSeesTasks.title",
		bodyKey: "tip.agentSeesTasks.body",
		icon: "\u{F0EA0}", // nf-md-eye_outline
		score: 4,
	},
	{
		id: "agent-notes",
		titleKey: "tip.agentNotes.title",
		bodyKey: "tip.agentNotes.body",
		icon: "\u{F09ED}", // nf-md-note_text_outline
		score: 4,
	},
	{
		id: "double-click-todo",
		titleKey: "tip.doubleClickTodo.title",
		bodyKey: "tip.doubleClickTodo.body",
		icon: "\u{F0A79}", // nf-md-lightning_bolt
		score: 3,
	},
	{
		id: "right-click-open",
		titleKey: "tip.rightClickOpen.title",
		bodyKey: "tip.rightClickOpen.body",
		icon: "\u{F0379}", // nf-md-open_in_new
		score: 3,
	},
	{
		id: "cmd-n-shortcut",
		titleKey: "tip.cmdN.title",
		bodyKey: "tip.cmdN.body",
		icon: "\u{F030C}", // nf-md-keyboard
		score: 2,
	},
	{
		id: "terminal-preview",
		titleKey: "tip.terminalPreview.title",
		bodyKey: "tip.terminalPreview.body",
		icon: "\u{F0489}", // nf-md-monitor
		score: 5,
	},
	{
		id: "task-overview-hover",
		titleKey: "tip.taskOverviewHover.title",
		bodyKey: "tip.taskOverviewHover.body",
		icon: "\u{F02FC}", // nf-md-information_outline
		score: 3,
	},
	{
		id: "user-overview-override",
		titleKey: "tip.userOverviewOverride.title",
		bodyKey: "tip.userOverviewOverride.body",
		icon: "\u{F040}", // nf-md-pencil
		score: 3,
	},
	{
		id: "multi-variant-tasks",
		titleKey: "tip.multiVariantTasks.title",
		bodyKey: "tip.multiVariantTasks.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 5,
	},
	{
		id: "task-labels",
		titleKey: "tip.taskLabels.title",
		bodyKey: "tip.taskLabels.body",
		icon: "\u{F0B05}", // nf-md-label
		score: 2,
	},
	{
		id: "task-search",
		titleKey: "tip.taskSearch.title",
		bodyKey: "tip.taskSearch.body",
		icon: "\u{F0349}", // nf-md-magnify
		score: 3,
	},
	{
		id: "push-and-create-pr",
		titleKey: "tip.pushAndCreatePr.title",
		bodyKey: "tip.pushAndCreatePr.body",
		icon: "\u{F06A9}", // nf-md-robot
		score: 4,
	},
	{
		id: "create-pr-auto-merge",
		titleKey: "tip.createPrAutoMerge.title",
		bodyKey: "tip.createPrAutoMerge.body",
		icon: "\u{F0623}", // nf-md-source_merge
		score: 4,
	},
	{
		id: "project-github-account",
		titleKey: "tip.projectGitHubAccount.title",
		bodyKey: "tip.projectGitHubAccount.body",
		icon: "\u{F0370}", // nf-md-github
		score: 2,
	},
	{
		id: "pr-badge-on-card",
		titleKey: "tip.prBadgeOnCard.title",
		bodyKey: "tip.prBadgeOnCard.body",
		icon: "\u{F0401}", // nf-md-source_branch
		score: 3,
	},
	{
		id: "show-diff-button",
		titleKey: "tip.showDiffButton.title",
		bodyKey: "tip.showDiffButton.body",
		icon: "\u{F044B}", // nf-md-source_diff
		score: 4,
	},
	{
		id: "diff-default-layout",
		titleKey: "tip.diffDefaultLayout.title",
		bodyKey: "tip.diffDefaultLayout.body",
		icon: "\u{F0156}", // nf-md-view_split_vertical
		score: 2,
	},
	{
		id: "diff-exclude-tests",
		titleKey: "tip.diffExcludeTests.title",
		bodyKey: "tip.diffExcludeTests.body",
		icon: "\u{F0668}", // nf-md-flask_outline
		score: 3,
	},
	{
		id: "inline-diff-comments",
		titleKey: "tip.inlineDiffComments.title",
		bodyKey: "tip.inlineDiffComments.body",
		icon: "\u{F027B}", // nf-md-comment_plus_outline
		score: 4,
	},
	{
		id: "inline-diff-multiline-comments",
		titleKey: "tip.inlineDiffMultilineComments.title",
		bodyKey: "tip.inlineDiffMultilineComments.body",
		icon: "\u{F0453}", // nf-md-cursor_move
		score: 3,
	},
	{
		id: "inline-diff-review-export",
		titleKey: "tip.inlineDiffReviewExport.title",
		bodyKey: "tip.inlineDiffReviewExport.body",
		icon: "\u{F0198}", // nf-md-content_copy
		score: 4,
	},
	{
		id: "unpushed-diff",
		titleKey: "tip.unpushedDiff.title",
		bodyKey: "tip.unpushedDiff.body",
		icon: "\u{F07E7}", // nf-md-cloud_upload_outline
		score: 3,
	},
	{
		id: "image-paste-attach",
		titleKey: "tip.imagePasteAttach.title",
		bodyKey: "tip.imagePasteAttach.body",
		icon: "\u{F021F}", // nf-md-image_plus
		score: 4,
	},
	{
		id: "custom-columns",
		titleKey: "tip.customColumns.title",
		bodyKey: "tip.customColumns.body",
		icon: "\u{F0349}", // nf-md-view_column
		score: 4,
	},
	{
		id: "clone-from-url",
		titleKey: "tip.cloneFromUrl.title",
		bodyKey: "tip.cloneFromUrl.body",
		icon: "\u{F02A2}", // nf-md-source_repository
		score: 3,
	},
	{
		id: "active-tasks-sidebar",
		titleKey: "tip.activeTasksSidebar.title",
		bodyKey: "tip.activeTasksSidebar.body",
		icon: "\u{F0CB1}", // nf-md-view_list
		score: 3,
	},
	{
		id: "terminal-drag-drop-file-path",
		titleKey: "tip.terminalDragDropFilePath.title",
		bodyKey: "tip.terminalDragDropFilePath.body",
		icon: "\u{F0525}", // nf-md-drag
		score: 4,
	},
	{
		id: "yazi-file-browser",
		titleKey: "tip.yaziFileBrowser.title",
		bodyKey: "tip.yaziFileBrowser.body",
		icon: "", // nf-fa-folder_open
		score: 3,
	},
	{
		id: "review-mode-branch",
		titleKey: "tip.reviewModeBranch.title",
		bodyKey: "tip.reviewModeBranch.body",
		icon: "\u{F0804}", // nf-md-code_review
		score: 4,
	},
	{
		id: "auto-complete-on-pr-merge",
		titleKey: "tip.autoCompleteOnPrMerge.title",
		bodyKey: "tip.autoCompleteOnPrMerge.body",
		icon: "\u{F0382}", // nf-md-source_merge
		score: 4,
	},
	{
		id: "expose-task-ports",
		titleKey: "tip.exposeTaskPorts.title",
		bodyKey: "tip.exposeTaskPorts.body",
		icon: "\u{F0168}", // nf-md-lan_connect
		score: 4,
	},
	{
		id: "resume-agent-session",
		titleKey: "tip.resumeAgentSession.title",
		bodyKey: "tip.resumeAgentSession.body",
		icon: "\u{F040A}", // nf-md-play_circle_outline
		score: 4,
	},
	{
		id: "tmux-action-buttons",
		titleKey: "tip.tmuxActionButtons.title",
		bodyKey: "tip.tmuxActionButtons.body",
		icon: "\u{F0156}", // nf-md-view_split_vertical
		score: 3,
	},
	{
		id: "bell-auto-move",
		titleKey: "tip.bellAutoMove.title",
		bodyKey: "tip.bellAutoMove.body",
		icon: "", // nf-fa-bell
		score: 4,
	},
	{
		id: "zoom-support",
		titleKey: "tip.zoomSupport.title",
		bodyKey: "tip.zoomSupport.body",
		icon: "", // nf-fa-search_plus
		score: 2,
	},
	{
		id: "configurable-agents",
		titleKey: "tip.configurableAgents.title",
		bodyKey: "tip.configurableAgents.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 4,
	},
	{
		id: "osc52-clipboard",
		titleKey: "tip.osc52Clipboard.title",
		bodyKey: "tip.osc52Clipboard.body",
		icon: "", // nf-fa-copy
		score: 4,
	},
	{
		id: "task-info-panel",
		titleKey: "tip.taskInfoPanel.title",
		bodyKey: "tip.taskInfoPanel.body",
		icon: "\u{F05A}", // nf-fa-info_circle
		score: 2,
	},
	{
		id: "git-branch-status",
		titleKey: "tip.gitBranchStatus.title",
		bodyKey: "tip.gitBranchStatus.body",
		icon: "\u{F062C}", // nf-md-source_branch
		score: 3,
	},
	{
		id: "warn-before-complete",
		titleKey: "tip.warnBeforeComplete.title",
		bodyKey: "tip.warnBeforeComplete.body",
		icon: "\u{F0F09}", // nf-md-alert_circle_outline
		score: 3,
	},
	{
		id: "cow-clone-paths",
		titleKey: "tip.cowClonePaths.title",
		bodyKey: "tip.cowClonePaths.body",
		icon: "\u{F0198}", // nf-md-content_copy
		score: 5,
	},
	{
		id: "keyboard-shortcuts-panel",
		titleKey: "tip.keyboardShortcutsPanel.title",
		bodyKey: "tip.keyboardShortcutsPanel.body",
		icon: "\u{F030D}", // nf-md-keyboard
		score: 3,
	},
	// Batch 8: tmux manager, CLI, snapshots, sound, siblings
	{
		id: "tmux-session-manager",
		titleKey: "tip.tmuxSessionManager.title",
		bodyKey: "tip.tmuxSessionManager.body",
		icon: "\u{F0313}", // nf-md-console
		score: 3,
	},
	{
		id: "cli-tool",
		titleKey: "tip.cliTool.title",
		bodyKey: "tip.cliTool.body",
		icon: "\u{F0A9E}", // nf-md-terminal
		score: 4,
	},
	{
		id: "cli-dev-server",
		titleKey: "tip.cliDevServer.title",
		bodyKey: "tip.cliDevServer.body",
		icon: "\u{F0A9E}", // nf-md-terminal
		score: 3,
	},
	{
		id: "diff-snapshots",
		titleKey: "tip.diffSnapshots.title",
		bodyKey: "tip.diffSnapshots.body",
		icon: "\u{F0804}", // nf-md-history
		score: 4,
	},
	{
		id: "sibling-variant-visibility",
		titleKey: "tip.siblingVariantVisibility.title",
		bodyKey: "tip.siblingVariantVisibility.body",
		icon: "\u{F0CB8}", // nf-md-dots_horizontal
		score: 4,
	},
	{
		id: "branch-selector-task-creation",
		titleKey: "tip.branchSelectorTaskCreation.title",
		bodyKey: "tip.branchSelectorTaskCreation.body",
		icon: "\u{F062C}", // nf-md-source_branch
		score: 3,
	},
	{
		id: "resume-conversation-on-reopen",
		titleKey: "tip.resumeConversationOnReopen.title",
		bodyKey: "tip.resumeConversationOnReopen.body",
		icon: "\u{F040A}", // nf-md-restore
		score: 4,
	},
	{
		id: "setup-script-panes",
		titleKey: "tip.setupScriptPanes.title",
		bodyKey: "tip.setupScriptPanes.body",
		icon: "\u{F0259}", // nf-md-console
		score: 2,
	},
	{
		id: "custom-task-title",
		titleKey: "tip.customTaskTitle.title",
		bodyKey: "tip.customTaskTitle.body",
		icon: "\u{F0B5B}", // nf-md-pencil
		score: 2,
	},
	{
		id: "spawn-extra-agent",
		titleKey: "tip.spawnExtraAgent.title",
		bodyKey: "tip.spawnExtraAgent.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 4,
	},
	{
		id: "branch-start-choice",
		titleKey: "tip.autoFillBranch.title",
		bodyKey: "tip.autoFillBranch.body",
		icon: "\u{F0F09}", // nf-md-alert_circle_outline
		score: 2,
	},
	{
		id: "task-open-mode",
		titleKey: "tip.taskOpenMode.title",
		bodyKey: "tip.taskOpenMode.body",
		icon: "\u{F0124}", // nf-md-fullscreen
		score: 2,
	},
	{
		id: "fork-branch-support",
		titleKey: "tip.forkBranchSupport.title",
		bodyKey: "tip.forkBranchSupport.body",
		icon: "\u{F062C}", // nf-md-source_branch
		score: 3,
	},
	{
		id: "restart-task-from-scratch",
		titleKey: "tip.restartTaskFromScratch.title",
		bodyKey: "tip.restartTaskFromScratch.body",
		icon: "\u{F0450}", // nf-md-refresh
		score: 3,
	},
	{
		id: "shell-after-agent-exit",
		titleKey: "tip.shellAfterAgentExit.title",
		bodyKey: "tip.shellAfterAgentExit.body",
		icon: "\u{F0313}", // nf-md-console
		score: 3,
	},
	{
		id: "worktree-file-filter",
		titleKey: "tip.worktreeFileFilter.title",
		bodyKey: "tip.worktreeFileFilter.body",
		icon: "\u{F024B}", // nf-md-filter
		score: 3,
	},
	{
		id: "repo-local-config",
		titleKey: "tip.repoLocalConfig.title",
		bodyKey: "tip.repoLocalConfig.body",
		icon: "\u{F0493}", // nf-md-share_variant
		score: 4,
	},
	{
		id: "ai-review-drag",
		titleKey: "tip.aiReviewDrag.title",
		bodyKey: "tip.aiReviewDrag.body",
		icon: "\u{F0804}", // nf-md-code_review
		score: 5,
	},
	{
		id: "ai-review-customize",
		titleKey: "tip.aiReviewCustomize.title",
		bodyKey: "tip.aiReviewCustomize.body",
		icon: "\u{F0493}", // nf-md-tune_variant
		score: 3,
	},
	{
		id: "custom-column-agents",
		titleKey: "tip.customColumnAgents.title",
		bodyKey: "tip.customColumnAgents.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 4,
	},
	{
		id: "rename-builtin-columns",
		titleKey: "tip.renameBuiltinColumns.title",
		bodyKey: "tip.renameBuiltinColumns.body",
		icon: "\u{F0B5B}", // nf-md-pencil
		score: 2,
	},
	{
		id: "config-hierarchy",
		titleKey: "tip.configHierarchy.title",
		bodyKey: "tip.configHierarchy.body",
		icon: "\u{F0493}", // nf-md-tune
		score: 2,
	},
	{
		id: "worktree-config",
		titleKey: "tip.worktreeConfig.title",
		bodyKey: "tip.worktreeConfig.body",
		icon: "\u{F0645}", // nf-md-file_tree
		score: 3,
	},
	{
		id: "diff-compare-default",
		titleKey: "tip.diffCompareDefault.title",
		bodyKey: "tip.diffCompareDefault.body",
		icon: "\u{F04CB}", // nf-md-source_compare
		score: 2,
	},
	{
		id: "project-terminal",
		titleKey: "tip.projectTerminal.title",
		bodyKey: "tip.projectTerminal.body",
		icon: "\u{F0489}", // nf-md-console
		score: 3,
	},
	{
		id: "port-allocation",
		titleKey: "tip.portAllocation.title",
		bodyKey: "tip.portAllocation.body",
		icon: "\u{F0317}", // nf-md-ethernet
		score: 4,
	},
	{
		id: "resource-usage-badge",
		titleKey: "tip.resourceUsageBadge.title",
		bodyKey: "tip.resourceUsageBadge.body",
		icon: "\u{F035B}",
		score: 3,
	},
	{
		id: "task-watch-notifications",
		titleKey: "tip.taskWatch.title",
		bodyKey: "tip.taskWatch.body",
		icon: "\u{F009A}", // nf-md-bell
		score: 3,
	},
	{
		id: "prevent-sleep",
		titleKey: "tip.preventSleep.title",
		bodyKey: "tip.preventSleep.body",
		icon: String.fromCharCode(0xec15), // nf-cod-coffee
		score: 3,
	},
	{
		id: "copy-worktree-path",
		titleKey: "tip.copyWorktreePath.title",
		bodyKey: "tip.copyWorktreePath.body",
		icon: "\u{F0198}", // nf-md-content_copy
		score: 2,
	},
	{
		id: "cancel-preparing",
		titleKey: "tip.cancelPreparing.title",
		bodyKey: "tip.cancelPreparing.body",
		icon: "\u{F0159}", // nf-md-cancel
		score: 2,
	},
	{
		id: "folder-picker-paste-path",
		titleKey: "tip.folderPickerPastePath.title",
		bodyKey: "tip.folderPickerPastePath.body",
		icon: "\u{F0770}", // nf-md-folder_open
		score: 2,
	},
	{
		id: "kanban-git-pull",
		titleKey: "tip.kanbanGitPull.title",
		bodyKey: "tip.kanbanGitPull.body",
		icon: "\u{F0164}", // nf-md-cloud_download_outline
		score: 3,
	},
	{
		id: "init-new-project",
		titleKey: "tip.initNewProject.title",
		bodyKey: "tip.initNewProject.body",
		icon: "\u{F0415}", // nf-md-plus_box
		score: 3,
	},
	{
		id: "sidebar-global-scope",
		titleKey: "tip.sidebarGlobalScope.title",
		bodyKey: "tip.sidebarGlobalScope.body",
		icon: "", // nf-cod-globe
		score: 4,
	},
	{
		id: "scratch-task",
		titleKey: "tip.scratchTask.title",
		bodyKey: "tip.scratchTask.body",
		icon: "\u{F018D}", // nf-md-console
		score: 4,
	},
	{
		id: "review-discard-guard",
		titleKey: "tip.reviewDiscardGuard.title",
		bodyKey: "tip.reviewDiscardGuard.body",
		icon: "\u{F0156}", // nf-md-shield_check
		score: 3,
	},
	{
		id: "fda-stuck-prep",
		titleKey: "tip.fdaStuckPrep.title",
		bodyKey: "tip.fdaStuckPrep.body",
		icon: "\u{F0156}", // nf-md-shield_check
		score: 2,
	},
	{
		id: "bug-hunters-lightbox",
		titleKey: "tip.bugHunters.title",
		bodyKey: "tip.bugHunters.body",
		icon: "", // nf-fa-bug
		score: 5,
	},
	{
		id: "multi-window",
		titleKey: "tip.multiWindow.title",
		bodyKey: "tip.multiWindow.body",
		icon: "\u{F05C2}", // nf-md-window_restore
		score: 4,
	},
	{
		id: "sidebar-hide",
		titleKey: "tip.sidebarHide.title",
		bodyKey: "tip.sidebarHide.body",
		icon: "\u{F0294}", // nf-md-fullscreen
		score: 2,
	},
	{
		id: "multi-folder-add-project",
		titleKey: "tip.multiFolderAddProject.title",
		bodyKey: "tip.multiFolderAddProject.body",
		icon: "\u{F0770}", // nf-md-folder_open
		score: 3,
	},
	{
		id: "skill-autocomplete",
		titleKey: "tip.skillAutocomplete.title",
		bodyKey: "tip.skillAutocomplete.body",
		icon: "\u{F0349}", // nf-md-magic_staff
		score: 4,
	},
	{
		id: "projects-daily-backup",
		titleKey: "tip.projectsDailyBackup.title",
		bodyKey: "tip.projectsDailyBackup.body",
		icon: "\u{F006F}", // nf-md-backup_restore
		score: 3,
	},
	{
		id: "agent-completion-request",
		titleKey: "tip.agentCompletionRequest.title",
		bodyKey: "tip.agentCompletionRequest.body",
		icon: "\u{F06A9}", // nf-md-robot
		score: 3,
	},
	{
		id: "task-switcher-option-tab",
		titleKey: "tip.taskSwitcher.title",
		bodyKey: "tip.taskSwitcher.body",
		icon: "\u{F030C}", // nf-md-keyboard
		score: 4,
	},
	{
		id: "paste-large-text",
		titleKey: "tip.pasteLargeText.title",
		bodyKey: "tip.pasteLargeText.body",
		icon: "\u{F0192}", // nf-md-file_document_outline
		score: 4,
	},
	{
		id: "task-hint-nav",
		titleKey: "tip.taskHintNav.title",
		bodyKey: "tip.taskHintNav.body",
		icon: "\uF05B", // nf-fa-crosshairs
		score: 4,
	},
];

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const SNOOZE_MS = 4 * 60 * 60 * 1000; // 4 hours
export const ROTATION_INTERVAL_MS = 60 * 1000; // 1 minute

/** Deterministic pseudo-random in [0, 1) seeded by an integer — keeps selectTip pure & testable. */
function seededUnit(seed: number): number {
	const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return x - Math.floor(x);
}

/** Tips that are not snoozed and either unseen or past their cooldown. */
function availableTips(state: TipState, now: number): Tip[] {
	return ALL_TIPS.filter((t) => {
		const lastSeen = state.seen[t.id];
		if (!lastSeen) return true;
		return now - lastSeen > COOLDOWN_MS;
	});
}

/**
 * Pick the current tip based on persisted state. Pure function — no side effects.
 *
 * Highest-coolness tier first: all score-5 tips are shown (in pseudo-random
 * order) before any score-4 tip, and so on. As tips are seen they drop out of
 * the pool for COOLDOWN_MS, draining the top tier until it falls to the next.
 */
export function selectTip(state: TipState): Tip | null {
	const now = Date.now();

	if (state.snoozedUntil > now) return null;

	const available = availableTips(state, now);
	if (available.length === 0) return null;

	const maxScore = Math.max(...available.map((t) => t.score));
	const tier = available.filter((t) => t.score === maxScore);

	const idx = Math.floor(seededUnit(state.rotationIndex) * tier.length);
	return tier[idx];
}

/** Get available tips count for the given state. */
export function getAvailableTipsCount(state: TipState): number {
	return availableTips(state, Date.now()).length;
}

export { ALL_TIPS };
