/**
 * Codex treats a fast unbracketed paste as a paste burst and suppresses Enter
 * for a short window so pasted newlines stay inside the draft. Wait past that
 * window before submitting when the terminal did not advertise DEC 2004.
 */
export const UNBRACKETED_PASTE_SETTLE_DELAY_MS = 150;

interface TerminalSubmitTransport {
	paste: (data: string) => void;
	sendInput: (data: string) => void;
	hasBracketedPaste: () => boolean;
}

type ScheduleSubmit = (callback: () => void, delayMs: number) => unknown;

/**
 * Paste text and submit it exactly once.
 *
 * Explicit bracketed paste clears Codex's paste-burst state immediately, so a
 * plain Enter can follow in the same turn. For a raw paste, leave enough time
 * for the terminal app to classify and flush the burst before pressing Enter.
 */
export function submitPastedText(
	text: string,
	transport: TerminalSubmitTransport,
	schedule: ScheduleSubmit = (callback, delayMs) => setTimeout(callback, delayMs),
): void {
	let hasBracketedPaste = false;
	try {
		hasBracketedPaste = transport.hasBracketedPaste();
	} catch {
		// An unavailable mode query is equivalent to an unbracketed paste.
	}

	try {
		transport.paste(text);
	} catch {
		return;
	}

	const submit = () => transport.sendInput("\r");
	if (hasBracketedPaste) {
		submit();
	} else {
		schedule(submit, UNBRACKETED_PASTE_SETTLE_DELAY_MS);
	}
}
