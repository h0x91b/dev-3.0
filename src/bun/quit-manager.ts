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

/** Test-only: reset between cases. */
export function __resetQuitConfirmedForTests(): void {
	quitConfirmed = false;
}
