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
	if (el.closest('[data-terminal="true"]')) return true;
	return false;
}
