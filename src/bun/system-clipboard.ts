/**
 * Write text to the host system clipboard from the desktop main process.
 *
 * Used to handle OSC 52 copy payloads that arrive from inner apps (vim, tmux,
 * etc.) via the PTY data stream. The renderer cannot do this reliably:
 * `navigator.clipboard.writeText()` in Electrobun's WKWebView requires a user
 * gesture / transient activation, and an async WebSocket message handler is
 * not a gesture — calls fail silently with NotAllowedError. So the desktop
 * process pipes directly to `pbcopy` / `wl-copy` / `xclip`.
 *
 * Headless mode (`headless-entry.ts`) does NOT call into here: there's no
 * interactive user on the host machine; the OSC 52 payload is forwarded to
 * the remote browser instead.
 */

import { spawn } from "./spawn";
import { whichSync } from "./which";
import { createLogger } from "./logger";

const log = createLogger("system-clipboard");

interface ClipboardTool {
	cmd: string[];
	label: string;
}

let resolved: ClipboardTool | null | undefined;

function resolveClipboardTool(): ClipboardTool | null {
	if (process.platform === "darwin") {
		const pbcopy = whichSync("pbcopy") ?? "pbcopy"; // pbcopy is in /usr/bin always
		return { cmd: [pbcopy], label: "pbcopy" };
	}
	if (process.platform === "linux") {
		// Prefer wl-copy under Wayland sessions, fall back to xclip on X11.
		if (process.env.WAYLAND_DISPLAY) {
			const wl = whichSync("wl-copy");
			if (wl) return { cmd: [wl], label: "wl-copy" };
		}
		const xclip = whichSync("xclip");
		if (xclip) return { cmd: [xclip, "-selection", "clipboard"], label: "xclip" };
		const wlFallback = whichSync("wl-copy");
		if (wlFallback) return { cmd: [wlFallback], label: "wl-copy" };
		return null;
	}
	// win32 / others — not supported here yet.
	return null;
}

function getClipboardTool(): ClipboardTool | null {
	if (resolved === undefined) {
		resolved = resolveClipboardTool();
		if (resolved) {
			log.info("clipboard tool resolved", { tool: resolved.label, cmd: resolved.cmd.join(" ") });
		} else {
			log.warn("no system clipboard tool found", { platform: process.platform });
		}
	}
	return resolved;
}

/**
 * Pipe `text` into the host clipboard. Returns the tool used, or `null` if
 * unsupported / failed.
 */
export function writeSystemClipboard(text: string): string | null {
	const tool = getClipboardTool();
	if (!tool) return null;
	try {
		const proc = spawn(tool.cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
		const sink = proc.stdin as unknown as import("bun").FileSink;
		sink.write(text);
		sink.end();
		return tool.label;
	} catch (err) {
		log.warn("clipboard write failed", { tool: tool.label, error: String(err) });
		return null;
	}
}

/** Test hook — reset cached tool so a unit test can re-resolve under a stub. */
export function _resetClipboardToolForTests(): void {
	resolved = undefined;
}
