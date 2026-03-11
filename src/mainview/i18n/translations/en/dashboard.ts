const dashboard = {
	// Dashboard
	"dashboard.noProjects": "No projects yet",
	"dashboard.noProjectsHint": "Add a git repository to get started",
	"dashboard.addProject": "Add Project",
	"dashboard.openInFinder": "Open in Finder",
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
	"header.openFolderTooltip": "Open project folder",
	"header.projLabel": "Proj",
	"header.globalLabel": "Global",
	"header.devServer": "Dev Server",
	"header.devServerDisabled": "Configure dev script in Project Settings",
	"header.fileBrowser": "Files",
	"header.changelog": "Changelog",
	"header.changelogLabel": "Change Log",
	"header.changelogTooltip": "View changelog",
	"header.githubTooltip": "Website",
	"header.reportBugTooltip": "Report a bug",
	"header.reportLabel": "Report",
	"header.switchProject": "Switch project",
	"header.activeTaskCount_one": "{count} active",
	"header.activeTaskCount_other": "{count} active",
	"header.noActiveTasks": "No active tasks",

	// FileBrowser
	"fileBrowser.notInstalledTitle": "yazi is not installed",
	"fileBrowser.notInstalledDesc": "The file browser requires yazi. Run the command below to install it:",
	"fileBrowser.linuxBrewHint": "Install Homebrew for Linux first (https://brew.sh), then run:",
	"fileBrowser.clickAgainHint": "After installation, click Files again and it will work.",
} as const;

export default dashboard;
