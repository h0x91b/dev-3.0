/**
 * Wire protocol v1 for the native-session registry host transport (seq 1214/1216).
 *
 * One loopback WebSocket carries two channels:
 *   • BINARY frames  = raw PTY bytes (client→host = keystrokes, host→client = output)
 *   • TEXT frames    = JSON control messages (this file)
 *
 * This is a deliberately small LOCAL protocol, not an RPC framework. A client
 * opens with a version-agnostic `hello`; the host replies `welcome` (accept) or
 * one explicit `error{code:"version-mismatch"}` and leaves the shell alive. The
 * request/response pairs — hello→welcome, status→status, ownership→ownership and
 * resize→resized — carry a request `id` from one connection-wide space; every other frame
 * is a fire-and-forget command or an unsolicited event.
 * Unknown ADDITIVE fields on a known type are ignored; a future breaking change
 * bumps NATIVE_SESSION_PROTOCOL_VERSION rather than negotiating in-band.
 *
 * Two reply types double as unsolicited EVENTS when their `id` is 0: `ownership`
 * (the lease moved without this client asking) and `status` (the writer resized the
 * canonical grid). A client with no pending request must apply them, not drop them.
 *
 * Pure module: no Bun/Node runtime deps, trivially unit-testable.
 */

import type { ClientRole, WriterAction } from "./writer-ownership";

export const NATIVE_SESSION_PROTOCOL_VERSION = 1;

/**
 * What THIS host build can do, announced on `welcome`. Capabilities are how a client
 * knows a feature exists instead of inferring it from a timeout: an older host simply
 * omits the field, and a client must read that as "not supported", never as "broken".
 */
// ONE literal tuple is the source of truth; the union is derived so the two cannot
// drift. A capability earns its place only when a caller actually negotiates on it —
// `writerGeneration` rides every reply as a plain field and needs no announcement.
export const HOST_CAPABILITIES = ["takeover", "resize-ack", "replay-boundary"] as const;
export type HostCapability = (typeof HOST_CAPABILITIES)[number];

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
	/**
	 * Additive: the OS pid of the app process behind this client. Several dev3 app
	 * processes share one host, and only the writer's input lands — a peer needs to
	 * know which process to route a write to. Absent from older clients.
	 */
	clientPid?: number;
}
export interface ResizeMessage {
	v: number;
	type: "resize";
	cols: number;
	rows: number;
	/** Additive: correlates the `resized` acknowledgement. Absent = fire-and-forget. */
	id?: number;
	/**
	 * Additive: the writer generation the sender BELIEVES is current. The host refuses
	 * the resize when it no longer matches, which is what stops a client whose role
	 * cache is stale from resizing a PTY it no longer owns.
	 */
	expectedGeneration?: number;
}
export interface StatusRequest {
	v: number;
	type: "status";
	id: number;
}
export interface OwnershipRequest {
	v: number;
	type: "ownership";
	id: number;
	action: WriterAction;
}
export interface StopRequest {
	v: number;
	type: "stop";
}
export type ClientControl = HelloMessage | ResizeMessage | StatusRequest | OwnershipRequest | StopRequest;

/**
 * The host APPLIED a resize. Its own name (not a `resize` echo) so request and
 * acknowledgement can never be confused for one another on a shared channel.
 */
export interface ResizedReply {
	v: number;
	type: "resized";
	id: number;
	cols: number;
	rows: number;
	writerGeneration: number;
}

// ── Host → Client ─────────────────────────────────────────────────────
/** Accepts a hello; echoes the hello's request id. */
export interface WelcomeMessage {
	v: number;
	type: "welcome";
	id: number;
	sessionId: string;
	protocolVersion: number;
	/** Additive in v1; absent hosts predate explicit writer ownership. */
	role?: ClientRole;
	/** Additive: what this host supports. Absent = an old host; assume nothing. */
	capabilities?: readonly HostCapability[];
	/** Additive: the writer generation at attach time. */
	writerGeneration?: number;
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
	/** Per-connection ephemeral ownership state; never persisted in record.json. */
	clientRole?: ClientRole;
	writerAttached?: boolean;
	/**
	 * Additive: pid of the app process holding the writer lease, so a non-owning
	 * peer can route a write instead of silently losing it. `null` when the slot is
	 * vacant; absent when the writer's client predates `clientPid`, which callers
	 * must treat as "unknown", never as "vacant".
	 */
	writerPid?: number | null;
	/** Additive: monotonic count of real lease transitions on this host. */
	writerGeneration?: number;
}
export interface OwnershipReply {
	v: number;
	type: "ownership";
	id: number;
	role: ClientRole;
	writerAttached: boolean;
	/** Additive: the generation AFTER this reply's transition, if any. */
	writerGeneration?: number;
}
/**
 * Marks the end of the journal replay that follows `welcome`. Everything before it is
 * history the client may already hold; everything after is LIVE. Without this boundary a
 * client cannot tell replay from output produced while its handshake was still finishing,
 * so it must either duplicate history or risk dropping real bytes.
 */
