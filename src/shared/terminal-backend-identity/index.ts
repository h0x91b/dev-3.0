/**
 * Terminal backend identity codec (tmux-removal roadmap seq 1141, MIG-003).
 *
 * A tiny, pure value codec that freezes the backward-compatible semantics a
 * future persisted "which terminal backend runs this session" field must obey,
 * WITHOUT wiring the field into any schema, loader, migration, or UI. This is
 * identity only — no capabilities, versions, negotiation, or backend interface.
 *
 * The contract it locks in:
 *   - A record that predates the field decodes to the effective legacy backend
 *     (`tmux`) while still reporting that the field was absent.
 *   - Explicit `tmux`/`native` round-trip deterministically.
 *   - Anything else (unknown string, wrong type, non-object container) returns a
 *     typed failure — never a silent `native`, never a fallback.
 *   - Re-encoding a legacy record never backfills the effective `tmux`, and no
 *     operation mutates its input.
 *
 * Attaching {@link TERMINAL_BACKEND_FIELD} to the on-disk Task/Project schema is
 * deliberately a follow-up, not part of this module — see decision 164.
 */

/** The only terminal backend identities this codec recognizes. */
export const TERMINAL_BACKENDS = ["tmux", "native"] as const;

/** A recognized terminal backend identity: `tmux` (legacy) or `native`. */
export type TerminalBackendIdentity = (typeof TERMINAL_BACKENDS)[number];

/** Effective backend for a record written before the field existed. */
export const LEGACY_TERMINAL_BACKEND: TerminalBackendIdentity = "tmux";

/**
 * The record key that will carry the identity once persistence is wired. The
 * name is owned here (not in the Task/Project schema) on purpose: this task
 * freezes the codec; adding the field to on-disk records is the follow-up.
 */
export const TERMINAL_BACKEND_FIELD = "terminalBackend" as const;

/** Why {@link decodeTerminalBackend} rejected its input. */
export type TerminalBackendDecodeErrorCode =
	/** Input is not a plain object (null, array, primitive, …). */
	| "malformed-container"
	/** The field is present but not a string. */
	| "invalid-type"
	/** The field is a string but not a supported identity. */
	| "unknown-value";

/** A record whose backend identity was read successfully. */
export interface TerminalBackendDecodeSuccess {
	ok: true;
	/** Effective identity; a legacy record resolves to {@link LEGACY_TERMINAL_BACKEND}. */
	backend: TerminalBackendIdentity;
	/** Whether the field actually existed on the input (false for legacy records). */
	present: boolean;
}

/** A record the codec refused to interpret; it never guesses a backend. */
export interface TerminalBackendDecodeFailure {
	ok: false;
	code: TerminalBackendDecodeErrorCode;
	/** The offending value (the whole input for `malformed-container`). */
	received: unknown;
}

export type TerminalBackendDecodeResult = TerminalBackendDecodeSuccess | TerminalBackendDecodeFailure;

/** Type guard for a recognized identity string. */
export function isTerminalBackendIdentity(value: unknown): value is TerminalBackendIdentity {
	return value === "tmux" || value === "native";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasField(record: Record<string, unknown>, field: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, field);
}

/**
 * Read the terminal backend identity from a persisted record without mutating
 * it. Missing field → effective `tmux` (`present: false`); explicit
 * `tmux`/`native` → that value (`present: true`); anything else → a typed
 * failure. The codec never silently selects `native` and never falls back.
 */
export function decodeTerminalBackend(source: unknown): TerminalBackendDecodeResult {
	if (!isPlainRecord(source)) {
		return { ok: false, code: "malformed-container", received: source };
	}
	if (!hasField(source, TERMINAL_BACKEND_FIELD)) {
		return { ok: true, backend: LEGACY_TERMINAL_BACKEND, present: false };
	}
	const value = source[TERMINAL_BACKEND_FIELD];
	if (typeof value !== "string") {
		return { ok: false, code: "invalid-type", received: value };
	}
	if (!isTerminalBackendIdentity(value)) {
		return { ok: false, code: "unknown-value", received: value };
	}
	return { ok: true, backend: value, present: true };
}

/**
 * Record-level inverse of {@link decodeTerminalBackend}: given the original
 * record and its successful decode, produce a NEW record to persist. A legacy
 * decode (`present: false`) copies the record WITHOUT the field — the effective
 * `tmux` is never backfilled. An explicit decode writes the identity back in
 * place. The input is never mutated.
 */
export function encodeTerminalBackend<T extends object>(
	source: T,
	decoded: TerminalBackendDecodeSuccess,
): T {
	const clone = { ...(source as Record<string, unknown>) };
	if (decoded.present) {
		clone[TERMINAL_BACKEND_FIELD] = decoded.backend;
	} else {
		delete clone[TERMINAL_BACKEND_FIELD];
	}
	return clone as unknown as T;
}
