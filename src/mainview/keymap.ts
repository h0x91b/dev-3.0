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
 * (`src/bun/tmux/config.ts`) and shown on the modal's Terminal tab.
 */

export type ShortcutCategory = "navigation" | "create" | "view" | "terminal" | "app";

/**
 * Where a shortcut applies:
 * - `both`    (default) — works in the Electrobun desktop shell and the browser.
 * - `desktop` — desktop-only; hidden + unbound in browser remote mode because
 *               the action is shell-level (quit/hide/new-window) or owned by the
 *               browser itself (native zoom, hard refresh).
 * - `remote`  — remote-only (reserved; none today).
 */
export type ShortcutScope = "both" | "desktop" | "remote";

export interface ShortcutSpec {
	/** Stable, unique id. */
	id: string;
	/** Rendered key combo per platform (macOS uses ⌘/⌥, Linux uses Ctrl/Alt). */
	keys: { mac: string; other: string };
	/** i18n key for the human description. */
	descKey: TranslationKey;
	category: ShortcutCategory;
	/** Transport scope. Defaults to `both` when omitted. */
	scope?: ShortcutScope;
	/**
	 * Browser-safe combo shown (and relied on) in remote mode when the desktop
	 * combo is reserved by the browser. e.g. ⌘1–9 (browser tab switch) → the
	 * `G then 1–9` go-to chord. When omitted, `keys` is used in both modes.
	 */
	remoteKeys?: { mac: string; other: string };
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
	{ id: "back", keys: { mac: "⌘[ / Ctrl+-", other: "Ctrl+[ / Ctrl+-" }, descKey: "keymap.shortcut.back", category: "navigation" },
	{ id: "forward", keys: { mac: "⌘] / Ctrl+Shift+-", other: "Ctrl+] / Ctrl+Shift+-" }, descKey: "keymap.shortcut.forward", category: "navigation" },
	{ id: "previous-variant", keys: { mac: "⇧⌘[", other: "Ctrl+Shift+[" }, descKey: "keymap.shortcut.previousVariant", category: "navigation" },
	{ id: "next-variant", keys: { mac: "⇧⌘]", other: "Ctrl+Shift+]" }, descKey: "keymap.shortcut.nextVariant", category: "navigation" },
	{ id: "switch-project", keys: { mac: "⌘1–9", other: "Ctrl+1–9" }, remoteKeys: { mac: "G then 1–9", other: "G then 1–9" }, descKey: "keymap.shortcut.switchProject", category: "navigation" },
	{ id: "switch-project-flip", keys: { mac: "⇧⌘1–9", other: "Ctrl+Shift+1–9" }, descKey: "keymap.shortcut.switchProjectFlip", category: "navigation" },
	{ id: "jump-operations", keys: { mac: "⌘0", other: "Ctrl+0" }, descKey: "keymap.shortcut.jumpOperations", category: "navigation" },
	{ id: "task-switcher", keys: { mac: "⌥Tab", other: "Ctrl+Tab" }, descKey: "keymap.shortcut.taskSwitcher", category: "navigation" },
	{ id: "task-switcher-global", keys: { mac: "⌥⇧Tab", other: "Ctrl+Shift+Tab" }, descKey: "keymap.shortcut.taskSwitcherGlobal", category: "navigation" },
	{ id: "task-hints", keys: { mac: "F / ⌘G", other: "F / Ctrl+G" }, descKey: "keymap.shortcut.taskHints", category: "navigation" },
	{ id: "go-to", keys: { mac: "G then D/P/T/S/1–9", other: "G then D/P/T/S/1–9" }, descKey: "keymap.shortcut.goTo", category: "navigation" },
	{ id: "focus-search", keys: { mac: "/", other: "/" }, descKey: "keymap.shortcut.focusSearch", category: "navigation" },
	{ id: "escape", keys: { mac: "Esc", other: "Esc" }, descKey: "keymap.shortcut.escape", category: "navigation" },