export interface ReplayedEvent {
	v: number;
	type: "replayed";
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
export type HostControl =
	| WelcomeMessage
	| ErrorMessage
	| StatusReply
	| OwnershipReply
	| ResizedReply
	| ReplayedEvent
	| StoppingEvent
	| ExitEvent;

export type ControlMessage = ClientControl | HostControl;

// ── Builders ──────────────────────────────────────────────────────────
export function helloMessage(sessionId: string, id: number, clientPid?: number): HelloMessage {
	return {
		v: NATIVE_SESSION_PROTOCOL_VERSION,
		type: "hello",
		sessionId,
		id,
		...(clientPid !== undefined ? { clientPid } : {}),
	};
}
export function welcomeMessage(
	id: number,
	sessionId: string,
	role?: ClientRole,
	extra?: { capabilities?: readonly HostCapability[]; writerGeneration?: number },
): WelcomeMessage {
	return {
		v: NATIVE_SESSION_PROTOCOL_VERSION,
		type: "welcome",
		id,
		sessionId,
		protocolVersion: NATIVE_SESSION_PROTOCOL_VERSION,
		...(role ? { role } : {}),
		...(extra?.capabilities ? { capabilities: extra.capabilities } : {}),
		...(extra?.writerGeneration !== undefined ? { writerGeneration: extra.writerGeneration } : {}),
	};
}
export function errorMessage(code: ErrorCode, id?: number, message?: string): ErrorMessage {
	const msg: ErrorMessage = { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "error", code };
	if (id !== undefined) msg.id = id;
	if (message !== undefined) msg.message = message;
	return msg;
}
export function resizeMessage(
	cols: number,
	rows: number,
	correlation?: { id?: number; expectedGeneration?: number },
): ResizeMessage {
	return {
		v: NATIVE_SESSION_PROTOCOL_VERSION,
		type: "resize",
		cols,
		rows,
		...(correlation?.id !== undefined ? { id: correlation.id } : {}),
		...(correlation?.expectedGeneration !== undefined ? { expectedGeneration: correlation.expectedGeneration } : {}),
	};
}
export function resizedReply(id: number, cols: number, rows: number, writerGeneration: number): ResizedReply {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "resized", id, cols, rows, writerGeneration };
}
export function statusRequest(id: number): StatusRequest {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "status", id };
}
export function ownershipRequest(id: number, action: WriterAction): OwnershipRequest {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "ownership", id, action };
}
export function ownershipReply(
	id: number,
	role: ClientRole,
	writerAttached: boolean,
	writerGeneration?: number,
): OwnershipReply {
	return {
		v: NATIVE_SESSION_PROTOCOL_VERSION,
		type: "ownership",
		id,
		role,
		writerAttached,
		...(writerGeneration !== undefined ? { writerGeneration } : {}),
	};
}
export function stopRequest(): StopRequest {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "stop" };
}
export function replayedEvent(): ReplayedEvent {
	return { v: NATIVE_SESSION_PROTOCOL_VERSION, type: "replayed" };
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
	const hello: HelloMessage = { v: obj.v, type: "hello", sessionId: obj.sessionId, id: obj.id };
	// Rebuilt field-by-field, so an additive field survives only if copied here.
	if (typeof obj.clientPid === "number" && Number.isInteger(obj.clientPid) && obj.clientPid > 0) {
		hello.clientPid = obj.clientPid;
	}
	return hello;
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
		case "resized":
			if (typeof obj.id !== "number" || typeof obj.cols !== "number") return null;
			if (typeof obj.rows !== "number" || typeof obj.writerGeneration !== "number") return null;
			return obj as unknown as ResizedReply;
		case "status":
			if (typeof obj.id !== "number") return null;
			return obj as unknown as StatusRequest | StatusReply;
		case "ownership":
			if (typeof obj.id !== "number") return null;
			// `takeover` is additive in v1: a host staged before it drops the frame as
			// unparseable, which the client reads as a timeout, never as a success.
			if (obj.action === "claim" || obj.action === "release" || obj.action === "takeover") {
				return obj as unknown as OwnershipRequest;
			}
			if ((obj.role === "writer" || obj.role === "observer") && typeof obj.writerAttached === "boolean") {
				return obj as unknown as OwnershipReply;
			}
			return null;
		case "welcome":
			if (typeof obj.id !== "number") return null;
			if (obj.role !== undefined && obj.role !== "writer" && obj.role !== "observer") return null;
			if (obj.capabilities !== undefined && !Array.isArray(obj.capabilities)) return null;
			return obj as unknown as WelcomeMessage;
		case "error":
			return decodeError(text);
		case "stop":
		case "stopping":
		case "replayed":
			return obj as unknown as ControlMessage;
		case "exit":
			if (obj.code !== null && (typeof obj.code !== "number" || !Number.isInteger(obj.code))) return null;
			return obj as unknown as ExitEvent;
		default:
			return null;
	}
}

/** The host's verdict on a first (hello) frame — pure, so it is unit-testable. */
export type HelloVerdict = { ok: true; id: number; clientPid?: number } | { ok: false; error: ErrorMessage };

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
	return { ok: true, id: hello.id, ...(hello.clientPid !== undefined ? { clientPid: hello.clientPid } : {}) };
}
