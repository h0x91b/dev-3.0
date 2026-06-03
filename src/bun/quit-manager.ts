// Shared quit-confirmation state between the `before-quit` gate (index.ts) and
// the `quitApp` RPC handler (app-handlers.ts).
//
// The gate cancels the first quit attempt and asks the renderer to show the
// React confirmation dialog. When the user confirms, `quitApp` marks the quit
// as confirmed and calls `Utils.quit()` again — this second pass sails through
// the gate because the flag is now set.

let quitConfirmed = false;

export function markQuitConfirmed(): void {
	quitConfirmed = true;
}

export function isQuitConfirmed(): boolean {
	return quitConfirmed;
}

// Set when a quit was requested while NO window was open (app lives in the dock
// after the last window closed — see `exitOnLastWindowClosed: false`). The gate
// cancels that quit and reopens a window; the reopened renderer PULLS this flag
// on mount (a push would race the not-yet-mounted listener and get lost) and
// shows the confirmation dialog.
let quitDialogPending = false;

export function markQuitDialogPending(): void {
	quitDialogPending = true;
}

/** Read and clear the pending flag — the reopened renderer calls this on mount. */
export function consumeQuitDialogPending(): boolean {
	const was = quitDialogPending;
	quitDialogPending = false;
	return was;
}

/** Test-only: reset between cases. */
export function __resetQuitConfirmedForTests(): void {
	quitConfirmed = false;
	quitDialogPending = false;
}
