import type { TerminalKeymapPreset } from "../shared/types";

export type TmuxAction = "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow";

export interface KeyBinding {
	/** Matches KeyboardEvent.key exactly (case-sensitive). */
	key: string;
	meta?: boolean;
	ctrl?: boolean;
	action: TmuxAction;
}

export const TERMINAL_KEYMAPS: Record<TerminalKeymapPreset, KeyBinding[]> = {
	// Convenient default: only Cmd+W to kill pane; splits/zoom via UI buttons.
	"dev3": [
		{ key: "w", meta: true, action: "killPane" },
	],

	// Mirrors iTerm2's standard pane & tab shortcuts.
	// Note: Cmd+Shift+D produces e.key="D" (uppercase).
	"iterm2": [
		{ key: "w", meta: true, action: "killPane" },
		{ key: "d", meta: true, action: "splitV" },
		{ key: "D", meta: true, action: "splitH" },
		{ key: "t", meta: true, action: "newWindow" },
		{ key: "]", meta: true, action: "nextPane" },
		{ key: "[", meta: true, action: "prevPane" },
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
