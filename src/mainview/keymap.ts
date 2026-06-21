import type { TranslationKey } from "./i18n";
import { isMac } from "./utils/platform";

/**
 * Single source of truth for every APP-LEVEL keyboard shortcut.
 *
 * This registry DOCUMENTS the keymap — it does not dispatch it. The actual
 * handlers live in `App.tsx` (the `useGlobalShortcut` chain) and
 * `hooks/useTaskSwitcher.ts`; the native-menu accelerators live in
 * `src/bun/application-menu.ts`. This array is what the KeyboardShortcutsModal,
 * the README table, and the website render from, so any newly added app-level
 * shortcut MUST get an entry here (a test guards basic validity; staying in
 * lockstep with the handlers is a maintenance discipline — see AGENTS.md).
 *
 * Terminal/tmux prefix bindings (⌃B …) are NOT here — they are owned by tmux
 * (`src/bun/tmux-config.ts`) and shown on the modal's Terminal tab.
 */

export type ShortcutCategory = "navigation" | "create" | "view" | "terminal" | "app";

export interface ShortcutSpec {
	/** Stable, unique id. */
	id: string;
	/** Rendered key combo per platform (macOS uses ⌘/⌥, Linux uses Ctrl/Alt). */
	keys: { mac: string; other: string };
	/** i18n key for the human description. */
	descKey: TranslationKey;
	category: ShortcutCategory;
}

/** Display order of categories in the App tab. */
export const SHORTCUT_CATEGORY_ORDER: ShortcutCategory[] = [
	"navigation",
	"create",
	"view",
	"terminal",
	"app",
];

export const SHORTCUT_CATEGORY_KEY: Record<ShortcutCategory, TranslationKey> = {
	navigation: "keymap.category.navigation",
	create: "keymap.category.create",
	view: "keymap.category.view",
	terminal: "keymap.category.terminal",
	app: "keymap.category.app",
};

export const APP_SHORTCUTS: ShortcutSpec[] = [
	// ── Navigation ──
	{ id: "go-to-project", keys: { mac: "⌘K", other: "Ctrl+K" }, descKey: "keymap.shortcut.goToProject", category: "navigation" },
	{ id: "command-palette", keys: { mac: "⇧⌘P", other: "Ctrl+Shift+P" }, descKey: "keymap.shortcut.commandPalette", category: "navigation" },
	{ id: "back", keys: { mac: "⌘[", other: "Ctrl+[" }, descKey: "keymap.shortcut.back", category: "navigation" },
	{ id: "forward", keys: { mac: "⌘]", other: "Ctrl+]" }, descKey: "keymap.shortcut.forward", category: "navigation" },
	{ id: "switch-project", keys: { mac: "⌘1–9", other: "Ctrl+1–9" }, descKey: "keymap.shortcut.switchProject", category: "navigation" },
	{ id: "switch-project-flip", keys: { mac: "⇧⌘1–9", other: "Ctrl+Shift+1–9" }, descKey: "keymap.shortcut.switchProjectFlip", category: "navigation" },
	{ id: "task-switcher", keys: { mac: "⌥Tab", other: "Ctrl+Tab" }, descKey: "keymap.shortcut.taskSwitcher", category: "navigation" },
	{ id: "task-switcher-global", keys: { mac: "⌥⇧Tab", other: "Ctrl+Shift+Tab" }, descKey: "keymap.shortcut.taskSwitcherGlobal", category: "navigation" },
	{ id: "task-hints", keys: { mac: "F / ⌘G", other: "F / Ctrl+G" }, descKey: "keymap.shortcut.taskHints", category: "navigation" },
	{ id: "go-to", keys: { mac: "G then D/P/T/S", other: "G then D/P/T/S" }, descKey: "keymap.shortcut.goTo", category: "navigation" },
	{ id: "focus-search", keys: { mac: "/", other: "/" }, descKey: "keymap.shortcut.focusSearch", category: "navigation" },
	{ id: "escape", keys: { mac: "Esc", other: "Esc" }, descKey: "keymap.shortcut.escape", category: "navigation" },

	// ── Create ──
	{ id: "new-task", keys: { mac: "⌘N / C", other: "Ctrl+N / C" }, descKey: "keymap.shortcut.newTask", category: "create" },
	{ id: "add-project", keys: { mac: "⌘P", other: "Ctrl+P" }, descKey: "keymap.shortcut.addProject", category: "create" },
	{ id: "new-window", keys: { mac: "⇧⌘N", other: "Ctrl+Shift+N" }, descKey: "keymap.shortcut.newWindow", category: "create" },

	// ── View & Zoom ──
	{ id: "settings", keys: { mac: "⌘,", other: "Ctrl+," }, descKey: "keymap.shortcut.settings", category: "view" },
	{ id: "zoom-in", keys: { mac: "⌘=", other: "Ctrl+=" }, descKey: "keymap.shortcut.zoomIn", category: "view" },
	{ id: "zoom-out", keys: { mac: "⌘-", other: "Ctrl+-" }, descKey: "keymap.shortcut.zoomOut", category: "view" },
	{ id: "zoom-reset", keys: { mac: "⌘0", other: "Ctrl+0" }, descKey: "keymap.shortcut.zoomReset", category: "view" },
	{ id: "hard-refresh", keys: { mac: "⌘R", other: "Ctrl+R" }, descKey: "keymap.shortcut.hardRefresh", category: "view" },
	{ id: "keyboard-shortcuts", keys: { mac: "⌘/", other: "Ctrl+/" }, descKey: "keymap.shortcut.keyboardShortcuts", category: "view" },

	// ── Terminal ──
	{ id: "toggle-project-terminal", keys: { mac: "⌘`", other: "Ctrl+`" }, descKey: "keymap.shortcut.toggleProjectTerminal", category: "terminal" },
	{ id: "toggle-home-terminal", keys: { mac: "⇧⌘`", other: "Ctrl+Shift+`" }, descKey: "keymap.shortcut.toggleHomeTerminal", category: "terminal" },

	// ── Application ──
	{ id: "quit", keys: { mac: "⌘Q", other: "Ctrl+Q" }, descKey: "keymap.shortcut.quit", category: "app" },
	{ id: "hide", keys: { mac: "⌘H", other: "Ctrl+H" }, descKey: "keymap.shortcut.hide", category: "app" },
];

/** The key combo to display for a shortcut on the current platform. */
export function shortcutKeysFor(spec: ShortcutSpec, mac: boolean = isMac()): string {
	return mac ? spec.keys.mac : spec.keys.other;
}

/** Shortcuts of one category, in registry order. */
export function shortcutsInCategory(category: ShortcutCategory): ShortcutSpec[] {
	return APP_SHORTCUTS.filter((s) => s.category === category);
}
