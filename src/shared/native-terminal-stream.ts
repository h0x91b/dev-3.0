/**
 * In-band control framing for the NATIVE terminal's browser/desktop bridge
 * (seq 1300).
 *
 * The PTY WebSocket (`/pty?session=…`, proxied verbatim by remote mode) carries
 * raw terminal text in both directions. The native backend needs a little more
 * than raw text — a sequence watermark to resume from, an explicit reset when a
 * reconnecting client fell off the bounded journal, and the writer/observer role
 * — so a native session prefixes each message with ONE APC-framed JSON header:
 *
 *   ESC _ dev3nt; {"t":"o","v":1,"seq":42} ESC \  <raw terminal bytes…>
 *
 * Why in-band instead of a JSON envelope around the payload: terminal output is
 * the hot path (thousands of frames/sec), and JSON-escaping every byte of it
 * costs far more than one `indexOf` plus a ~40-byte parse. Why APC: it is the
 * same trick the resize protocol already uses, and a terminal emulator that ever
 * saw a stray frame would ignore it rather than render garbage.
 *
 * Tmux sessions never see any of this — they keep sending bare text, byte for
 * byte as before.
 *
 * Pure module: no runtime deps, shared by the bun bridge and the renderer.
 */

export const NATIVE_STREAM_PROTOCOL_VERSION = 1;

const PREFIX = "\x1b_dev3nt;";
const SUFFIX = "\x1b\\";

/** Who may write to the shell: exactly one client per session at a time. */
export type NativeStreamRole = "writer" | "observer";

/** Why the server rebuilt the screen instead of sending the next delta. */
export type NativeStreamResetReason = "fresh" | "gap" | "pressure";

/** First message on every native attach; the payload is the replayed tail. */
export interface NativeStreamAttachHeader {
	t: "attach";
	v: number;
	/** Sequence of the last replayed frame; resume from here after a drop. */
	seq: number;
	role: NativeStreamRole;
	sessionId: string;
	paneId: string;
	hostPid: number;
	shellPid: number;
	/** False when the client's `since` was out of range and the screen was rebuilt. */
	resumed: boolean;
	/** Set only when `resumed` is false, so the client can clear before writing. */
	reset?: NativeStreamResetReason;
	/**
	 * The PTY's own size. An observer must render at THIS geometry, not at its
	 * container's: the bytes were laid out for the writer's width, so a viewer
	 * that reflows them to its own width wraps every long line wrongly.
	 */
	cols?: number;
	rows?: number;
	/** Whether ANY client holds the write lease; false = the slot is free. */
	writerAttached?: boolean;
}

/** One batch of live output; the payload is the raw terminal bytes. */
export interface NativeStreamOutputHeader {
	t: "o";
	v: number;
	seq: number;
}

/** The client's role changed (takeover, or promotion after the writer left). */
export interface NativeStreamRoleHeader {
	t: "role";
	v: number;
	role: NativeStreamRole;
	/** Set when the server refused this client's input or resize. */
	refused?: boolean;
	/** The PTY's size, so an observer keeps following the writer's geometry. */
	cols?: number;
	rows?: number;
	/**
	 * Whether ANY client holds the write lease. False means the slot is free and
	 * taking control will succeed, which is a different sentence from "someone
	 * else is typing" and must not be shown as the same one.
	 */
	writerAttached?: boolean;
}

export type NativeStreamServerHeader =
	| NativeStreamAttachHeader
	| NativeStreamOutputHeader
	| NativeStreamRoleHeader;

/** Client → server: take the writer lease, or hand it back. */
export interface NativeStreamOwnershipHeader {
	t: "claim" | "release";
	v: number;
}

export type NativeStreamClientHeader = NativeStreamOwnershipHeader;

export type NativeStreamHeader = NativeStreamServerHeader | NativeStreamClientHeader;

export interface NativeStreamMessage<H extends NativeStreamHeader = NativeStreamHeader> {
	header: H;
	/** Raw terminal bytes that follow the header; empty for control-only frames. */
	payload: string;
}

