import type { Terminal } from "ghostty-web";

type PasteTarget = Pick<Terminal, "paste" | "input" | "hasBracketedPaste">;

// tmux enables DEC 2004 in its client once per attach and strips the markers for panes
// that did not ask; a remounted or reset ghostty forgets the mode, so tmux streams are
// bracketed here. decisions/2026/10/07/tmux-paste-keeps-brackets-after-remount.md
export function terminalBracketsPaste(term: PasteTarget, tmuxStream: boolean): boolean {
	return tmuxStream || term.hasBracketedPaste();
}

export function pasteIntoTerminal(term: PasteTarget, text: string, tmuxStream: boolean): void {
	if (tmuxStream && !term.hasBracketedPaste()) term.input(`\x1b[200~${text}\x1b[201~`, true);
	else term.paste(text);
}
