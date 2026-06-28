const keymap = {
	// Keyboard shortcuts reference overlay (KeyboardShortcutsModal)
	"keymap.title": "Keyboard Shortcuts",
	"keymap.subtitle": "All app and terminal shortcuts in one place",
	"keymap.tab.app": "App",
	"keymap.tab.terminal": "Terminal (tmux)",
	"keymap.footerEscape": "Esc to close",
	"keymap.remoteNotice":
		"You're in the browser. Some combos (⌘1–9, ⌘N, zoom, refresh) are reserved by your browser — use the shown alternatives or the Command Palette (⇧⌘P).",

	// Categories (App tab)
	"keymap.category.navigation": "Navigation",
	"keymap.category.create": "Create",
	"keymap.category.view": "View & Zoom",
	"keymap.category.terminal": "Terminal",
	"keymap.category.app": "Application",

	// Shortcut descriptions (App tab)
	"keymap.shortcut.goToProject": "Go to project (quick switch)",
	"keymap.shortcut.commandPalette": "Command palette",
	"keymap.shortcut.back": "Back",
	"keymap.shortcut.forward": "Forward",
	"keymap.shortcut.switchProject": "Switch to project 1–9 (keep current view)",
	"keymap.shortcut.switchProjectFlip": "Switch to project 1–9 (flip board/task view)",
	"keymap.shortcut.jumpOperations": "Jump to the Operations board",
	"keymap.shortcut.taskSwitcher": "Cycle active tasks (this project)",
	"keymap.shortcut.taskSwitcherGlobal": "Cycle active tasks (all projects)",
	"keymap.shortcut.taskHints": "Jump to a task or project by hint",
	"keymap.shortcut.goTo": "Go to… (D dashboard · P project · T tasks · S settings · digit = project N; P/T + digit = project N board/tasks)",
	"keymap.shortcut.focusSearch": "Focus search",
	"keymap.shortcut.escape": "Close dialog / step back",
	"keymap.shortcut.newTask": "New task",
	"keymap.shortcut.addProject": "Add project",
	"keymap.shortcut.newWindow": "New window",
	"keymap.shortcut.settings": "Settings",
	"keymap.shortcut.zoomIn": "Zoom in",
	"keymap.shortcut.zoomOut": "Zoom out",
	"keymap.shortcut.zoomReset": "Reset zoom",
	"keymap.shortcut.hardRefresh": "Hard refresh",
	"keymap.shortcut.keyboardShortcuts": "Show this keyboard shortcuts panel",
	"keymap.shortcut.toggleProjectTerminal": "Toggle project terminal",
	"keymap.shortcut.openQuickShell": "Open Quick Shell",
	"keymap.shortcut.quit": "Quit",
	"keymap.shortcut.hide": "Hide app",
} as const;

export default keymap;
