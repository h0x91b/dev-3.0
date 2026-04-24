import type { ApplicationMenuItemConfig } from "electrobun/bun";

export const MENU_ACTIONS = {
	about: "about",
	checkForUpdates: "check-for-updates",
	openSettings: "open-settings",
	openNewTask: "open-new-task",
	openAddProject: "open-add-project",
	hardRefresh: "hard-refresh",
	toggleDevtools: "toggle-devtools",
	openLogsDirectory: "open-logs-directory",
	terminalSoftReset: "terminal-soft-reset",
	terminalHardReset: "terminal-hard-reset",
	gaugeDemo: "gauge-demo",
	viewportLab: "viewport-lab",
	zoomIn: "zoom-in",
	zoomOut: "zoom-out",
	zoomReset: "zoom-reset",
	showRemoteQr: "show-remote-qr",
} as const;

export function buildApplicationMenu(): ApplicationMenuItemConfig[] {
	return [
		{
			label: "dev-3.0",
			submenu: [
				{ label: "About dev-3.0", action: MENU_ACTIONS.about },
				{ label: "Check for Updates...", action: MENU_ACTIONS.checkForUpdates },
				{ type: "separator" },
				{ label: "Settings...", action: MENU_ACTIONS.openSettings, accelerator: "," },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "showAll" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "File",
			submenu: [
				{ label: "New Task", action: MENU_ACTIONS.openNewTask, accelerator: "n" },
				{ label: "Add Project...", action: MENU_ACTIONS.openAddProject, accelerator: "p" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "pasteAndMatchStyle" },
				{ role: "delete" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ label: "Hard Refresh", action: MENU_ACTIONS.hardRefresh, accelerator: "r" },
				{ label: "Toggle Developer Tools", action: MENU_ACTIONS.toggleDevtools },
				{ label: "Open Logs Directory", action: MENU_ACTIONS.openLogsDirectory },
				{ type: "separator" },
				{ label: "Soft Reset Terminal", action: MENU_ACTIONS.terminalSoftReset },
				{ label: "Hard Reset Terminal", action: MENU_ACTIONS.terminalHardReset },
				{ type: "separator" },
				{ label: "Gauge Demo", action: MENU_ACTIONS.gaugeDemo },
				{ label: "Viewport Lab", action: MENU_ACTIONS.viewportLab },
				{ type: "separator" },
				{ label: "Zoom In", action: MENU_ACTIONS.zoomIn, accelerator: "=" },
				{ label: "Zoom Out", action: MENU_ACTIONS.zoomOut, accelerator: "-" },
				{ label: "Reset Zoom", action: MENU_ACTIONS.zoomReset, accelerator: "0" },
				{ type: "separator" },
				{ label: "Remote Access QR Code", action: MENU_ACTIONS.showRemoteQr },
				{ type: "separator" },
				{ role: "toggleFullScreen" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				{ type: "separator" },
				{ role: "bringAllToFront" },
				{ role: "cycleThroughWindows" },
				{ role: "close" },
			],
		},
	];
}
