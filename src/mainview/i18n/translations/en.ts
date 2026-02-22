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

	// GlobalSettings
	"settings.theme": "Theme",
	"settings.themeDark": "Dark",
	"settings.themeDarkDesc": "Midnight indigo",
	"settings.themeLight": "Light",
	"settings.themeLightDesc": "Clean & bright",
	"settings.language": "Language",

	// KanbanColumn
	"kanban.noTasks": "No tasks",
	"kanban.taskPlaceholder": "Task title...",
	"kanban.add": "Add",
	"kanban.cancel": "Cancel",
	"kanban.newTask": "+ New Task",
	"kanban.failedCreate": "Failed to create task: {error}",

	// CreateTaskModal
	"createTask.title": "New Task",
	"createTask.nameLabel": "Title",
	"createTask.statusLabel": "Status",
	"createTask.create": "Create",
	"createTask.creating": "Creating...",

	// TaskCard
	"task.moveTo": "Move to",
	"task.delete": "Delete",
	"task.confirmDelete": "Delete task \"{title}\"?",
	"task.failedMove": "Failed to move task: {error}",
	"task.failedDelete": "Failed to delete task: {error}",

	// ProjectSettings
	"projectSettings.setupScript": "Setup Script",
	"projectSettings.setupScriptDesc":
		"Runs in the worktree directory after creation",
	"projectSettings.defaultCommand": "Default Command",
	"projectSettings.defaultCommandDesc":
		"Command to run inside tmux for new tasks",
	"projectSettings.baseBranch": "Base Branch",
	"projectSettings.baseBranchDesc": "Branch to create worktrees from",
	"projectSettings.save": "Save Settings",
	"projectSettings.saving": "Saving...",
	"projectSettings.failedSave": "Failed to save settings: {error}",

	// ProjectView
	"project.notFound": "Project not found",

	// TaskTerminal
	"terminal.connecting": "Connecting...",

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
