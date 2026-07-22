/**
 * Wire protocol v1 for the native-session registry host transport (seq 1214/1216).
 *
 * One loopback WebSocket carries two channels:
 *   • BINARY frames  = raw PTY bytes (client→host = keystrokes, host→client = output)
 *   • TEXT frames    = JSON control messages (this file)
 *
 * This is a deliberately small LOCAL protocol, not an RPC framework. A client
 * opens with a version-agnostic `hello`; the host replies `welcome` (accept) or
 * one explicit `error{code:"version-mismatch"}` and leaves the shell alive. Only
 * the two request/response pairs (hello→welcome, status→status) carry a request
 * `id`; every other frame is a fire-and-forget command or an unsolicited event.
 * Unknown ADDITIVE fields on a known type are ignored; a future breaking change
 * bumps NATIVE_SESSION_PROTOCOL_VERSION rather than negotiating in-band.
 *
 * Pure module: no Bun/Node runtime deps, trivially unit-testable.
 */

export const NATIVE_SESSION_PROTOCOL_VERSION = 1;

/** Control (TEXT) frames are tiny JSON; anything larger is rejected, never parsed. */
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

/** The only rejection codes v1 emits. `unauthorized` is surfaced as HTTP 401 at upgrade. */
export type ErrorCode =
	| "bad-request"
	| "unauthorized"
	| "version-mismatch"
	| "not-found"
	| "conflict"
	| "internal-error";

// ── Client → Host ─────────────────────────────────────────────────────
/** First frame on every connection; parsed version-agnostically by the host. */
export interface HelloMessage {
	v: number;
	type: "hello";
	sessionId: string;
	id: number;
}
export interface ResizeMessage {
	v: number;
	type: "resize";
	cols: number;
	rows: number;
}
export interface StatusRequest {
	v: number;
	type: "status";
	id: number;
}
export interface StopRequest {
	v: number;
	type: "stop";
}
export type ClientControl = HelloMessage | ResizeMessage | StatusRequest | StopRequest;

// ── Host → Client ─────────────────────────────────────────────────────
/** Accepts a hello; echoes the hello's request id. */
export interface WelcomeMessage {
	v: number;
	type: "welcome";
	id: number;
	sessionId: string;
	protocolVersion: number;
}
export interface ErrorMessage {
	v: number;
	type: "error";
	code: ErrorCode;
	/** Echoes the offending request id when the error answers one. */
	id?: number;
	message?: string;
}
export interface StatusReply {
	v: number;
	type: "status";
	id: number;
	sessionId: string;
	paneId: string;
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
export type HostControl = WelcomeMessage | ErrorMessage | StatusReply | StoppingEvent | ExitEvent;

export type ControlMessage = ClientControl | HostControl;

// ── Builders ──────────────────────────────────────────────────────────
export function helloMessage(sessionId: string, id: number): HelloMessage {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "hello", sessionId, id };
}
export function welcomeMessage(id: number, sessionId: string): WelcomeMessage {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "welcome", id, sessionId, protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION };
}
export function errorMessage(code: ErrorCode, id?: number, message?: string): ErrorMessage {
	const msg: ErrorMessage = { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "error", code };
	if (id !== undefined) msg.id = id;
	if (message !== undefined) msg.message = message;
	return msg;
}
export function resizeMessage(cols: number, rows: number): ResizeMessage {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "resize", cols, rows };
}
export function statusRequest(id: number): StatusRequest {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "status", id };
}
export function stopRequest(): StopRequest {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "stop" };
}
export function stoppingEvent(): StoppingEvent {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "stopping" };
}
export function exitEvent(code: number | null): ExitEvent {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "exit", code };
}

export function encodeControl(msg: ControlMessage): string {
	return JSON.stringify(msg);
}

/** True when a TEXT control frame exceeds the v1 size limit and must not be parsed. */
export function exceedsControlFrameLimit(text: string): boolean {
	return Buffer.byteLength(text, "utf8") > MAX_CONTROL_FRAME_BYTES;
}

function parseObject(text: string): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	return parsed as Record<string, unknown>;
}

/**
 * Parse a `hello` frame WITHOUT gating on the protocol version — the host must be
 * able to read a foreign-version hello in order to answer it with an explicit
 * version-mismatch error. Returns null for anything that is not a hello frame.
 */
export function decodeHello(text: string): HelloMessage | null {
	const obj = parseObject(text);
	if (!obj || obj.type !== "hello") return null;
	if (typeof obj.v !== "number" || typeof obj.sessionId !== "string" || typeof obj.id !== "number") return null;
	return { v: obj.v, type: "hello", sessionId: obj.sessionId, id: obj.id };
}

/**
 * Parse an `error` frame version-agnostically — a client whose version the host
 * rejected must still be able to READ the rejection. Returns null otherwise.
 */
export function decodeError(text: string): ErrorMessage | null {
	const obj = parseObject(text);
	if (!obj || obj.type !== "error" || typeof obj.v !== "number") return null;
	if (typeof obj.code !== "string") return null;
	const msg: ErrorMessage = { v: obj.v, type: "error", code: obj.code as ErrorCode };
	if (typeof obj.id === "number") msg.id = obj.id;
	if (typeof obj.message === "string") msg.message = obj.message;
	return msg;
}

/**
 * Parse a v1 TEXT frame into a control message, or null if it is not a valid
 * message for THIS protocol version. Additive unknown fields are ignored; the
 * version-agnostic `hello`/`error` frames are parsed by their own decoders.
 * Never throws.
 */
export function decodeControl(text: string): ControlMessage | null {
	const obj = parseObject(text);
	if (!obj) return null;
	if (obj.v !== NATIVE_SESSION_PROTOCOL_VERSION) return null;
	if (typeof obj.type !== "string") return null;
	switch (obj.type) {
		case "resize":
			if (typeof obj.cols !== "number" || typeof obj.rows !== "number") return null;
			return obj as unknown as ResizeMessage;
		case "status":
			if (typeof obj.id !== "number") return null;
			return obj as unknown as StatusRequest | StatusReply;
		case "welcome":
			if (typeof obj.id !== "number") return null;
			return obj as unknown as WelcomeMessage;
		case "error":
			return decodeError(text);
		case "stop":
		case "stopping":
		case "exit":
			return obj as unknown as ControlMessage;
		default:
			return null;
	}
}

/** The host's verdict on a first (hello) frame — pure, so it is unit-testable. */
export type HelloVerdict = { ok: true; id: number } | { ok: false; error: ErrorMessage };

/**
 * Decide whether a first frame is an acceptable v1 hello for `expectedSessionId`.
 * A non-hello frame is bad-request; a foreign version is version-mismatch; a
 * wrong session id is not-found. On every failure the caller sends `error` and
 * closes only that socket — the host and shell stay alive.
 */
export function evaluateHello(text: string, expectedSessionId: string): HelloVerdict {
	const hello = decodeHello(text);
	if (!hello) return { ok: false, error: errorMessage("bad-request", undefined, "expected a hello frame") };
	if (hello.v !== NATIVE_SESSION_PROTOCOL_VERSION) {
		return { ok: false, error: errorMessage("version-mismatch", hello.id, `host speaks protocol v${NATIVE_SESSION_PROTOCOL_VERSION}`) };
	}
	if (hello.sessionId !== expectedSessionId) {
		return { ok: false, error: errorMessage("not-found", hello.id, "session id does not match this host") };
	}
	return { ok: true, id: hello.id };
}
