/**
 * Coarse platform detection for the renderer. Used to pick keyboard bindings
 * that differ by OS — e.g. the task switcher uses Option(Alt)+Tab on macOS but
 * Ctrl+Tab on Linux, where the window manager grabs Alt+Tab before the webview.
 */
export function isMac(): boolean {
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent || "";
	const platform = navigator.platform || "";
	return /Mac|iPhone|iPad|iPod/.test(platform) || ua.includes("Macintosh");
}

/**
 * Whether the renderer is running in browser remote mode (`dev3 remote`) rather
 * than the Electrobun desktop shell. Electrobun injects `__electrobunWebviewId`
 * onto `window` inside the WKWebView; its absence means a plain browser tab over
 * the WebSocket transport. Mirrors `isElectrobun` in `rpc.ts`, exposed as a
 * function so keymap/dispatch/palette can branch per transport (and tests can
 * toggle it). In remote mode the native menu bar is gone and the browser claims
 * several modifier combos (⌘1–9, ⌘N, zoom, …), so some app shortcuts are
 * dropped or aliased — see `keymap.ts`.
 */
export function isRemote(): boolean {
	if (typeof window === "undefined") return false;
	return typeof (window as Window & { __electrobunWebviewId?: number }).__electrobunWebviewId === "undefined";
}
