import type { TranslationKey } from "./i18n/translations/en";
import type { TipState } from "../shared/types";

export interface Tip {
	id: string;
	titleKey: TranslationKey;
	bodyKey: TranslationKey;
	icon: string; // Nerd Font codepoint
}

const ALL_TIPS: Tip[] = [
	{
		id: "agent-create-tasks",
		titleKey: "tip.agentCreateTasks.title",
		bodyKey: "tip.agentCreateTasks.body",
		icon: "\u{F0219}", // nf-md-robot
	},
	{
		id: "agent-sees-tasks",
		titleKey: "tip.agentSeesTasks.title",
		bodyKey: "tip.agentSeesTasks.body",
		icon: "\u{F0EA0}", // nf-md-eye_outline
	},
	{
		id: "agent-notes",
		titleKey: "tip.agentNotes.title",
		bodyKey: "tip.agentNotes.body",
		icon: "\u{F09ED}", // nf-md-note_text_outline
	},
	{
		id: "drag-columns",
		titleKey: "tip.dragColumns.title",
		bodyKey: "tip.dragColumns.body",
		icon: "\u{F0453}", // nf-md-cursor_move
	},
	{
		id: "double-click-todo",
		titleKey: "tip.doubleClickTodo.title",
		bodyKey: "tip.doubleClickTodo.body",
		icon: "\u{F0A79}", // nf-md-lightning_bolt
	},
	{
		id: "right-click-open",
		titleKey: "tip.rightClickOpen.title",
		bodyKey: "tip.rightClickOpen.body",
		icon: "\u{F0379}", // nf-md-open_in_new
	},
	{
		id: "cmd-n-shortcut",
		titleKey: "tip.cmdN.title",
		bodyKey: "tip.cmdN.body",
		icon: "\u{F030C}", // nf-md-keyboard
	},
	{
		id: "terminal-preview",
		titleKey: "tip.terminalPreview.title",
		bodyKey: "tip.terminalPreview.body",
		icon: "\u{F0489}", // nf-md-monitor
	},
	// Batch 1: split-view, multi-variant, labels, search, PR
	{
		id: "split-view-escape",
		titleKey: "tip.splitViewEscape.title",
		bodyKey: "tip.splitViewEscape.body",
		icon: "\u{F12B7}", // nf-md-keyboard_esc
	},
	{
		id: "multi-variant-tasks",
		titleKey: "tip.multiVariantTasks.title",
		bodyKey: "tip.multiVariantTasks.body",
		icon: "\u{F0219}", // nf-md-robot
	},
	{
		id: "task-labels",
		titleKey: "tip.taskLabels.title",
		bodyKey: "tip.taskLabels.body",
		icon: "\u{F0B05}", // nf-md-label
	},
	{
		id: "task-search",
		titleKey: "tip.taskSearch.title",
		bodyKey: "tip.taskSearch.body",
		icon: "\u{F0349}", // nf-md-magnify
	},
	{
		id: "push-and-create-pr",
		titleKey: "tip.pushAndCreatePr.title",
		bodyKey: "tip.pushAndCreatePr.body",
		icon: "\u{F0544}", // nf-md-source_pull
	},
	{
		id: "pr-awareness",
		titleKey: "tip.prAwareness.title",
		bodyKey: "tip.prAwareness.body",
		icon: "\u{F0408}", // nf-md-source_pull
	},
	{
		id: "pr-badge-on-card",
		titleKey: "tip.prBadgeOnCard.title",
		bodyKey: "tip.prBadgeOnCard.body",
		icon: "\u{F0401}", // nf-md-source_branch
	},
	// Batch 2: diff, images, custom columns, clone
	{
		id: "show-diff-button",
		titleKey: "tip.showDiffButton.title",
		bodyKey: "tip.showDiffButton.body",
		icon: "\u{F044B}", // nf-md-source_diff
	},
	{
		id: "image-paste-attach",
		titleKey: "tip.imagePasteAttach.title",
		bodyKey: "tip.imagePasteAttach.body",
		icon: "\u{F021F}", // nf-md-image_plus
	},
	{
		id: "custom-columns",
		titleKey: "tip.customColumns.title",
		bodyKey: "tip.customColumns.body",
		icon: "\u{F0349}", // nf-md-view_column
	},
	{
		id: "clone-from-url",
		titleKey: "tip.cloneFromUrl.title",
		bodyKey: "tip.cloneFromUrl.body",
		icon: "\u{F02A2}", // nf-md-source_repository
	},
	// Batch 3: sidebar, drag-drop, yazi, review mode
	{
		id: "active-tasks-sidebar",
		titleKey: "tip.activeTasksSidebar.title",
		bodyKey: "tip.activeTasksSidebar.body",
		icon: "\u{F0CB1}", // nf-md-view_list
	},
	{
		id: "terminal-drag-drop-file-path",
		titleKey: "tip.terminalDragDropFilePath.title",
		bodyKey: "tip.terminalDragDropFilePath.body",
		icon: "\u{F0525}", // nf-md-drag
	},
	{
		id: "yazi-file-browser",
		titleKey: "tip.yaziFileBrowser.title",
		bodyKey: "tip.yaziFileBrowser.body",
		icon: "\uF24B", // nf-fa-folder_open
	},
	{
		id: "review-mode-branch",
		titleKey: "tip.reviewModeBranch.title",
		bodyKey: "tip.reviewModeBranch.body",
		icon: "\u{F0804}", // nf-md-code_review
	},
	// Batch 4: auto-complete, ports, resume, tmux buttons
	{
		id: "auto-complete-on-pr-merge",
		titleKey: "tip.autoCompleteOnPrMerge.title",
		bodyKey: "tip.autoCompleteOnPrMerge.body",
		icon: "\u{F0382}", // nf-md-source_merge
	},
	{
		id: "expose-task-ports",
		titleKey: "tip.exposeTaskPorts.title",
		bodyKey: "tip.exposeTaskPorts.body",
		icon: "\u{F0168}", // nf-md-lan_connect
	},
	{
		id: "resume-agent-session",
		titleKey: "tip.resumeAgentSession.title",
		bodyKey: "tip.resumeAgentSession.body",
		icon: "\u{F040A}", // nf-md-play_circle_outline
	},
	{
		id: "tmux-action-buttons",
		titleKey: "tip.tmuxActionButtons.title",
		bodyKey: "tip.tmuxActionButtons.body",
		icon: "\u{F0156}", // nf-md-view_split_vertical
	},
	// Batch 5: bell, breadcrumb, zoom, agents
	{
		id: "bell-auto-move",
		titleKey: "tip.bellAutoMove.title",
		bodyKey: "tip.bellAutoMove.body",
		icon: "\uF0F3", // nf-fa-bell
	},
	{
		id: "breadcrumb-project-switcher",
		titleKey: "tip.breadcrumbProjectSwitcher.title",
		bodyKey: "tip.breadcrumbProjectSwitcher.body",
		icon: "\uF07C", // nf-fa-folder_open
	},
	{
		id: "zoom-support",
		titleKey: "tip.zoomSupport.title",
		bodyKey: "tip.zoomSupport.body",
		icon: "\uF00E", // nf-fa-search_plus
	},
	{
		id: "configurable-agents",
		titleKey: "tip.configurableAgents.title",
		bodyKey: "tip.configurableAgents.body",
		icon: "\u{F0219}", // nf-md-robot
	},
	// Batch 6: clipboard, info panel, bell indicator, branch status
	{
		id: "osc52-clipboard",
		titleKey: "tip.osc52Clipboard.title",
		bodyKey: "tip.osc52Clipboard.body",
		icon: "\uF0C5", // nf-fa-copy
	},
	{
		id: "task-info-panel",
		titleKey: "tip.taskInfoPanel.title",
		bodyKey: "tip.taskInfoPanel.body",
		icon: "\u{F05A}", // nf-fa-info_circle
	},
	{
		id: "terminal-bell-indicator",
		titleKey: "tip.terminalBellIndicator.title",
		bodyKey: "tip.terminalBellIndicator.body",
		icon: "\uF0F3", // nf-fa-bell
	},
	{
		id: "git-branch-status",
		titleKey: "tip.gitBranchStatus.title",
		bodyKey: "tip.gitBranchStatus.body",
		icon: "\u{F062C}", // nf-md-source_branch
	},
	// Batch 7: warn, completed modal, CoW, shortcuts, system theme
	{
		id: "warn-before-complete",
		titleKey: "tip.warnBeforeComplete.title",
		bodyKey: "tip.warnBeforeComplete.body",
		icon: "\u{F0F09}", // nf-md-alert_circle_outline
	},
	{
		id: "completed-task-modal",
		titleKey: "tip.completedTaskModal.title",
		bodyKey: "tip.completedTaskModal.body",
		icon: "\u{F0150}", // nf-md-checkbox_marked_circle_outline
	},
	{
		id: "cow-clone-paths",
		titleKey: "tip.cowClonePaths.title",
		bodyKey: "tip.cowClonePaths.body",
		icon: "\u{F0198}", // nf-md-content_copy
	},
	{
		id: "keyboard-shortcuts",
		titleKey: "tip.keyboardShortcuts.title",
		bodyKey: "tip.keyboardShortcuts.body",
		icon: "\u{F030D}", // nf-md-keyboard
	},
	{
		id: "system-theme",
		titleKey: "tip.systemTheme.title",
		bodyKey: "tip.systemTheme.body",
		icon: "\u{F0498}", // nf-md-theme_light_dark
	},
	// Batch 8: tmux manager, CLI, snapshots, sound, siblings
	{
		id: "tmux-session-manager",
		titleKey: "tip.tmuxSessionManager.title",
		bodyKey: "tip.tmuxSessionManager.body",
		icon: "\u{F0313}", // nf-md-console
	},
	{
		id: "cli-tool",
		titleKey: "tip.cliTool.title",
		bodyKey: "tip.cliTool.body",
		icon: "\u{F0A9E}", // nf-md-terminal
	},
	{
		id: "diff-snapshots",
		titleKey: "tip.diffSnapshots.title",
		bodyKey: "tip.diffSnapshots.body",
		icon: "\u{F0804}", // nf-md-history
	},
	{
		id: "task-complete-sound",
		titleKey: "tip.taskCompleteSound.title",
		bodyKey: "tip.taskCompleteSound.body",
		icon: "\u{F075D}", // nf-md-volume_high
	},
	{
		id: "sibling-variant-visibility",
		titleKey: "tip.siblingVariantVisibility.title",
		bodyKey: "tip.siblingVariantVisibility.body",
		icon: "\u{F0CB8}", // nf-md-dots_horizontal
	},
	// Batch 9: branch selector, reorder, resume, custom prompts
	{
		id: "branch-selector-task-creation",
		titleKey: "tip.branchSelectorTaskCreation.title",
		bodyKey: "tip.branchSelectorTaskCreation.body",
		icon: "\u{F062C}", // nf-md-source_branch
	},
	{
		id: "vertical-dnd-reorder",
		titleKey: "tip.verticalDndReorder.title",
		bodyKey: "tip.verticalDndReorder.body",
		icon: "\u{F0140}", // nf-md-arrow_up_down
	},
	{
		id: "resume-conversation-on-reopen",
		titleKey: "tip.resumeConversationOnReopen.title",
		bodyKey: "tip.resumeConversationOnReopen.body",
		icon: "\u{F040A}", // nf-md-restore
	},
	// Batch 10: i18n, setup scripts, task titles
	{
		id: "language-switching",
		titleKey: "tip.languageSwitching.title",
		bodyKey: "tip.languageSwitching.body",
		icon: "\u{F1AB7}", // nf-md-translate
	},
	{
		id: "setup-script-panes",
		titleKey: "tip.setupScriptPanes.title",
		bodyKey: "tip.setupScriptPanes.body",
		icon: "\u{F0259}", // nf-md-console
	},
	{
		id: "custom-task-title",
		titleKey: "tip.customTaskTitle.title",
		bodyKey: "tip.customTaskTitle.body",
		icon: "\u{F0B5B}", // nf-md-pencil
	},
	// Batch 11: spawn agents, multi-variant inspiration
	{
		id: "spawn-extra-agent",
		titleKey: "tip.spawnExtraAgent.title",
		bodyKey: "tip.spawnExtraAgent.body",
		icon: "\u{F0219}", // nf-md-robot
	},
	{
		id: "spawn-agent-use-cases",
		titleKey: "tip.spawnAgentUseCases.title",
		bodyKey: "tip.spawnAgentUseCases.body",
		icon: "\u{F0313}", // nf-md-console
	},
	{
		id: "multi-variant-inspiration",
		titleKey: "tip.multiVariantInspiration.title",
		bodyKey: "tip.multiVariantInspiration.body",
		icon: "\u{F0EB4}", // nf-md-lightbulb_outline
	},
	// Batch 12: modal dismiss
	{
		id: "modal-quick-dismiss",
		titleKey: "tip.modalQuickDismiss.title",
		bodyKey: "tip.modalQuickDismiss.body",
		icon: "\u{F12B7}", // nf-md-keyboard_esc
	},
	// Batch 13: auto-fill branch
	{
		id: "auto-fill-branch",
		titleKey: "tip.autoFillBranch.title",
		bodyKey: "tip.autoFillBranch.body",
		icon: "\u{F062C}", // nf-md-source_branch
	},
	{
		id: "task-open-mode",
		titleKey: "tip.taskOpenMode.title",
		bodyKey: "tip.taskOpenMode.body",
		icon: "\u{F0124}", // nf-md-fullscreen
	},
	{
		id: "fork-branch-support",
		titleKey: "tip.forkBranchSupport.title",
		bodyKey: "tip.forkBranchSupport.body",
		icon: "\u{F062C}", // nf-md-source_branch
	},
	// Batch 14: task drop position
	{
		id: "collapsible-columns",
		titleKey: "tip.collapsibleColumns.title",
		bodyKey: "tip.collapsibleColumns.body",
		icon: "\u{F0142}", // nf-md-arrow_collapse_horizontal
	},
	{
		id: "task-drop-position",
		titleKey: "tip.taskDropPosition.title",
		bodyKey: "tip.taskDropPosition.body",
		icon: "\u{F0140}", // nf-md-arrow_up_down
	},
	// Batch 15: column load more, restart task
	{
		id: "restart-task-from-scratch",
		titleKey: "tip.restartTaskFromScratch.title",
		bodyKey: "tip.restartTaskFromScratch.body",
		icon: "\u{F0450}", // nf-md-refresh
	},
	{
		id: "column-load-more",
		titleKey: "tip.columnLoadMore.title",
		bodyKey: "tip.columnLoadMore.body",
		icon: "\u{F0063}", // nf-md-arrow_down
	},
	// Batch 16: shell after agent exit
	{
		id: "shell-after-agent-exit",
		titleKey: "tip.shellAfterAgentExit.title",
		bodyKey: "tip.shellAfterAgentExit.body",
		icon: "\u{F0313}", // nf-md-console
	},
	{
		id: "worktree-file-filter",
		titleKey: "tip.worktreeFileFilter.title",
		bodyKey: "tip.worktreeFileFilter.body",
		icon: "\u{F024B}", // nf-md-filter
	},
	{
		id: "async-task-launch",
		titleKey: "tip.asyncTaskLaunch.title",
		bodyKey: "tip.asyncTaskLaunch.body",
		icon: "\u{F0F26}", // nf-md-rocket_launch
	},
	// Batch 17: repo-local config
	{
		id: "repo-local-config",
		titleKey: "tip.repoLocalConfig.title",
		bodyKey: "tip.repoLocalConfig.body",
		icon: "\u{F0493}", // nf-md-share_variant
	},
	// Batch 18: column agents
	{
		id: "ai-review-drag",
		titleKey: "tip.aiReviewDrag.title",
		bodyKey: "tip.aiReviewDrag.body",
		icon: "\u{F0804}", // nf-md-code_review
	},
	{
		id: "custom-column-agents",
		titleKey: "tip.customColumnAgents.title",
		bodyKey: "tip.customColumnAgents.body",
		icon: "\u{F0219}", // nf-md-robot
	},
];

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const SNOOZE_MS = 4 * 60 * 60 * 1000; // 4 hours
export const ROTATION_INTERVAL_MS = 60 * 1000; // 1 minute

/** Pick the current tip based on persisted state. Pure function — no side effects. */
export function selectTip(state: TipState): Tip | null {
	const now = Date.now();

	if (state.snoozedUntil > now) return null;

	const available = ALL_TIPS.filter((t) => {
		const lastSeen = state.seen[t.id];
		if (!lastSeen) return true;
		return now - lastSeen > COOLDOWN_MS;
	});

	if (available.length === 0) return null;

	return available[state.rotationIndex % available.length];
}

/** Get available tips count for the given state. */
export function getAvailableTipsCount(state: TipState): number {
	const now = Date.now();
	return ALL_TIPS.filter((t) => {
		const lastSeen = state.seen[t.id];
		if (!lastSeen) return true;
		return now - lastSeen > COOLDOWN_MS;
	}).length;
}

export { ALL_TIPS };
