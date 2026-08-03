#!/usr/bin/env bun
/**
 * The SECOND dev3 app process for the cross-instance Take-control tracer.
 *
 * Several dev3 app processes share one `~/.dev3.0`, so a native pane's host may
 * already have granted its single writer lease to a DIFFERENT process. This script
 * is that other process: it reattaches to a live host it did not launch, opens a
 * renderer socket on its OWN pty-server, and clicks `Take control` by sending the
 * exact `claim` frame `TerminalView.tsx` sends — nothing here touches
 * `WriterOwnership`, the host protocol, or tmux directly.
 *
 * It must be a real separate OS process: the whole bug lives in the host's
 * cross-process lease, which is invisible to two viewers inside one process.
 *
 * Verdict goes to stdout behind a sentinel; human logs go to stderr. The host and
 * shell are left running — the parent owns their lifetime.
 */

import {
	claimMessage,
	decodeNativeStreamMessage,
	releaseMessage,
	type NativeStreamAttachHeader,
	type NativeStreamHeader,
	type NativeStreamRole,
} from "../../shared/native-terminal-stream";
import { encodeResizeSequence } from "../../shared/resize-protocol";

const JSON_SENTINEL = "__NATIVE_TAKEOVER_JSON__";
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function emit(verdict: Record<string, unknown>): void {
	process.stdout.write(`${JSON_SENTINEL}${JSON.stringify(verdict)}\n`);
}

async function main(): Promise<void> {
	const taskId = process.argv[2];
	const cwd = process.argv[3];
	// The probe is authored by the PARENT so there is exactly one definition of it:
	// `expected` is assembled by the shell at runtime from its own env and pid, so it
	// can never appear in the echoed command line — which is what makes the parent's
	// exactly-once count meaningful.
	const setup = JSON.parse(process.env.DEV3_TAKEOVER_SETUP ?? "[]") as string[];
	const command = process.env.DEV3_TAKEOVER_COMMAND ?? "";
	const expected = process.env.DEV3_TAKEOVER_EXPECTED ?? "";
	const cols = Number(process.env.DEV3_TAKEOVER_COLS ?? "0");
	const rows = Number(process.env.DEV3_TAKEOVER_ROWS ?? "0");
	const lineEnd = process.platform === "win32" ? "\r" : "\n";
	if (!taskId || !cwd || !command || !expected || !cols || !rows) {
		process.stderr.write("usage: DEV3_TAKEOVER_COMMAND/EXPECTED/COLS/ROWS=… native-takeover-peer.ts <taskId> <cwd>\n");
		process.exit(2);
	}

	// Production reattach path: this process holds no session, so it rebinds the
	// existing host as a CLIENT. It never spawns a host or a shell.
	const pty = await import("../pty-server");
	const reattached = await pty.reattachNativeTaskSession(taskId, "takeover-peer", cwd);
	if (!reattached) {
		emit({ ok: false, reason: "reattach-failed", peerPid: process.pid });
		process.exit(0);
	}
	const terminal = pty.nativePaneTerminal(taskId);
	const hostRoleBefore = terminal?.hostRole() ?? "none";

	const port = pty.getPtyPort();
	const ws = new WebSocket(`ws://localhost:${port}?session=${encodeURIComponent(taskId)}`);
	const headers: NativeStreamHeader[] = [];
	let attach: NativeStreamAttachHeader | null = null as NativeStreamAttachHeader | null;
	let role: NativeStreamRole = "observer";
	let text = "";
	const decoder = new TextDecoder();
	ws.addEventListener("message", (ev) => {
		const data = (ev as MessageEvent).data;
		const raw = typeof data === "string" ? data : decoder.decode(data as ArrayBuffer);
		const frame = decodeNativeStreamMessage(raw);
		if (!frame) {
			text += raw;
			return;
		}
		headers.push(frame.header);
		if (frame.header.t === "attach") {
			attach = frame.header;
			role = frame.header.role;
		} else if (frame.header.t === "role") {
			role = frame.header.role;
		}
		text += frame.payload;
	});
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("peer renderer open timeout")), 8000);
		ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
		ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("peer renderer error")); }, { once: true });
	});
	const waitFor = async (predicate: (h: NativeStreamHeader) => boolean, timeoutMs = 8000): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (headers.some(predicate)) return true;
			await delay(20);
		}
		return false;
	};
	await waitFor((h) => h.t === "attach", 8000);
	const attachedRole = role;

	// ── the gesture under test: exactly what the Take control button sends ──
	ws.send(claimMessage());
	const promoted = await waitFor((h) => h.t === "role" && h.role === "writer", 10_000);
	const refusedFrame = headers.find((h) => h.t === "role" && h.refused === true) as
		| (NativeStreamHeader & { refusedReason?: string })
		| undefined;

	// This process must now be able to DRIVE the shell: geometry first (the writer
	// alone sizes the PTY), then a probe only a live shell can answer.
	ws.send(encodeResizeSequence(cols, rows));
	// Warm the shell with the setup lines and WAIT for it to be responsive before the
	// counted command: the parent asserts the probe landed EXACTLY once, so this side
	// must send it exactly once — a retry loop would make that count meaningless.
	for (const line of setup) ws.send(`${line}${lineEnd}`);
	// Must NOT contain `expected`: the parent counts occurrences of that string, and a
	// warm-up marker embedding it would inflate the count and make exactly-once a lie.
	const readyMarker = `PEER-READY-${expected.replace(/[^A-Za-z0-9]/g, "")}-WARM`;
	const readyCommand = process.platform === "win32"
		? `Write-Output "${readyMarker}"`
		: `printf '%s\n' "${readyMarker}"`;
	let ready = false;
	const readyDeadline = Date.now() + 20_000;
	while (Date.now() < readyDeadline && !ready) {
		ws.send(`${readyCommand}${lineEnd}`);
		for (let i = 0; i < 25 && !ready; i++) {
			await delay(80);
			ready = text.includes(readyMarker);
		}
	}

	// ONE send of the counted command, then quiesce so any duplicate would have shown.
	let echoed = false;
	if (ready) {
		ws.send(`${command}${lineEnd}`);
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline && !echoed) {
			await delay(80);
			echoed = text.includes(expected);
		}
		await delay(750); // quiescence barrier before the parent counts occurrences
	}

	emit({
		ok: promoted && ready && echoed,
		peerPid: process.pid,
		shellResponsive: ready,
		countedCommandSends: ready ? 1 : 0,
		hostRoleBefore,
		attachedRole,
		roleAfterTakeControl: role,
		promoted,
		echoedThroughShell: echoed,
		hostPid: attach?.hostPid ?? -1,
		shellPid: attach?.shellPid ?? -1,
		refused: refusedFrame !== undefined,
		refusedReason: refusedFrame?.refusedReason ?? null,
	});
	// Stay attached briefly so the parent can observe the demotion and the resize
	// against a LIVE peer — a peer that exited would look like the vacant path.
	await delay(Number(process.env.DEV3_TAKEOVER_HOLD_MS ?? "2500"));
	// Not `pty.destroySession`: the host, shell and the parent's session must survive.
	try {
		ws.send(releaseMessage());
	} catch { /* socket already gone */ }
	ws.close();
	process.exit(0);
}

void main().catch((err) => {
	emit({ ok: false, error: err instanceof Error ? err.message : String(err), peerPid: process.pid });
	process.exit(1);
});
