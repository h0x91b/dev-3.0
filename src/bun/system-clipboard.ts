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
 *
 * Spawn returns synchronously, so callers don't need to await — but we attach
 * a deferred handler that logs the eventual exit code + stderr. This makes it
 * possible to diagnose silent failures (broken pbcopy, missing permissions,
 * "no display" on Linux, etc.) from logs alone.
 */
export function writeSystemClipboard(text: string): string | null {
	const tool = getClipboardTool();
	if (!tool) return null;
	try {
		const proc = spawn(tool.cmd, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
		const sink = proc.stdin as unknown as import("bun").FileSink;
		sink.write(text);
		sink.end();
		// Deferred diagnostics — observe whether the tool actually accepted the
		// payload. Non-zero exit or stderr output is the smoking gun for the
		// "pbcopy is broken on user's machine" class of bug reports.
		(async () => {
			try {
				const [exitCode, stderr] = await Promise.all([
					proc.exited,
					proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
				]);
				if (exitCode === 0 && !stderr) {
					log.debug("clipboard wrote", { tool: tool.label, len: text.length });
				} else {
					log.warn("clipboard tool exited non-cleanly", {
						tool: tool.label,
						exitCode,
						stderr: stderr.slice(0, 500),
						len: text.length,
					});
				}
			} catch (err) {
				log.warn("clipboard tool exit observation failed", { tool: tool.label, error: String(err) });
			}
		})();
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