	// ── Create ──
	{ id: "new-task", keys: { mac: "⌘N / C", other: "Ctrl+N / C" }, remoteKeys: { mac: "C", other: "C" }, descKey: "keymap.shortcut.newTask", category: "create" },
	{ id: "add-project", keys: { mac: "⌘P", other: "Ctrl+P" }, descKey: "keymap.shortcut.addProject", category: "create" },
	{ id: "new-window", keys: { mac: "⇧⌘N", other: "Ctrl+Shift+N" }, descKey: "keymap.shortcut.newWindow", category: "create", scope: "desktop" },

	// ── View & Zoom ──
	{ id: "settings", keys: { mac: "⌘,", other: "Ctrl+," }, descKey: "keymap.shortcut.settings", category: "view" },
	{ id: "zoom-in", keys: { mac: "⌘=", other: "Ctrl+=" }, descKey: "keymap.shortcut.zoomIn", category: "view", scope: "desktop" },
	{ id: "zoom-out", keys: { mac: "⌘-", other: "Ctrl+Alt+-" }, descKey: "keymap.shortcut.zoomOut", category: "view", scope: "desktop" },
	{ id: "zoom-reset", keys: { mac: "⇧⌘0", other: "Ctrl+Shift+0" }, descKey: "keymap.shortcut.zoomReset", category: "view", scope: "desktop" },
	{ id: "hard-refresh", keys: { mac: "⌘R", other: "Ctrl+R" }, descKey: "keymap.shortcut.hardRefresh", category: "view", scope: "desktop" },
	{ id: "keyboard-shortcuts", keys: { mac: "⌘/", other: "Ctrl+/" }, descKey: "keymap.shortcut.keyboardShortcuts", category: "view" },
	{ id: "help-mode", keys: { mac: "⇧⌘/", other: "Ctrl+Shift+/" }, descKey: "keymap.shortcut.helpMode", category: "view" },
	{ id: "terminal-fullscreen", keys: { mac: "F11 / ⇧⌘F", other: "F11 / Ctrl+Shift+F" }, descKey: "keymap.shortcut.terminalFullscreen", category: "view" },

	// ── Terminal ──
	{ id: "toggle-project-terminal", keys: { mac: "⌘`", other: "Ctrl+`" }, descKey: "keymap.shortcut.toggleProjectTerminal", category: "terminal" },
	{ id: "open-quick-shell", keys: { mac: "⇧⌘`", other: "Ctrl+Shift+`" }, descKey: "keymap.shortcut.openQuickShell", category: "terminal" },
	{ id: "terminal-search", keys: { mac: "⌘F", other: "Ctrl+F" }, descKey: "keymap.shortcut.terminalSearch", category: "terminal" },

	// ── Application ──
	{ id: "quit", keys: { mac: "⌘Q", other: "Ctrl+Q" }, descKey: "keymap.shortcut.quit", category: "app", scope: "desktop" },
	{ id: "hide", keys: { mac: "⌘H", other: "Ctrl+H" }, descKey: "keymap.shortcut.hide", category: "app", scope: "desktop" },
];

/** The key combo to display for a shortcut on the current platform. */
export function shortcutKeysFor(spec: ShortcutSpec, mac: boolean = isMac()): string {
	return mac ? spec.keys.mac : spec.keys.other;
}

/**
 * The key combo to display for a shortcut, transport-aware: in remote (browser)
 * mode a `remoteKeys` override wins over `keys` (e.g. ⌘1–9 → `G then 1–9`).
 */
export function shortcutKeysForMode(spec: ShortcutSpec, mac: boolean, remote: boolean): string {
	const combo = remote && spec.remoteKeys ? spec.remoteKeys : spec.keys;
	return mac ? combo.mac : combo.other;
}

/** Whether a shortcut applies under the current transport. */
export function shortcutAppliesInMode(spec: ShortcutSpec, remote: boolean): boolean {
	const scope = spec.scope ?? "both";
	if (scope === "both") return true;
	return remote ? scope === "remote" : scope === "desktop";
}

/** Shortcuts that apply under the current transport, in registry order. */
export function appShortcutsForMode(remote: boolean): ShortcutSpec[] {
	return APP_SHORTCUTS.filter((s) => shortcutAppliesInMode(s, remote));
}

/** Shortcuts of one category, in registry order. */
export function shortcutsInCategory(category: ShortcutCategory): ShortcutSpec[] {
	return APP_SHORTCUTS.filter((s) => s.category === category);
}
