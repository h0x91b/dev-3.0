import type { Context, Fiber } from "cordis";
import { getAgentTrafficEnabled } from "../agent-traffic-flag";
import { isControlHidden } from "../hidden-controls";
import type { BuiltinPlugin } from "../plugins/runtime";
// Defines the slot before the plugin injects it.
import "./registry";
import type { Tip } from "./registry";

export const TIPS_BUILTIN_ID = "builtin:tips";

/** Every built-in tip. Registration order is rotation order within a score tier: append new tips at the end. */
export const BUILTIN_TIPS: readonly Tip[] = [
	{
		id: "builtin:tip.diff-review-persists",
		titleKey: "tip.diffReviewPersists.title",
		bodyKey: "tip.diffReviewPersists.body",
		icon: "\u{F0193}", // nf-md-content_save
		score: 3,
		contexts: ["diff"],
	},
	{
		id: "builtin:tip.create-task-inline-label",
		titleKey: "tip.createTaskInlineLabel.title",
		bodyKey: "tip.createTaskInlineLabel.body",
		icon: "\u{F0403}", // nf-md-label_outline
		score: 2,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.back-forward-nav",
		titleKey: "tip.backForwardNav.title",
		bodyKey: "tip.backForwardNav.body",
		icon: "\u{F0141}", // nf-md-chevron_left
		score: 2,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.status-age-badge",
		titleKey: "tip.statusAgeBadge.title",
		bodyKey: "tip.statusAgeBadge.body",
		icon: "\u{F0954}", // nf-md-clock_outline
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.cmd-switch-keeps-view",
		titleKey: "tip.cmdSwitchKeepsView.title",
		bodyKey: "tip.cmdSwitchKeepsView.body",
		icon: "\u{F0600}", // nf-md-keyboard
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.project-quick-switch",
		titleKey: "tip.projectQuickSwitch.title",
		bodyKey: "tip.projectQuickSwitch.body",
		icon: "\u{F0969}", // nf-md-magnify
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.command-palette",
		titleKey: "tip.commandPalette.title",
		bodyKey: "tip.commandPalette.body",
		icon: "\u{F0E7}", // nf-fa-bolt
		score: 4,
		contexts: ["board", "terminal", "diff"],
	},
	{
		id: "builtin:tip.agent-create-tasks",
		titleKey: "tip.agentCreateTasks.title",
		bodyKey: "tip.agentCreateTasks.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.agent-sees-tasks",
		titleKey: "tip.agentSeesTasks.title",
		bodyKey: "tip.agentSeesTasks.body",
		icon: "\u{F0EA0}", // nf-md-eye_outline
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.agent-notes",
		titleKey: "tip.agentNotes.title",
		bodyKey: "tip.agentNotes.body",
		icon: "\u{F09ED}", // nf-md-note_text_outline
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.double-click-todo",
		titleKey: "tip.doubleClickTodo.title",
		bodyKey: "tip.doubleClickTodo.body",
		icon: "\u{F0A79}", // nf-md-lightning_bolt
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.right-click-open",
		titleKey: "tip.rightClickOpen.title",
		bodyKey: "tip.rightClickOpen.body",
		icon: "\u{F0379}", // nf-md-open_in_new
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.terminal-preview",
		titleKey: "tip.terminalPreview.title",
		bodyKey: "tip.terminalPreview.body",
		icon: "\u{F0489}", // nf-md-monitor
		score: 5,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.task-overview-hover",
		titleKey: "tip.taskOverviewHover.title",
		bodyKey: "tip.taskOverviewHover.body",
		icon: "\u{F02FC}", // nf-md-information_outline
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.multi-variant-tasks",
		titleKey: "tip.multiVariantTasks.title",
		bodyKey: "tip.multiVariantTasks.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 5,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.task-labels",
		titleKey: "tip.taskLabels.title",
		bodyKey: "tip.taskLabels.body",
		icon: "\u{F0B05}", // nf-md-label
		score: 2,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.task-search",
		titleKey: "tip.taskSearch.title",
		bodyKey: "tip.taskSearch.body",
		icon: "\u{F0349}", // nf-md-magnify
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.push-and-create-pr",
		titleKey: "tip.pushAndCreatePr.title",
		bodyKey: "tip.pushAndCreatePr.body",
		icon: "\u{F06A9}", // nf-md-robot
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.create-pr-auto-merge",
		titleKey: "tip.createPrAutoMerge.title",
		bodyKey: "tip.createPrAutoMerge.body",
		icon: "\u{F0623}", // nf-md-source_merge
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.project-github-account",
		titleKey: "tip.projectGitHubAccount.title",
		bodyKey: "tip.projectGitHubAccount.body",
		icon: "\u{F0370}", // nf-md-github
		score: 2,
		contexts: ["settings"],
	},
	{
		id: "builtin:tip.pr-badge-on-card",
		titleKey: "tip.prBadgeOnCard.title",
		bodyKey: "tip.prBadgeOnCard.body",
		icon: "\u{F0401}", // nf-md-source_branch
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.show-diff-button",
		titleKey: "tip.showDiffButton.title",
		bodyKey: "tip.showDiffButton.body",
		icon: "\u{F044B}", // nf-md-source_diff
		score: 4,
		contexts: ["terminal", "diff"],
	},
	{
		id: "builtin:tip.diff-exclude-tests",
		titleKey: "tip.diffExcludeTests.title",
		bodyKey: "tip.diffExcludeTests.body",
		icon: "\u{F0668}", // nf-md-flask_outline
		score: 3,
		contexts: ["diff"],
	},
	{
		id: "builtin:tip.inline-diff-comments",
		titleKey: "tip.inlineDiffComments.title",
		bodyKey: "tip.inlineDiffComments.body",
		icon: "\u{F027B}", // nf-md-comment_plus_outline
		score: 4,
		contexts: ["diff"],
	},
	{
		id: "builtin:tip.inline-diff-review-export",
		titleKey: "tip.inlineDiffReviewExport.title",
		bodyKey: "tip.inlineDiffReviewExport.body",
		icon: "\u{F0198}", // nf-md-content_copy
		score: 4,
		contexts: ["diff"],
	},
	{
		id: "builtin:tip.unpushed-diff",
		titleKey: "tip.unpushedDiff.title",
		bodyKey: "tip.unpushedDiff.body",
		icon: "\u{F07E7}", // nf-md-cloud_upload_outline
		score: 3,
		contexts: ["diff"],
	},
	{
		id: "builtin:tip.image-paste-attach",
		titleKey: "tip.imagePasteAttach.title",
		bodyKey: "tip.imagePasteAttach.body",
		icon: "\u{F021F}", // nf-md-image_plus
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.custom-columns",
		titleKey: "tip.customColumns.title",
		bodyKey: "tip.customColumns.body",
		icon: "\u{F0349}", // nf-md-view_column
		score: 4,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.clone-from-url",
		titleKey: "tip.cloneFromUrl.title",
		bodyKey: "tip.cloneFromUrl.body",
		icon: "\u{F02A2}", // nf-md-source_repository
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.terminal-drag-drop-file-path",
		titleKey: "tip.terminalDragDropFilePath.title",
		bodyKey: "tip.terminalDragDropFilePath.body",
		icon: "\u{F0525}", // nf-md-drag
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.file-explorer-insert-path",
		titleKey: "tip.fileExplorerInsertPath.title",
		bodyKey: "tip.fileExplorerInsertPath.body",
		icon: "", // nf-fa-folder_open
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.review-mode-branch",
		titleKey: "tip.reviewModeBranch.title",
		bodyKey: "tip.reviewModeBranch.body",
		icon: "\u{F0804}", // nf-md-code_review
		score: 4,
		contexts: ["diff"],
	},
	{
		id: "builtin:tip.auto-complete-on-pr-merge",
		titleKey: "tip.autoCompleteOnPrMerge.title",
		bodyKey: "tip.autoCompleteOnPrMerge.body",
		icon: "\u{F0382}", // nf-md-source_merge
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.expose-task-ports",
		titleKey: "tip.exposeTaskPorts.title",
		bodyKey: "tip.exposeTaskPorts.body",
		icon: "\u{F0168}", // nf-md-lan_connect
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.resume-agent-session",
		titleKey: "tip.resumeAgentSession.title",
		bodyKey: "tip.resumeAgentSession.body",
		icon: "\u{F040A}", // nf-md-play_circle_outline
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.tmux-action-buttons",
		titleKey: "tip.tmuxActionButtons.title",
		bodyKey: "tip.tmuxActionButtons.body",
		icon: "\u{F0156}", // nf-md-view_split_vertical
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.configurable-agents",
		titleKey: "tip.configurableAgents.title",
		bodyKey: "tip.configurableAgents.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 4,
		contexts: ["settings"],
		settingsSection: "agents",
	},
	{
		id: "builtin:tip.git-branch-status",
		titleKey: "tip.gitBranchStatus.title",
		bodyKey: "tip.gitBranchStatus.body",
		icon: "\u{F062C}", // nf-md-source_branch
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.warn-before-complete",
		titleKey: "tip.warnBeforeComplete.title",
		bodyKey: "tip.warnBeforeComplete.body",
		icon: "\u{F0F09}", // nf-md-alert_circle_outline
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.cow-clone-paths",
		titleKey: "tip.cowClonePaths.title",
		bodyKey: "tip.cowClonePaths.body",
		icon: "\u{F0198}", // nf-md-content_copy
		score: 5,
		contexts: ["settings"],
	},
	{
		id: "builtin:tip.keyboard-shortcuts-panel",
		titleKey: "tip.keyboardShortcutsPanel.title",
		bodyKey: "tip.keyboardShortcutsPanel.body",
		icon: "\u{F030D}", // nf-md-keyboard
		score: 3,
		contexts: ["board", "terminal", "diff"],
	},
	{
		id: "builtin:tip.tmux-session-manager",
		titleKey: "tip.tmuxSessionManager.title",
		bodyKey: "tip.tmuxSessionManager.body",
		icon: "\u{F0313}", // nf-md-console
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.cli-tool",
		titleKey: "tip.cliTool.title",
		bodyKey: "tip.cliTool.body",
		icon: "\u{F0A9E}", // nf-md-terminal
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.cli-dev-server",
		titleKey: "tip.cliDevServer.title",
		bodyKey: "tip.cliDevServer.body",
		icon: "\u{F0A9E}", // nf-md-terminal
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.diff-snapshots",
		titleKey: "tip.diffSnapshots.title",
		bodyKey: "tip.diffSnapshots.body",
		icon: "\u{F0804}", // nf-md-history
		score: 4,
		contexts: ["diff"],
	},
	{
		id: "builtin:tip.branch-selector-task-creation",
		titleKey: "tip.branchSelectorTaskCreation.title",
		bodyKey: "tip.branchSelectorTaskCreation.body",
		icon: "\u{F062C}", // nf-md-source_branch
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.resume-conversation-on-reopen",
		titleKey: "tip.resumeConversationOnReopen.title",
		bodyKey: "tip.resumeConversationOnReopen.body",
		icon: "\u{F040A}", // nf-md-restore
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.custom-task-title",
		titleKey: "tip.customTaskTitle.title",
		bodyKey: "tip.customTaskTitle.body",
		icon: "\u{F0B5B}", // nf-md-pencil
		score: 2,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.spawn-extra-agent",
		titleKey: "tip.spawnExtraAgent.title",
		bodyKey: "tip.spawnExtraAgent.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.task-open-mode",
		titleKey: "tip.taskOpenMode.title",
		bodyKey: "tip.taskOpenMode.body",
		icon: "\u{F0124}", // nf-md-fullscreen
		score: 4,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.fork-branch-support",
		titleKey: "tip.forkBranchSupport.title",
		bodyKey: "tip.forkBranchSupport.body",
		icon: "\u{F062C}", // nf-md-source_branch
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.restart-task-from-scratch",
		titleKey: "tip.restartTaskFromScratch.title",
		bodyKey: "tip.restartTaskFromScratch.body",
		icon: "\u{F0450}", // nf-md-refresh
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.shell-after-agent-exit",
		titleKey: "tip.shellAfterAgentExit.title",
		bodyKey: "tip.shellAfterAgentExit.body",
		icon: "\u{F0313}", // nf-md-console
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.worktree-file-filter",
		titleKey: "tip.worktreeFileFilter.title",
		bodyKey: "tip.worktreeFileFilter.body",
		icon: "\u{F024B}", // nf-md-filter
		score: 3,
		contexts: ["diff"],
	},
	{
		id: "builtin:tip.repo-local-config",
		titleKey: "tip.repoLocalConfig.title",
		bodyKey: "tip.repoLocalConfig.body",
		icon: "\u{F0493}", // nf-md-share_variant
		score: 4,
		contexts: ["settings"],
	},
	{
		id: "builtin:tip.ai-review-drag",
		titleKey: "tip.aiReviewDrag.title",
		bodyKey: "tip.aiReviewDrag.body",
		icon: "\u{F0804}", // nf-md-code_review
		score: 5,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.ai-review-customize",
		titleKey: "tip.aiReviewCustomize.title",
		bodyKey: "tip.aiReviewCustomize.body",
		icon: "\u{F0493}", // nf-md-tune_variant
		score: 3,
		contexts: ["settings"],
	},
	{
		id: "builtin:tip.custom-column-agents",
		titleKey: "tip.customColumnAgents.title",
		bodyKey: "tip.customColumnAgents.body",
		icon: "\u{F0219}", // nf-md-robot
		score: 4,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.rename-builtin-columns",
		titleKey: "tip.renameBuiltinColumns.title",
		bodyKey: "tip.renameBuiltinColumns.body",
		icon: "\u{F0B5B}", // nf-md-pencil
		score: 2,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.worktree-config",
		titleKey: "tip.worktreeConfig.title",
		bodyKey: "tip.worktreeConfig.body",
		icon: "\u{F0645}", // nf-md-file_tree
		score: 3,
		contexts: ["settings"],
	},
	{
		id: "builtin:tip.project-terminal",
		titleKey: "tip.projectTerminal.title",
		bodyKey: "tip.projectTerminal.body",
		icon: "\u{F0489}", // nf-md-console
		score: 3,
		contexts: ["terminal", "board"],
	},
	{
		id: "builtin:tip.port-allocation",
		titleKey: "tip.portAllocation.title",
		bodyKey: "tip.portAllocation.body",
		icon: "\u{F0317}", // nf-md-ethernet
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.resource-usage-badge",
		titleKey: "tip.resourceUsageBadge.title",
		bodyKey: "tip.resourceUsageBadge.body",
		icon: "\u{F035B}",
		score: 3,
		contexts: ["terminal", "board"],
	},
	{
		id: "builtin:tip.task-watch-notifications",
		titleKey: "tip.taskWatch.title",
		bodyKey: "tip.taskWatch.body",
		icon: "\u{F009A}", // nf-md-bell
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.prevent-sleep",
		titleKey: "tip.preventSleep.title",
		bodyKey: "tip.preventSleep.body",
		icon: String.fromCharCode(0xec15), // nf-cod-coffee
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.copy-worktree-path",
		titleKey: "tip.copyWorktreePath.title",
		bodyKey: "tip.copyWorktreePath.body",
		icon: "\u{F0198}", // nf-md-content_copy
		score: 2,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.folder-picker-paste-path",
		titleKey: "tip.folderPickerPastePath.title",
		bodyKey: "tip.folderPickerPastePath.body",
		icon: "\u{F0770}", // nf-md-folder_open
		score: 2,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.kanban-git-pull",
		titleKey: "tip.kanbanGitPull.title",
		bodyKey: "tip.kanbanGitPull.body",
		icon: "\u{F0164}", // nf-md-cloud_download_outline
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.init-new-project",
		titleKey: "tip.initNewProject.title",
		bodyKey: "tip.initNewProject.body",
		icon: "\u{F0415}", // nf-md-plus_box
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.sidebar-global-scope",
		titleKey: "tip.sidebarGlobalScope.title",
		bodyKey: "tip.sidebarGlobalScope.body",
		icon: "", // nf-cod-globe
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.scratch-task",
		titleKey: "tip.scratchTask.title",
		bodyKey: "tip.scratchTask.body",
		icon: "\u{F018D}", // nf-md-console
		score: 4,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.bug-hunters-lightbox",
		titleKey: "tip.bugHunters.title",
		bodyKey: "tip.bugHunters.body",
		icon: "", // nf-fa-bug
		score: 5,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.multi-window",
		titleKey: "tip.multiWindow.title",
		bodyKey: "tip.multiWindow.body",
		icon: "\u{F05C2}", // nf-md-window_restore
		score: 4,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.multi-folder-add-project",
		titleKey: "tip.multiFolderAddProject.title",
		bodyKey: "tip.multiFolderAddProject.body",
		icon: "\u{F0770}", // nf-md-folder_open
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.skill-autocomplete",
		titleKey: "tip.skillAutocomplete.title",
		bodyKey: "tip.skillAutocomplete.body",
		icon: "\u{F0349}", // nf-md-magic_staff
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.projects-daily-backup",
		titleKey: "tip.projectsDailyBackup.title",
		bodyKey: "tip.projectsDailyBackup.body",
		icon: "\u{F006F}", // nf-md-backup_restore
		score: 3,
		contexts: ["board", "settings"],
	},
	{
		id: "builtin:tip.agent-completion-request",
		titleKey: "tip.agentCompletionRequest.title",
		bodyKey: "tip.agentCompletionRequest.body",
		icon: "\u{F06A9}", // nf-md-robot
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.task-switcher-option-tab",
		titleKey: "tip.taskSwitcher.title",
		bodyKey: "tip.taskSwitcher.body",
		icon: "\u{F030C}", // nf-md-keyboard
		score: 4,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.paste-large-text",
		titleKey: "tip.pasteLargeText.title",
		bodyKey: "tip.pasteLargeText.body",
		icon: "\u{F0192}", // nf-md-file_document_outline
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.task-hint-nav",
		titleKey: "tip.taskHintNav.title",
		bodyKey: "tip.taskHintNav.body",
		icon: "", // nf-fa-crosshairs
		score: 4,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.keyboard-go-to",
		titleKey: "tip.keyboardGoTo.title",
		bodyKey: "tip.keyboardGoTo.body",
		icon: "", // nf-fa-keyboard_o
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.terminal-select-copies",
		titleKey: "tip.terminalSelectCopies.title",
		bodyKey: "tip.terminalSelectCopies.body",
		icon: "\u{F0198}", // nf-md-content_copy
		score: 5,
		contexts: ["terminal", "preparing"],
	},
	{
		id: "builtin:tip.agent-can-ping-you",
		titleKey: "tip.agentCanPingYou.title",
		bodyKey: "tip.agentCanPingYou.body",
		icon: "\u{F009A}", // nf-md-bell_ring
		score: 4,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.focus-mode-mutes-pings",
		titleKey: "tip.focusModeMutesPings.title",
		bodyKey: "tip.focusModeMutesPings.body",
		icon: "\u{F0BB0}", // nf-md-bell_off
		score: 4,
		contexts: ["board", "terminal"],
		settingsSection: "notifications",
	},
	{
		id: "builtin:tip.pr-ci-review-badges",
		titleKey: "tip.prCiReviewBadges.title",
		bodyKey: "tip.prCiReviewBadges.body",
		icon: "\u{F0E1D}", // nf-md-source_pull
		score: 4,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.operations-board",
		titleKey: "tip.operationsBoard.title",
		bodyKey: "tip.operationsBoard.body",
		icon: "", // nf-fa-terminal
		score: 4,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.operations-history",
		titleKey: "tip.operationsHistory.title",
		bodyKey: "tip.operationsHistory.body",
		icon: "\u{F0297}", // nf-md-history
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.browser-notifications",
		titleKey: "tip.browserNotifications.title",
		bodyKey: "tip.browserNotifications.body",
		icon: "\uF0F3", // nf-fa-bell
		score: 4,
		contexts: ["settings", "board"],
		settingsSection: "notifications",
	},
	{
		id: "builtin:tip.remote-detach-lifecycle",
		titleKey: "tip.remoteDetachLifecycle.title",
		bodyKey: "tip.remoteDetachLifecycle.body",
		icon: "\u{F048D}", // nf-md-server
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.productivity-stats",
		titleKey: "tip.productivityStats.title",
		bodyKey: "tip.productivityStats.body",
		icon: "\u{F04C5}", // nf-md-speedometer
		score: 4,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.mobile-pane-pager",
		titleKey: "tip.mobilePanePager.title",
		bodyKey: "tip.mobilePanePager.body",
		icon: "\u{F0BCA}", // nf-md-arrow_left_right
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.alt-click-move-cursor",
		titleKey: "tip.altClickMoveCursor.title",
		bodyKey: "tip.altClickMoveCursor.body",
		icon: "\u{F0453}", // nf-md-cursor_move
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.stats-token-cost",
		titleKey: "tip.statsTokenCost.title",
		bodyKey: "tip.statsTokenCost.body",
		icon: "\u{F0BC5}", // nf-md-cash_multiple
		score: 3,
		contexts: ["board"],
	},
	{
		id: "builtin:tip.agent-show-image",
		titleKey: "tip.agentShowImage.title",
		bodyKey: "tip.agentShowImage.body",
		icon: "\u{F02E9}", // nf-md-image
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.mobile-composer",
		titleKey: "tip.mobileComposer.title",
		bodyKey: "tip.mobileComposer.body",
		icon: "\u{F030C}", // nf-md-keyboard
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.close-pane-picker",
		titleKey: "tip.closePanePicker.title",
		bodyKey: "tip.closePanePicker.body",
		icon: "\u{F0156}", // nf-md-close_box_outline
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.help-mode",
		titleKey: "tip.helpMode.title",
		bodyKey: "tip.helpMode.body",
		icon: "\u{F02FD}", // nf-md-information_outline
		score: 4,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.automations",
		titleKey: "tip.automations.title",
		bodyKey: "tip.automations.body",
		icon: "\u{F0150}", // nf-md-clock_outline
		score: 4,
		contexts: ["board", "settings"],
	},
	{
		id: "builtin:tip.makefile-targets",
		titleKey: "tip.makefileTargets.title",
		bodyKey: "tip.makefileTargets.body",
		icon: "\u{F0313}", // nf-md-console
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.cli-doctor",
		titleKey: "tip.cliDoctor.title",
		bodyKey: "tip.cliDoctor.body",
		icon: "\u{F0F1}", // nf-fa-stethoscope
		score: 3,
		contexts: ["board", "settings"],
	},
	{
		id: "builtin:tip.llm-provider",
		titleKey: "tip.llmProvider.title",
		bodyKey: "tip.llmProvider.body",
		icon: "\u{F0E7}", // nf-fa-cloud
		score: 4,
		contexts: ["settings"],
		settingsSection: "agents",
	},
	{
		id: "builtin:tip.filter-tokens",
		titleKey: "tip.filterTokens.title",
		bodyKey: "tip.filterTokens.body",
		icon: "\u{F0232}", // nf-md-filter
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.cycle-task-variants",
		titleKey: "tip.cycleTaskVariants.title",
		bodyKey: "tip.cycleTaskVariants.body",
		icon: "\u{F0600}", // nf-md-keyboard
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.mobile-task-git",
		titleKey: "tip.mobileTaskGit.title",
		bodyKey: "tip.mobileTaskGit.body",
		icon: "\u{F062C}", // nf-md-source_branch
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.terminal-search",
		titleKey: "tip.terminalSearch.title",
		bodyKey: "tip.terminalSearch.body",
		icon: "\u{F0349}", // nf-md-magnify
		score: 3,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.terminal-path-links",
		titleKey: "tip.terminalPathLinks.title",
		bodyKey: "tip.terminalPathLinks.body",
		icon: "\u{F0219}", // nf-md-file_find
		score: 4,
		contexts: ["terminal"],
		settingsSection: "terminal",
	},
	{
		id: "builtin:tip.streamer-mode",
		titleKey: "tip.streamerMode.title",
		bodyKey: "tip.streamerMode.body",
		icon: "\u{F0567}", // nf-md-video
		score: 3,
		contexts: ["settings", "board"],
		settingsSection: "appearance",
	},
	{
		id: "builtin:tip.cli-doctor-worktrees",
		titleKey: "tip.cliDoctorWorktrees.title",
		bodyKey: "tip.cliDoctorWorktrees.body",
		icon: "\u{F0A0}", // nf-fa-hdd_o
		score: 4,
		contexts: ["board", "settings"],
	},
	{
		id: "builtin:tip.share-artifact-link",
		titleKey: "tip.shareArtifactLink.title",
		bodyKey: "tip.shareArtifactLink.body",
		icon: "\u{F0337}", // nf-md-link_variant
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.model-catalog-roles",
		titleKey: "tip.modelCatalogRoles.title",
		bodyKey: "tip.modelCatalogRoles.body",
		icon: "\u{F0BC5}", // nf-md-swap_horizontal_variant
		score: 4,
		contexts: ["settings", "board"],
		settingsSection: "models",
	},
	{
		id: "builtin:tip.spaceSearch",
		titleKey: "tip.spaceSearch.title",
		bodyKey: "tip.spaceSearch.body",
		icon: "\u{F0E76}", // nf-md-shape_outline
		score: 3,
		contexts: ["board", "terminal"],
	},
	{
		id: "builtin:tip.remote-self-update",
		titleKey: "tip.remoteSelfUpdate.title",
		bodyKey: "tip.remoteSelfUpdate.body",
		icon: "\u{F06B0}", // nf-md-cloud_sync
		score: 3,
		contexts: ["board", "settings"],
		settingsSection: "system",
	},
	// Score 3: the log is real hidden value (30 days of agent-to-agent history that
	// used to exist only as a 30-second toast), reachable by a shortcut nothing on
	// screen advertises — but only a board running several agents ever needs it.
	{
		id: "builtin:tip.agent-traffic-log",
		titleKey: "tip.agentTrafficLog.title",
		bodyKey: "tip.agentTrafficLog.body",
		icon: "\u{F01D9}", // nf-md-swap_horizontal
		score: 3,
		contexts: ["board", "terminal"],
		when: () => getAgentTrafficEnabled() && !isControlHidden("agent-traffic"),
	},
	// Distinct from spawn-extra-agent: that one is "more hands on the same work",
	// this one is "the same work, a different agent". Invisible until the dialog is
	// already open, and nothing else in the product hints that a switch is possible.
	{
		id: "builtin:tip.continue-in-another-agent",
		titleKey: "tip.continueInAnotherAgent.title",
		bodyKey: "tip.continueInAnotherAgent.body",
		icon: "\u{F0450}", // nf-md-account_switch
		score: 4,
		contexts: ["terminal"],
	},
	{
		id: "builtin:tip.rename-terminal-window",
		titleKey: "tip.renameTerminalWindow.title",
		bodyKey: "tip.renameTerminalWindow.body",
		icon: "\u{F0B5B}", // nf-md-pencil
		score: 3,
		contexts: ["terminal"],
	},
];

export function installTipBuiltins(ctx: Context): Fiber {
	return ctx.plugin({
		name: TIPS_BUILTIN_ID,
		inject: ["tips"],
		apply(pluginCtx: Context) {
			for (const def of BUILTIN_TIPS) pluginCtx.tips.register(def);
		},
	});
}

/** Required: the tips have no other source, and the user already turns them off in Settings. */
export const BUILTIN_TIPS_PLUGIN: BuiltinPlugin = {
	id: TIPS_BUILTIN_ID,
	required: true,
	install: installTipBuiltins,
};
