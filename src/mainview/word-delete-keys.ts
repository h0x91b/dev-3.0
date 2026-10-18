import { isMac } from "./utils/platform";

/** ^W — backward word delete in zsh, bash, vim/neovim insert mode and Claude Code. */
export const DELETE_WORD_LEFT = "\x17";

/**
 * Ctrl+Backspace deletes a word on Windows and Linux, but a terminal encodes it as ^H,
 * which shells read as a plain backspace. macOS keeps the raw key (Option+Backspace).
 * Ctrl+Delete is decided by tmux instead, which can see the alternate screen (config.ts).
 */
export function getWordDeleteSequence(event: KeyboardEvent, mac?: boolean): string | null {
	if (event.type !== "keydown" || !event.ctrlKey) return null;
	if (event.shiftKey || event.altKey || event.metaKey) return null;
	return event.key === "Backspace" && !(mac ?? isMac()) ? DELETE_WORD_LEFT : null;
}
