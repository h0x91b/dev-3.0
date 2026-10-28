/** Longest name a user can give a terminal window; the tab truncates long before it. */
export const WINDOW_NAME_MAX = 64;

// C0/C1 controls and DEL: a tab would split the tmux format row, a newline the status line.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The one cleanup for a user-given window name; "" means "name it automatically". */
export function normalizeWindowName(raw: string): string {
	const flat = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	return [...flat].slice(0, WINDOW_NAME_MAX).join("").trim();
}
