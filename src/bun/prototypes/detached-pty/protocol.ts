/**
 * Wire protocol for the detached-PTY prototype (spike — see ./README.md).
 *
 * One socket carries two channels:
 *   • BINARY frames  = raw PTY bytes (client→host = keystrokes, host→client = output)
 *   • TEXT frames    = JSON control messages (this file)
 *
 * Keeping PTY bytes binary avoids base64 overhead and the multi-byte UTF-8
 * splitting hazards the production pty-server has to work around; control stays
 * human-readable JSON. Pure module: no Bun/Node runtime deps, trivially unit-testable.
 */

export const PROTOCOL_VERSION = 1;

// ── Client → Host ─────────────────────────────────────────────────────
export interface ResizeMessage {
	v: number;
	type: "resize";
	cols: number;
	rows: number;
}
export interface StatusRequest {
	v: number;
	type: "status";
}
export interface StopRequest {
	v: number;
	type: "stop";
}
export type ClientControl = ResizeMessage | StatusRequest | StopRequest;

// ── Host → Client ─────────────────────────────────────────────────────
export interface StatusReply {
	v: number;
	type: "status";
	hostPid: number;
	shellPid: number;
	cols: number;
	rows: number;
	alive: boolean;
	startedAt: string;
}
/** Sent to every client just before the host tears itself down. */
export interface StoppingEvent {
	v: number;
	type: "stopping";
}
/** Sent when the shell exits on its own (not via an explicit stop). */
export interface ExitEvent {
	v: number;
	type: "exit";
	code: number | null;
}
export type HostControl = StatusReply | StoppingEvent | ExitEvent;

export type ControlMessage = ClientControl | HostControl;

export function resizeMessage(cols: number, rows: number): ResizeMessage {
	return { v: PROTOCOL_VERSION, type: "resize", cols, rows };
}
export function statusRequest(): StatusRequest {
	return { v: PROTOCOL_VERSION, type: "status" };
}
export function stopRequest(): StopRequest {
	return { v: PROTOCOL_VERSION, type: "stop" };
}
export function stoppingEvent(): StoppingEvent {
	return { v: PROTOCOL_VERSION, type: "stopping" };
}
export function exitEvent(code: number | null): ExitEvent {
	return { v: PROTOCOL_VERSION, type: "exit", code };
}

export function encodeControl(msg: ControlMessage): string {
	return JSON.stringify(msg);
}

/**
 * Parse a text frame into a control message, or null if it is not a valid
 * message for this protocol version. Never throws.
 */
export function decodeControl(text: string): ControlMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	if (obj.v !== PROTOCOL_VERSION) return null;
	if (typeof obj.type !== "string") return null;
	switch (obj.type) {
		case "resize":
			if (typeof obj.cols !== "number" || typeof obj.rows !== "number") return null;
			return obj as unknown as ResizeMessage;
		case "status":
		case "stop":
		case "stopping":
		case "exit":
			return obj as unknown as ControlMessage;
		default:
			return null;
	}
}
