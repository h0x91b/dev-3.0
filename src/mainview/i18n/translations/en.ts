const en = {
	// App
	"app.loading": "Loading...",

	// Dashboard
	"dashboard.noProjects": "No projects yet",
	"dashboard.noProjectsHint": "Add a git repository to get started",
	"dashboard.addProject": "Add Project",
	"dashboard.remove": "Remove",
	"dashboard.confirmRemove": "Remove this project from the list?",
	"dashboard.failedAdd": "Failed to add project: {error}",
	"dashboard.failedRemove": "Failed to remove project: {error}",
	"dashboard.projectCount_one": "{count} project",
	"dashboard.projectCount_other": "{count} projects",

	// GlobalHeader
	"header.task": "Task",
	"header.settings": "Settings",
	"header.projectSettings": "Project Settings",
	"header.globalSettingsTooltip": "Global Settings (\u2318,)",
	"header.projLabel": "Proj",
	"header.globalLabel": "Global",
	"header.devServer": "Dev Server",
	"header.devServerDisabled": "Configure dev script in Project Settings",

	// GlobalSettings
	"settings.theme": "Theme",
	"settings.themeDark": "Dark",
	"settings.themeDarkDesc": "Midnight indigo",
	"settings.themeLight": "Light",
	"settings.themeLightDesc": "Clean & bright",
	"settings.language": "Language",
	"settings.agents": "Coding Agents",
	"settings.addAgent": "Add Agent",
	"settings.agentName": "Name",
	"settings.agentBaseCommand": "Base Command",
	"settings.configurations": "Configurations",
	"settings.addConfig": "Add Configuration",
	"settings.configName": "Name",
	"settings.configModel": "Model",
	"settings.configAppendPrompt": "Append Prompt",
	"settings.configAppendPromptHint": "Appended to task description. Use {{TASK_TITLE}}, {{TASK_DESCRIPTION}}, {{PROJECT_NAME}}, {{PROJECT_PATH}}, {{WORKTREE_PATH}} template variables.",
	"settings.configAdditionalArgs": "Additional Arguments",
	"settings.configAddArg": "Add Argument",
	"settings.configEnvVars": "Environment Variables",
	"settings.configAddEnvVar": "Add Variable",
	"settings.configBaseCommandOverride": "Base Command Override",
	"settings.deleteAgent": "Delete",
	"settings.deleteConfig": "Delete Configuration",
	"settings.commandPreview": "Command Preview",
	"settings.defaultBadge": "Default",
	"settings.configPermissionMode": "Permission Mode",
	"settings.permDefault": "Default",
	"settings.permPlan": "Plan Mode",
	"settings.permAcceptEdits": "Accept Edits",
	"settings.permDontAsk": "Don't Ask",
	"settings.permBypass": "Bypass Permissions",
	"settings.configEffort": "Effort Level",
	"settings.effortDefault": "Default",
	"settings.effortLow": "Low",
	"settings.effortMedium": "Medium",
	"settings.effortHigh": "High",
	"settings.configMaxBudget": "Max Budget (USD)",
	"settings.configMaxBudgetHint": "Maximum dollar amount for API calls per session",
	"settings.cantDeleteDefault": "Default agents cannot be deleted",
	"settings.defaultAgent": "Default Agent",
	"settings.defaultAgentDesc": "Agent used for new tasks",
	"settings.defaultConfig": "Default Configuration",
	"settings.defaultConfigDesc": "Configuration applied when launching tasks",
	"settings.taskDropPosition": "Task Drop Position",
	"settings.taskDropPositionDesc": "Where moved tasks appear in the destination column",
	"settings.dropToTop": "Top",
	"settings.dropToTopDesc": "Moved tasks appear at the top",
	"settings.dropToBottom": "Bottom",
	"settings.dropToBottomDesc": "Moved tasks appear at the bottom",

	// KanbanColumn
	"kanban.noTasks": "No tasks",
	"kanban.add": "Add",
	"kanban.cancel": "Cancel",
	"kanban.newTask": "+ New Task",
	"kanban.failedCreate": "Failed to create task: {error}",

	// CreateTaskModal
	"createTask.title": "New Task",
	"createTask.descriptionLabel": "Description",
	"createTask.descriptionPlaceholder": "Describe what needs to be done...",
	"createTask.generatedTitle": "Title:",
	"createTask.statusLabel": "Status",
	"createTask.create": "Create",
	"createTask.creating": "Creating...",
	"createTask.submitHint": "\u2318Enter to create",

	// TaskCard
	"task.moveTo": "Move to",
	"task.delete": "Delete",
	"task.confirmDelete": "Delete task \"{title}\"?",
	"task.failedMove": "Failed to move task: {error}",
	"task.failedDelete": "Failed to delete task: {error}",
	"task.run": "Run",
	"task.cancel": "Cancel",
	"task.confirmCancel": "Cancel task \"{title}\"?",
	"task.variant": "#{n}",
	"task.editSave": "Save",
	"task.editCancel": "Cancel",
	"task.failedEdit": "Failed to update task: {error}",
	"task.editHint": "⌘Enter to save",
	"task.bellTooltip": "Needs attention",

	// LaunchVariantsModal
	"launch.title": "Launch Task",
	"launch.agent": "Agent",
	"launch.config": "Configuration",
	"launch.addVariant": "+ Add Variant",
	"launch.removeVariant": "Remove",
	"launch.launch": "Launch",
	"launch.launching": "Launching...",
	"launch.failedLaunch": "Failed to launch: {error}",

	// ProjectSettings
	"projectSettings.setupScript": "Setup Script",
	"projectSettings.setupScriptDesc":
		"Runs in the worktree directory after creation",
	"projectSettings.devScript": "Dev Script",
	"projectSettings.devScriptDesc":
		"Runs when starting the dev server for this project",
	"projectSettings.cleanupScript": "Cleanup Script",
	"projectSettings.cleanupScriptDesc":
		"Runs when a task is moved to Cancelled (or Archived in the future)",
	"projectSettings.baseBranch": "Base Branch",
	"projectSettings.baseBranchDesc": "Branch to create worktrees from",
	"projectSettings.save": "Save Settings",
	"projectSettings.saving": "Saving...",
	"projectSettings.failedSave": "Failed to save settings: {error}",

	// ProjectView
	"project.notFound": "Project not found",

	// TaskTerminal
	"terminal.connecting": "Connecting...",

	// TaskInfoPanel
	"infoPanel.status": "Status",
	"infoPanel.branch": "Branch",
	"infoPanel.description": "Description",
	"infoPanel.worktree": "Worktree",
	"infoPanel.created": "Created",
	"infoPanel.updated": "Updated",
	"infoPanel.collapse": "Collapse panel",
	"infoPanel.expand": "Expand panel",
	"infoPanel.commitsBehind": "{count} commits behind",
	"infoPanel.commitsAhead": "{count} commits ahead",
	"infoPanel.commitsAheadBehind": "{ahead} ahead · {behind} behind",
	"infoPanel.rebase": "Rebase",
	"infoPanel.rebasing": "Rebasing...",
	"infoPanel.rebaseFailed": "Rebase failed: {error}",
	"infoPanel.rebaseConflicts": "Cannot rebase — conflicts detected",
	"infoPanel.merge": "Merge",
	"infoPanel.merging": "Merging...",
	"infoPanel.mergeFailed": "Merge failed: {error}",
	"infoPanel.mergeNotRebased": "Rebase first before merging",

	// Status labels
	"status.todo": "To Do",
	"status.inProgress": "In Progress",
	"status.userQuestions": "User Questions",
	"status.reviewByAi": "Review by AI",
	"status.reviewByUser": "Review by User",
	"status.completed": "Completed",
	"status.cancelled": "Cancelled",
} as const;

export type TranslationKey = keyof typeof en;
export type TranslationRecord = Record<TranslationKey, string>;

export default en;
