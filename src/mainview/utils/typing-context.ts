/**
 * True when keystrokes should go to a focused field or the terminal rather than
 * trigger a bare-key shortcut (`C`, `F`, `/`). Lives here rather than in
 * `App.tsx` because the keymap matcher needs the same answer.
 */
export function isTypingContext(): boolean {
	if (typeof document === "undefined") return false;
	const el = document.activeElement as HTMLElement | null;
	if (!el) return false;
	const tag = el.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (el.isContentEditable) return true;
	if (isTerminalFocus(el)) return true;
	return false;
}

/**
 * True when focus is inside a live terminal. Narrower than `isTypingContext`,
 * which also covers plain fields — and the difference matters: a `Ctrl` combo is
 * a control character to the shell (`^D` is end-of-file, `^W` kills a word) but
 * means nothing in a text input, so only the terminal may veto one.
 */
export function isTerminalFocus(active?: HTMLElement | null): boolean {
	if (typeof document === "undefined") return false;
	const el = active ?? (document.activeElement as HTMLElement | null);
	return !!el?.closest('[data-terminal="true"]');
}
