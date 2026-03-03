/**
 * ghostty-web's InputHandler has a shortcut path that treats Shift+Key
 * identically to unmodified Key for functional keys (Enter, Tab, Home,
 * End, Insert, Delete, PageUp/Down, F1-F12).  The Shift modifier is
 * silently swallowed and the WASM KeyEncoder never runs.
 *
 * This map provides the correct xterm-style escape sequences for every
 * Shift-only functional key.  The `;2` parameter means "Shift modifier"
 * per xterm's CSI convention.
 *
 * Keys are KeyboardEvent.code values (physical key identifiers).
 */
export const SHIFT_KEY_SEQUENCES: Record<string, string> = {
	Tab:      "\x1b[Z",       // Back-tab (CBT)
	Enter:    "\x1b[27;2;13~", // modifyOtherKeys: Shift+Enter
	Home:     "\x1b[1;2H",
	End:      "\x1b[1;2F",
	Insert:   "\x1b[2;2~",
	Delete:   "\x1b[3;2~",
	PageUp:   "\x1b[5;2~",
	PageDown: "\x1b[6;2~",
	F1:       "\x1b[1;2P",
	F2:       "\x1b[1;2Q",
	F3:       "\x1b[1;2R",
	F4:       "\x1b[1;2S",
	F5:       "\x1b[15;2~",
	F6:       "\x1b[17;2~",
	F7:       "\x1b[18;2~",
	F8:       "\x1b[19;2~",
	F9:       "\x1b[20;2~",
	F10:      "\x1b[21;2~",
	F11:      "\x1b[23;2~",
	F12:      "\x1b[24;2~",
};

/**
 * Check if a keyboard event is a Shift-only functional key and return
 * the correct escape sequence, or null if not applicable.
 */
export function getShiftKeySequence(event: KeyboardEvent): string | null {
	if (event.type !== "keydown" || !event.shiftKey) return null;
	if (event.ctrlKey || event.altKey || event.metaKey) return null;
	return SHIFT_KEY_SEQUENCES[event.code] ?? null;
}
