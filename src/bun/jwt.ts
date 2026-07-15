/**
 * Zero-dependency JWT module using Bun's Web Crypto API (HMAC-SHA256).
 *
 * Two token types:
 * - "qr"      — short-lived (30s), embedded in QR code URLs, single-use
 * - "session" — long-lived (24h rolling), carried in an HttpOnly cookie,
 *   refreshable
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEV3_HOME } from "./paths";

// ── Constants ────────────────────────────────────────────────────────

const QR_TOKEN_TTL_S = 30;
// 24 hours — long enough that a "trusted device" (your own phone/laptop)
// survives overnight idle without rescanning the QR. The session rides an
// HttpOnly cookie refreshed on load + every 15 min while open, so an active
// device rolls the window forward indefinitely; a device idle past 24h expires
// and must rescan. Tradeoff: a leaked session stays valid longer — acceptable
// because remote access is already gated by the one-time QR
// (URL-is-the-password) and is meant for the user's own trusted devices.
// See decision 133 (supersedes 086).
export const SESSION_TOKEN_TTL_S = 24 * 60 * 60;

/**
 * Where the persistent HMAC signing secret lives. A NEW file under the dev3
 * home directory (data-layout invariants: only additive — nothing existing is
 * renamed, moved, or rewritten). Persisting the secret is what lets remote
 * sessions survive desktop app restarts; before this the secret was random
 * per-process and every restart silently invalidated all sessions.
 */
const SECRET_FILE = `${DEV3_HOME}/remote-jwt-secret`;

// Pre-encoded JWT header: {"alg":"HS256","typ":"JWT"}
const HEADER_B64 = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";

// ── Types ────────────────────────────────────────────────────────────

export interface JwtPayload {
	type: "qr" | "session";
	iat: number; // issued at (epoch seconds)
	exp: number; // expiration (epoch seconds)
	jti: string; // unique token ID
}

// ── State ────────────────────────────────────────────────────────────

let secret: CryptoKey | null = null;

/** Set of used QR token JTIs for replay prevention. Maps jti → exp. */
const usedQrTokens = new Map<string, number>();

// ── Base64url helpers ────────────────────────────────────────────────

