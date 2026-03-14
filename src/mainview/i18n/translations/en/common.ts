const common = {
	// App
	"app.loading": "Loading...",
	"app.branchMergedTitle": "Branch Merged",
	"app.branchMergedMessage": "All changes from \"{branchName}\" are now in the base branch.\n\nTask: {taskTitle}\n\nMark this task as completed?",

	// Quit dialog
	"quit.dialogTitle": "Sessions keep running",
	"quit.dialogMessage": "Your terminal sessions will continue running in tmux after quitting. You can reattach to them when you reopen the app.",
	"quit.dontShowAgain": "Don't show again",
	"quit.confirm": "Quit",
	"quit.cancel": "Cancel",

	// Status labels
	"status.todo": "To Do",
	"status.inProgress": "Agent is Working",
	"status.userQuestions": "Has Questions",
	"status.reviewByAi": "AI Review",
	"status.reviewByUser": "Your Review",
	"status.reviewByColleague": "PR Review",
	"status.completed": "Completed",
	"status.cancelled": "Cancelled",

	// Status descriptions (info tooltips for column headers)
	"status.todo.desc": "Tasks waiting to be picked up by an agent.",
	"status.inProgress.desc": "An AI agent is actively working on this task.",
	"status.userQuestions.desc": "The agent needs your input before it can continue.",
	"status.reviewByAi.desc": "Automated AI review of completed work. May return to the agent for fixes.",
	"status.reviewByUser.desc": "Ready for your review. Create a PR when satisfied.",
	"status.reviewByColleague.desc": "PR is created and under review by bots or teammates.",
	"status.completed.desc": "Done — PR merged or task finished.",
	"status.cancelled.desc": "Task was cancelled and its worktree cleaned up.",

	// ActiveTasksSidebar
	"sidebar.activeTasks": "Active Tasks",
	"sidebar.noActiveTasks": "No active tasks",
	"sidebar.noSearchResults": "No tasks match your search",
	"sidebar.searchPlaceholder": "Search tasks...",
	"sidebar.switchToBoard": "Show board",
	"sidebar.switchToSidebar": "Show sidebar",

	// Open in...
	"openIn.menuTitle": "Open in...",
	"openIn.noAppsFound": "No external apps found",
	"openIn.failedOpen": "Failed to open in {app}: {error}",

	// GitHub CLI warning banner
	"ghWarning.titleNotInstalled": "GitHub CLI (gh) is not installed",
	"ghWarning.titleNotAuthenticated": "GitHub CLI (gh) is not signed in",
	"ghWarning.messageNotInstalled": "Some features won't work without it: automatic PR detection, task promotion to \"PR Review\", and merge detection via GitHub. Install gh and run `gh auth login` to enable them.",
	"ghWarning.messageNotAuthenticated": "Some features won't work without authentication: automatic PR detection, task promotion to \"PR Review\", and merge detection via GitHub. Run `gh auth login` to enable them.",
	"ghWarning.dismiss": "Got it",
	"ghWarning.dontShowAgain": "Don't show this again",

	// Unsaved changes guard
	"unsavedChanges.title": "Unsaved Changes",
	"unsavedChanges.message": "You have unsaved changes in project settings. What would you like to do?",
	"unsavedChanges.save": "Save",
	"unsavedChanges.discard": "Discard",
	"unsavedChanges.cancel": "Cancel",
	"unsavedChanges.banner": "You have unsaved changes",
} as const;

export default common;
