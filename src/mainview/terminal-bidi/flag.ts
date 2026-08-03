// ── Terminal BiDi feature flag ──
// Whether terminal panes reorder right-to-left text for display. Beta, off by
// default, lives in Settings → System → Advanced Experience.
//
// The value is a GlobalSettings field (not localStorage like zoom/scroll speed)
// so it follows the user into `dev3 remote` browser sessions. App.tsx feeds it
// here from the same place it stores globalSettings; panes listen for the event.

export const TERMINAL_BIDI_CHANGED_EVENT = "terminal-bidi-changed" as const;

let enabled = false;

export function getTerminalBidiEnabled(): boolean {
	return enabled;
}

/** Called wherever globalSettings lands in the renderer (initial load + push). */
export function syncTerminalBidiFromGlobalSettings(settings: {
	experimentalTerminalBidi?: boolean;
}): void {
	const next = settings.experimentalTerminalBidi === true;
	if (next === enabled) return;
	enabled = next;
	window.dispatchEvent(
		new CustomEvent(TERMINAL_BIDI_CHANGED_EVENT, { detail: next }),
	);
}

/** Test-only reset — production code changes the flag through settings. */
export function resetTerminalBidiForTests(): void {
	enabled = false;
}