/** True when a WebSocket text frame is a native-stream message rather than terminal data. */
export function isNativeStreamMessage(text: string): boolean {
	return text.startsWith(PREFIX);
}

export function encodeNativeStreamMessage(header: NativeStreamHeader, payload = ""): string {
	return `${PREFIX}${JSON.stringify(header)}${SUFFIX}${payload}`;
}

function isValidHeader(value: unknown): value is NativeStreamHeader {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (obj.v !== NATIVE_STREAM_PROTOCOL_VERSION) return false;
	switch (obj.t) {
		case "attach":
			return (
				typeof obj.seq === "number" &&
				(obj.role === "writer" || obj.role === "observer") &&
				typeof obj.sessionId === "string" &&
				typeof obj.paneId === "string" &&
				typeof obj.hostPid === "number" &&
				typeof obj.shellPid === "number" &&
				typeof obj.resumed === "boolean"
			);
		case "o":
			return typeof obj.seq === "number";
		case "role":
			return obj.role === "writer" || obj.role === "observer";
		case "claim":
		case "release":
			return true;
		default:
			return false;
	}
}

/**
 * Split a native-stream message into its header and raw payload, or `null` when
 * the text is not one (a truncated or foreign-version frame reads as `null`, so
 * the caller treats it as terminal data and never throws).
 */
export function decodeNativeStreamMessage(text: string): NativeStreamMessage | null {
	if (!isNativeStreamMessage(text)) return null;
	const end = text.indexOf(SUFFIX, PREFIX.length);
	if (end === -1) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(PREFIX.length, end));
	} catch {
		return null;
	}
	if (!isValidHeader(parsed)) return null;
	return { header: parsed, payload: text.slice(end + SUFFIX.length) };
}

// ── Builders ──────────────────────────────────────────────────────────

export function attachMessage(
	fields: Omit<NativeStreamAttachHeader, "t" | "v">,
	payload: string,
): string {
	return encodeNativeStreamMessage({ t: "attach", v: NATIVE_STREAM_PROTOCOL_VERSION, ...fields }, payload);
}

export function outputMessage(seq: number, payload: string): string {
	return encodeNativeStreamMessage({ t: "o", v: NATIVE_STREAM_PROTOCOL_VERSION, seq }, payload);
}

export function roleMessage(
	role: NativeStreamRole,
	refused = false,
	extra?: { cols?: number; rows?: number; writerAttached?: boolean } | null,
): string {
	return encodeNativeStreamMessage({
		t: "role",
		v: NATIVE_STREAM_PROTOCOL_VERSION,
		role,
		...(refused ? { refused: true } : {}),
		...(extra?.cols && extra.rows ? { cols: extra.cols, rows: extra.rows } : {}),
		...(typeof extra?.writerAttached === "boolean" ? { writerAttached: extra.writerAttached } : {}),
	});
}

export function claimMessage(): string {
	return encodeNativeStreamMessage({ t: "claim", v: NATIVE_STREAM_PROTOCOL_VERSION });
}

export function releaseMessage(): string {
	return encodeNativeStreamMessage({ t: "release", v: NATIVE_STREAM_PROTOCOL_VERSION });
}

// ── Resume addressing ─────────────────────────────────────────────────

/** Query parameter a reconnecting client uses to resume from its watermark. */
export const NATIVE_STREAM_SINCE_PARAM = "since";

/**
 * Point a PTY URL at the client's watermark. A client that has never received a
 * frame (or is on tmux) passes `null` and gets the URL back untouched, so the
 * tmux path stays byte-identical.
 */
export function ptyUrlWithSince(url: string, sinceSeq: number | null): string {
	if (sinceSeq === null || !Number.isInteger(sinceSeq) || sinceSeq < 0) return url;
	const separator = url.includes("?") ? "&" : "?";
	return `${url}${separator}${NATIVE_STREAM_SINCE_PARAM}=${sinceSeq}`;
}

/** Read a client's resume watermark from a PTY upgrade URL; `null` when absent or bogus. */
export function parseSinceParam(raw: string | null | undefined): number | null {
	if (raw === null || raw === undefined || raw === "") return null;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : null;
}