function base64urlEncode(data: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < data.length; i++) {
		binary += String.fromCharCode(data[i]);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
	// Restore standard base64
	let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
	// Add padding
	while (base64.length % 4 !== 0) base64 += "=";
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function encodePayload(payload: JwtPayload): string {
	const json = JSON.stringify(payload);
	return base64urlEncode(new TextEncoder().encode(json));
}

function decodePayload(b64: string): JwtPayload | null {
	try {
		const bytes = base64urlDecode(b64);
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

// ── Core JWT operations ──────────────────────────────────────────────

/**
 * Load the persisted signing secret (64 hex chars = 32 bytes), or null when
 * the file is missing or corrupt (corrupt → regenerate and overwrite).
 */
function loadPersistedSecret(secretFilePath: string): Uint8Array | null {
	try {
		if (!existsSync(secretFilePath)) return null;
		const hex = readFileSync(secretFilePath, "utf-8").trim();
		if (!/^[0-9a-f]{64}$/.test(hex)) return null;
		return new Uint8Array(Buffer.from(hex, "hex"));
	} catch {
		return null;
	}
}

/**
 * Initialize the HMAC-SHA256 signing key. Must be called once at startup.
 * Subsequent calls are no-ops.
 *
 * The secret is persisted to `secretFilePath` (0600, created once) so that
 * session tokens survive app restarts. If the file cannot be written, we fall
 * back to an in-memory secret — auth still works, sessions just die with the
 * process (pre-persistence behavior).
 *
 * @param secretFilePath override for tests only — production callers use the
 *   default `~/.dev3.0/remote-jwt-secret`.
 */
export async function initSecret(secretFilePath: string = SECRET_FILE): Promise<void> {
	if (secret) return;
	let raw = loadPersistedSecret(secretFilePath);
	if (!raw) {
		raw = crypto.getRandomValues(new Uint8Array(32));
		try {
			mkdirSync(dirname(secretFilePath), { recursive: true });
			writeFileSync(secretFilePath, Buffer.from(raw).toString("hex") + "\n", { mode: 0o600 });
		} catch (err) {
			console.warn(`[jwt] Could not persist signing secret to ${secretFilePath} — sessions will not survive restarts:`, err);
		}
	}
	secret = await crypto.subtle.importKey(
		"raw",
		raw as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

async function signJwt(payload: JwtPayload): Promise<string> {
	if (!secret) throw new Error("JWT secret not initialized — call initSecret() first");
	const payloadB64 = encodePayload(payload);
	const data = new TextEncoder().encode(`${HEADER_B64}.${payloadB64}`);
	const sig = await crypto.subtle.sign("HMAC", secret, data);
	const sigB64 = base64urlEncode(new Uint8Array(sig));
	return `${HEADER_B64}.${payloadB64}.${sigB64}`;
}

async function verifyJwt(token: string): Promise<JwtPayload | null> {
	if (!secret) return null;
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [header, payload, signature] = parts;
	if (header !== HEADER_B64) return null;

	try {
		const data = new TextEncoder().encode(`${header}.${payload}`);
		const sig = base64urlDecode(signature);
		const valid = await crypto.subtle.verify("HMAC", secret, sig as BufferSource, data);
		if (!valid) return null;
	} catch {
		return null;
	}

	const decoded = decodePayload(payload);
	if (!decoded) return null;

	// Check expiration
	const now = Math.floor(Date.now() / 1000);
	if (decoded.exp <= now) return null;

	return decoded;
}

// ── Cleanup ──────────────────────────────────────────────────────────

function cleanupUsedTokens(): void {
	const now = Math.floor(Date.now() / 1000);
	for (const [jti, exp] of usedQrTokens) {
		// Keep for 60s after expiration to handle clock skew
		if (exp + 60 < now) {
			usedQrTokens.delete(jti);
		}
	}
}

// ── Public API ───────────────────────────────────────────────────────

/** Create a short-lived QR token (30s). */
export async function createQrToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJwt({
		type: "qr",
		iat: now,
		exp: now + QR_TOKEN_TTL_S,
		jti: crypto.randomUUID(),
	});
}

/** Create a long-lived session token (24h). */
export async function createSessionToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJwt({
		type: "session",
		iat: now,
		exp: now + SESSION_TOKEN_TTL_S,
		jti: crypto.randomUUID(),
	});
}

/**
 * Exchange a QR token for a session token.
 * The QR token must be valid, unexpired, type "qr", and not previously used.
 * Returns session token on success, null on failure.
 */
export async function exchangeQrForSession(token: string): Promise<string | null> {
	cleanupUsedTokens();

	const payload = await verifyJwt(token);
	if (!payload) return null;
	if (payload.type !== "qr") return null;

	// Check replay
	if (usedQrTokens.has(payload.jti)) return null;
	usedQrTokens.set(payload.jti, payload.exp);

	return createSessionToken();
}

/**
 * Refresh a session token. The current token must be valid and unexpired.
 * Returns a fresh session token with a new 24-hour window.
 */
export async function refreshSession(token: string): Promise<string | null> {
	const payload = await verifyJwt(token);
	if (!payload) return null;
	if (payload.type !== "session") return null;
	return createSessionToken();
}

/**
 * Verify that a token is a valid, unexpired session token.
 */
export async function verifySessionToken(token: string): Promise<boolean> {
	const payload = await verifyJwt(token);
	if (!payload) return false;
	return payload.type === "session";
}

// ── Testing helpers ──────────────────────────────────────────────────

/** Reset module state. Only for tests. */
export function _resetForTests(): void {
	secret = null;
	usedQrTokens.clear();
}
