import { getShiftKeySequence } from "./shift-key-sequences";
import { getWordDeleteSequence } from "./word-delete-keys";

/**
 * The sequence to send instead of ghostty-web's own encoding, or null to let it encode.
 * Word delete is tmux-only: a native Windows PTY (ConPTY) already reads ^H as Ctrl+Backspace.
 */
export function getTerminalKeyOverride(event: KeyboardEvent, tmuxStream: boolean, mac?: boolean): string | null {
	return getShiftKeySequence(event) ?? (tmuxStream ? getWordDeleteSequence(event, mac) : null);
}
