/**
 * Reading the user's own keystrokes out of the raw bytes a terminal client sends,
 * to answer two questions: did he just submit his own line, and did he type at all?
 *
 * Only that. It never tries to reconstruct what he typed — it decides whether a
 * message held for that pane may land now (his box is free) or must keep waiting.
 *
 * Deliberately conservative, because the two mistakes cost very differently: a
 * missed submit only makes a held message wait for the quiet window, while a
 * phantom submit pastes a peer's text into a half-written prompt — the exact bug
 * the hold exists to prevent. So:
 *  - CR (`\r`) is the submit. It is what this app's terminal sends for plain Enter.
 *  - ESC+CR (`\x1b\r`) is NOT: that is how dev3 encodes Shift+Enter, i.e. "insert a
 *    newline, don't submit" (`decisions/2026/03/04/shift-key-workaround-ghostty-web.md`).
 *    Any ESC-introduced sequence is skipped for the same reason.
 *  - LF (`\n`) is NOT. It is a newline-insert byte, not a keypress our terminal sends
 *    for Enter.
 *  - CRs between `ESC [200~` and `ESC [201~` are pasted CONTENT, not keypresses. A
 *    paste can be split across chunks, so the state travels with the caller.
 *  - Mouse reports (a click sent to tmux) and focus reports are not typing: a chunk
 *    made only of them leaves `typed` false, so it does not push a held message back.
 */

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** SGR mouse (`ESC [<b;x;yM`), X10 mouse (`ESC [M` + 3 bytes), focus in/out (`ESC [I`, `ESC [O`). */
const POINTER_REPORT = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[IO]/y;

export interface HumanTerminalInputScan {
	/** True when this chunk contained a plain Enter outside a paste. */
	readonly submitted: boolean;
	/** True when this chunk held anything besides mouse and focus reports. */
	readonly typed: boolean;
	/** Whether a bracketed paste is still open — feed it back on the next chunk. */
	readonly inPaste: boolean;
}

/** Scan one chunk of client keystrokes. `inPaste` carries over from the previous chunk. */
export function scanHumanTerminalInput(data: string, inPaste = false): HumanTerminalInputScan {
	let paste = inPaste;
	let submitted = false;
	let typed = false;
	for (let i = 0; i < data.length; i += 1) {
		if (!paste && data[i] === "\x1b") {
			POINTER_REPORT.lastIndex = i;
			const report = POINTER_REPORT.exec(data);
			if (report) {
				i += report[0].length - 1;
				continue;
			}
		}
		typed = true;
		if (data.startsWith(PASTE_START, i)) {
			paste = true;
			i += PASTE_START.length - 1;
			continue;
		}
		if (data.startsWith(PASTE_END, i)) {
			paste = false;
			i += PASTE_END.length - 1;
			continue;
		}
		// ESC introduces a sequence, and the byte behind it is part of it — never a
		// bare Enter. Shift+Enter arrives here as exactly those two bytes.
		if (data[i] === "\x1b") {
			i += 1;
			continue;
		}
		if (!paste && data[i] === "\r") submitted = true;
	}
	return { submitted, typed, inPaste: paste };
}
