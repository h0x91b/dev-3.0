/**
 * Browser remote mode: ask before the tab goes away.
 *
 * A page cannot cancel ⌘W / Ctrl+W in a normal tab — a shell user on Windows
 * pressing Ctrl+W for "delete word" simply loses the dev3 tab. The one guard a
 * browser sanctions is `beforeunload`, which makes it show its own "Leave site?"
 * prompt. Never installed in the desktop shell, where it would block quit and
 * reload. The app's own reloads go through {@link reloadPage}, which bypasses it.
 * See decisions/2026/11/24/beforeunload-tab-close-guard.md.
 */

import { isRemote } from "./utils/platform";

let enabled = true;
let bypass = false;
let installed = false;

function onBeforeUnload(e: BeforeUnloadEvent): void {
	if (!enabled || bypass) return;
	e.preventDefault();
	// Chromium before 119 and older Safari still need the legacy returnValue.
	e.returnValue = "";
}

/** Install the guard once at bootstrap. A no-op outside a browser tab. */
export function initTabCloseGuard(): void {
	if (installed || !isRemote()) return;
	installed = true;
	window.addEventListener("beforeunload", onBeforeUnload);
}

/** Follow the `remoteConfirmTabClose` setting (default on). */
export function setTabCloseGuardEnabled(next: boolean): void {
	enabled = next;
}

/** Whether a tab close would prompt right now. */
export function isTabCloseGuardActive(): boolean {
	return installed && enabled && !bypass;
}

/**
 * Reload on purpose — never prompts. The bypass is not reset: the page is going
 * away, and the browser may dispatch `beforeunload` after `reload()` returns.
 */
export function reloadPage(): void {
	bypass = true;
	window.location.reload();
}

/** Reset module state. Tests only. */
export function __resetTabCloseGuardForTests(): void {
	if (installed) window.removeEventListener("beforeunload", onBeforeUnload);
	installed = false;
	enabled = true;
	bypass = false;
}
