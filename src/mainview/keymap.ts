import type { TranslationKey } from "./i18n";
import {
	bindingsEqual,
	formatBindings,
	matchesBinding,
	type Binding,
	type MatchContext,
} from "./keymap-bindings";
import { isKeymapCapturing, resolvedBindings } from "./keymap-store";
import { isMac, isRemote } from "./utils/platform";
import { isTypingContext } from "./utils/typing-context";

/**
 * Single source of truth for every APP-LEVEL keyboard shortcut.
 *
 * This registry both DOCUMENTS and DRIVES the keymap: handlers ask
 * `matchesShortcut(e, id)` (see `keymap-store.ts`) instead of hand-writing
 * modifier conditions, so a user rebind in Settings → Keyboard takes effect
 * everywhere at once. Display strings are DERIVED from the bindings — never
 * author a combo twice.
 *
 * The registry also feeds the KeyboardShortcutsModal, the README table and the
 * website, so any newly added app-level shortcut MUST get an entry here.
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

/**
 * Which keys a shortcut competes for. Two shortcuts in different groups may share
 * a combo because only one of them can be focused at a time — ⌘F is the terminal
 * search inside a terminal and the artifact search inside an artifact.
 */
export type ShortcutConflictGroup = "app" | "terminal" | "artifact";

