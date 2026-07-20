/**
 * Best-effort clipboard write that also works in insecure browser contexts.
 *
 * Remote mode served over plain http (LAN IP, no tunnel) is not a secure
 * context, so `navigator.clipboard` does not exist there at all. The legacy
 * `document.execCommand("copy")` path still works while the user's transient
 * activation from the copy gesture is alive (~5s in Chromium), which covers
 * OSC 52 payloads arriving a few hundred ms after the mouse release.
 */
export type ClipboardWriteMethod = "clipboard-api" | "exec-command" | "failed";

export async function writeClipboardText(text: string): Promise<ClipboardWriteMethod> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return "clipboard-api";
		} catch {
			// Fall through — e.g. NotAllowedError outside a user gesture.
		}
	}
	return execCommandCopy(text) ? "exec-command" : "failed";
}

function execCommandCopy(text: string): boolean {
	if (typeof document.execCommand !== "function") return false;
	const previousFocus = document.activeElement;
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	// Fixed + off-screen so selecting it never scrolls the viewport.
	ta.style.position = "fixed";
	ta.style.top = "-1000px";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	let ok = false;
	try {
		ta.select();
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	} finally {
		ta.remove();
		if (previousFocus instanceof HTMLElement) {
			try {
				previousFocus.focus({ preventScroll: true });
			} catch {
				// Focus restore is best effort.
			}
		}
	}
	return ok;
}
