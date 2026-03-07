import type { TerminalKeymapPreset } from "../shared/types";

export type TmuxAction = "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow";

export interface KeyBinding {
	/**
	 * Matches KeyboardEvent.code (e.g. "KeyW", "KeyD", "BracketLeft").
	 * Using code instead of key ensures stability across modifier combinations
	 * and WKWebView's key normalization quirks.
	 */
	code: string;
	meta?: boolean;
	ctrl?: boolean;
	shift?: boolean;
	action: TmuxAction;
}

export const TERMINAL_KEYMAPS: Record<TerminalKeymapPreset, KeyBinding[]> = {
	// No app-level shortcuts — matches the state before this feature was added.
	"dev3": [],

	// Mirrors iTerm2's standard pane & tab shortcuts.
	"iterm2": [
		{ code: "KeyW", meta: true, action: "killPane" },
		{ code: "KeyD", meta: true, shift: false, action: "splitV" },
		{ code: "KeyD", meta: true, shift: true, action: "splitH" },
		{ code: "KeyT", meta: true, action: "newWindow" },
		{ code: "BracketRight", meta: true, action: "nextPane" },
		{ code: "BracketLeft", meta: true, action: "prevPane" },
	],

	// No app-level shortcuts — everything via Ctrl+B prefix inside tmux.
	"tmux-native": [],
};

export const KEYMAP_LS_KEY = "dev3-terminal-keymap";
export const KEYMAP_CHANGED_EVENT = "dev3-terminal-keymap-changed";

export function getKeymapPreset(): TerminalKeymapPreset {
	return (localStorage.getItem(KEYMAP_LS_KEY) as TerminalKeymapPreset) ?? "dev3";
}

export function setKeymapPreset(preset: TerminalKeymapPreset): void {
	localStorage.setItem(KEYMAP_LS_KEY, preset);
	window.dispatchEvent(new CustomEvent(KEYMAP_CHANGED_EVENT, { detail: preset }));
}
