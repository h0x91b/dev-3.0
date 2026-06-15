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
