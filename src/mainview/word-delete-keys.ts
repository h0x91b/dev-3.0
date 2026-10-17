import { isMac } from "./utils/platform";

/** ^W — backward word delete in zsh, bash, vim insert mode and Claude Code. */
export const DELETE_WORD_LEFT = "\x17";
/** ESC d (Meta+D) — forward word delete in zsh, bash and Claude Code. */
export const DELETE_WORD_RIGHT = "\x1bd";

/**
 * Ctrl+Backspace / Ctrl+Delete delete a word on Windows and Linux, but a terminal
 * encodes them as ^H and CSI 3;5~, which shells read as a plain backspace or ignore.
 * Same translation as VS Code's terminal; macOS keeps the raw keys (Option+Backspace).
 */
export function getWordDeleteSequence(event: KeyboardEvent, mac?: boolean): string | null {
	if (event.type !== "keydown" || !event.ctrlKey) return null;
	if (event.shiftKey || event.altKey || event.metaKey) return null;
	const seq = event.key === "Backspace" ? DELETE_WORD_LEFT : event.key === "Delete" ? DELETE_WORD_RIGHT : null;
	return seq && !(mac ?? isMac()) ? seq : null;
}