export interface ShortcutSpec {
	/** Stable, unique id. Also the persistence key for a user override. */
	id: string;
	/**
	 * Default bindings, in display order. Empty only for `remappable: false`
	 * shortcuts whose combo is structural (a chord sequence, a digit family, a
	 * hold-modifier cycle) and therefore lives in `display` instead.
	 */
	defaults: Binding[];
	/** i18n key for the human description. */
	descKey: TranslationKey;
	category: ShortcutCategory;
	/** Transport scope. Defaults to `both` when omitted. */
	scope?: ShortcutScope;
	/** Key-competition group. Defaults to `app` when omitted. */
	conflictGroup?: ShortcutConflictGroup;
	/**
	 * False when the combo cannot be rebound. Such a row still renders — greyed,
	 * with `fixedReasonKey` explaining why — because an editor that silently omits
	 * a third of the keymap reads as broken.
	 */
	remappable?: boolean;
	/** Why this shortcut is fixed. Required whenever `remappable` is false. */
	fixedReasonKey?: TranslationKey;
	/** Literal combo text for fixed shortcuts that no `Binding` can express. */
	display?: { mac: string; other: string };
	/** Literal combo text shown in remote mode when the desktop one is unusable. */
	remoteDisplay?: { mac: string; other: string };
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

/** Shorthand for the common `Mod`-prefixed binding. */
const mod = (code: string, ...extra: Binding["mods"]): Binding => ({ code, mods: ["Mod", ...extra] });

export const APP_SHORTCUTS: ShortcutSpec[] = [
	// ── Navigation ──
	{ id: "go-to-project", defaults: [mod("KeyK")], descKey: "keymap.shortcut.goToProject", category: "navigation" },
	{ id: "command-palette", defaults: [mod("KeyP", "Shift")], descKey: "keymap.shortcut.commandPalette", category: "navigation" },
	{ id: "back", defaults: [mod("BracketLeft"), { code: "Minus", mods: ["Ctrl"] }], descKey: "keymap.shortcut.back", category: "navigation" },
	{ id: "forward", defaults: [mod("BracketRight"), { code: "Minus", mods: ["Ctrl", "Shift"] }], descKey: "keymap.shortcut.forward", category: "navigation" },
	{ id: "previous-variant", defaults: [mod("BracketLeft", "Shift")], descKey: "keymap.shortcut.previousVariant", category: "navigation" },
	{ id: "next-variant", defaults: [mod("BracketRight", "Shift")], descKey: "keymap.shortcut.nextVariant", category: "navigation" },
	{
		id: "switch-project", defaults: [], descKey: "keymap.shortcut.switchProject", category: "navigation",
		remappable: false, fixedReasonKey: "keymap.fixed.digitFamily",
		display: { mac: "⌘1–9", other: "Ctrl+1–9" }, remoteDisplay: { mac: "G then 1–9", other: "G then 1–9" },
	},
	{
		id: "switch-project-flip", defaults: [], descKey: "keymap.shortcut.switchProjectFlip", category: "navigation",
		remappable: false, fixedReasonKey: "keymap.fixed.digitFamily",
		display: { mac: "⇧⌘1–9", other: "Ctrl+Shift+1–9" },
	},
	{ id: "jump-operations", defaults: [mod("Digit0")], descKey: "keymap.shortcut.jumpOperations", category: "navigation" },
	{
		id: "task-switcher", defaults: [], descKey: "keymap.shortcut.taskSwitcher", category: "navigation",
		remappable: false, fixedReasonKey: "keymap.fixed.holdModifier",
		display: { mac: "⌥Tab", other: "Ctrl+Tab" },
	},
	{
		id: "task-switcher-global", defaults: [], descKey: "keymap.shortcut.taskSwitcherGlobal", category: "navigation",
		remappable: false, fixedReasonKey: "keymap.fixed.holdModifier",
		display: { mac: "⌥⇧Tab", other: "Ctrl+Shift+Tab" },
	},
	{ id: "task-hints", defaults: [{ code: "KeyF", mods: [] }, mod("KeyG")], descKey: "keymap.shortcut.taskHints", category: "navigation" },
	{
		id: "go-to", defaults: [], descKey: "keymap.shortcut.goTo", category: "navigation",
		remappable: false, fixedReasonKey: "keymap.fixed.chordSequence",
		display: { mac: "G then D/P/T/S/1–9", other: "G then D/P/T/S/1–9" },
	},
	{ id: "focus-search", defaults: [{ code: "Slash", mods: [] }], descKey: "keymap.shortcut.focusSearch", category: "navigation" },
	{
		id: "escape", defaults: [], descKey: "keymap.shortcut.escape", category: "navigation",
		remappable: false, fixedReasonKey: "keymap.fixed.reserved",
		display: { mac: "Esc", other: "Esc" },
	},

	// ── Create ──
	{ id: "new-task", defaults: [{ ...mod("KeyN"), desktopOnly: true }, { code: "KeyC", mods: [] }], descKey: "keymap.shortcut.newTask", category: "create" },
	{ id: "add-project", defaults: [mod("KeyP")], descKey: "keymap.shortcut.addProject", category: "create" },
	{ id: "new-window", defaults: [mod("KeyN", "Shift")], descKey: "keymap.shortcut.newWindow", category: "create", scope: "desktop" },

	// ── View & Zoom ──
	{ id: "settings", defaults: [mod("Comma")], descKey: "keymap.shortcut.settings", category: "view" },
	{ id: "zoom-in", defaults: [mod("Equal")], descKey: "keymap.shortcut.zoomIn", category: "view", scope: "desktop" },
	{
		id: "zoom-out",
		defaults: [{ code: "Minus", mods: ["Mod"], platform: "mac" }, { code: "Minus", mods: ["Ctrl", "Alt"], platform: "other" }],
		descKey: "keymap.shortcut.zoomOut", category: "view", scope: "desktop",
	},
	{ id: "zoom-reset", defaults: [mod("Digit0", "Shift")], descKey: "keymap.shortcut.zoomReset", category: "view", scope: "desktop" },
	{
		id: "hard-refresh", defaults: [], descKey: "keymap.shortcut.hardRefresh", category: "view", scope: "desktop",
		remappable: false, fixedReasonKey: "keymap.fixed.shellOwned",
		display: { mac: "⌘R", other: "Ctrl+R" },
	},
	{ id: "open-in", defaults: [mod("KeyO")], descKey: "keymap.shortcut.openIn", category: "view", scope: "desktop" },
	{ id: "keyboard-shortcuts", defaults: [mod("Slash")], descKey: "keymap.shortcut.keyboardShortcuts", category: "view" },
	{ id: "help-mode", defaults: [mod("Slash", "Shift")], descKey: "keymap.shortcut.helpMode", category: "view" },
	{ id: "terminal-fullscreen", defaults: [{ code: "F11", mods: [] }, mod("KeyF", "Shift")], descKey: "keymap.shortcut.terminalFullscreen", category: "view" },
	{ id: "artifact-search", defaults: [mod("KeyF")], descKey: "keymap.shortcut.artifactSearch", category: "view", conflictGroup: "artifact" },

	// ── Terminal ──
	{ id: "toggle-project-terminal", defaults: [mod("Backquote")], descKey: "keymap.shortcut.toggleProjectTerminal", category: "terminal" },
	{ id: "open-quick-shell", defaults: [mod("Backquote", "Shift")], descKey: "keymap.shortcut.openQuickShell", category: "terminal" },
	{ id: "terminal-search", defaults: [mod("KeyF")], descKey: "keymap.shortcut.terminalSearch", category: "terminal", conflictGroup: "terminal" },

	// ── Application ──
	{ id: "quit", defaults: [mod("KeyQ")], descKey: "keymap.shortcut.quit", category: "app", scope: "desktop" },
	{ id: "hide", defaults: [mod("KeyH")], descKey: "keymap.shortcut.hide", category: "app", scope: "desktop" },
];

const BY_ID = new Map(APP_SHORTCUTS.map((s) => [s.id, s]));

export function shortcutById(id: string): ShortcutSpec | undefined {
	return BY_ID.get(id);
}

/** Whether the user may rebind this shortcut. */
export function isRemappable(spec: ShortcutSpec): boolean {
	return spec.remappable !== false;
}

export function conflictGroupOf(spec: ShortcutSpec): ShortcutConflictGroup {
	return spec.conflictGroup ?? "app";
}

/** The bindings a spec fires on right now (user override, else defaults). */
export function bindingsFor(spec: ShortcutSpec): Binding[] {
	return isRemappable(spec) ? resolvedBindings(spec.id, spec.defaults) : spec.defaults;
}

/** The key combo to display for a shortcut on the current platform. */
export function shortcutKeysFor(spec: ShortcutSpec, mac: boolean = isMac()): string {
	return shortcutKeysForMode(spec, mac, false);
}

/**
 * The key combo to display for a shortcut, transport-aware: in remote (browser)
 * mode a `remoteDisplay` override wins (e.g. ⌘1–9 → `G then 1–9`), and bindings
 * the browser owns are dropped from the rendered list.
 */
export function shortcutKeysForMode(spec: ShortcutSpec, mac: boolean, remote: boolean): string {
	if (remote && spec.remoteDisplay) return mac ? spec.remoteDisplay.mac : spec.remoteDisplay.other;
	const bindings = bindingsFor(spec).filter(
		(b) => (!b.platform || (b.platform === "mac") === mac) && !(remote && b.desktopOnly),
	);
	if (bindings.length > 0) return formatBindings(bindings, mac);
	return spec.display ? (mac ? spec.display.mac : spec.display.other) : "";
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

/**
 * Whether a keydown fires the given shortcut. This is the dispatch entry point —
 * handlers call it instead of hand-writing modifier conditions, which is what
 * makes a rebind take effect everywhere at once.
 *
 * `typing` defaults to a live DOM check so a bare-key binding (`C`, `/`) never
 * steals a keystroke from a focused field or terminal.
 */
export function matchesShortcut(e: KeyboardEvent, id: string, ctx?: Partial<MatchContext>): boolean {
	if (isKeymapCapturing()) return false;
	const spec = BY_ID.get(id);
	if (!spec) return false;
	const remote = ctx?.remote ?? isRemote();
	if (!shortcutAppliesInMode(spec, remote)) return false;
	const full: MatchContext = {
		mac: ctx?.mac ?? isMac(),
		remote,
		typing: ctx?.typing ?? isTypingContext(),
	};
	return bindingsFor(spec).some((b) => matchesBinding(e, b, full));
}

export interface ShortcutConflict {
	/** The shortcut currently holding the combo. */
	ownerId: string;
	binding: Binding;
}

/**
 * The shortcut that already owns `binding`, if any. Scoped to the conflict group
 * so the terminal's ⌘F and the artifact viewer's ⌘F can coexist — only one of
 * them can have focus.
 */
export function findConflict(id: string, binding: Binding): ShortcutConflict | null {
	const self = BY_ID.get(id);
	if (!self) return null;
	const group = conflictGroupOf(self);
	for (const spec of APP_SHORTCUTS) {
		if (spec.id === id || conflictGroupOf(spec) !== group) continue;
		const clash = bindingsFor(spec).find((b) => bindingsEqual(b, binding));
		if (clash) return { ownerId: spec.id, binding: clash };
	}
	return null;
}
