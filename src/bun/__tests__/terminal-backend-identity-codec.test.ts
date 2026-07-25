import { describe, expect, it } from "vitest";

import {
	decodeTerminalBackend,
	encodeTerminalBackend,
	isTerminalBackendIdentity,
	LEGACY_TERMINAL_BACKEND,
	TERMINAL_BACKEND_FIELD,
	TERMINAL_BACKENDS,
	type TerminalBackendDecodeSuccess,
} from "../../shared/terminal-backend-identity";
import {
	COMPAT_CASES,
	EXPLICIT_NATIVE_WITH_EXTRAS,
	LEGACY_RECORD_EXTRA_PROPS,
	LEGACY_RECORD_NO_FIELD,
	UNKNOWN_FUTURE_SIBLING_RECORD,
} from "../../shared/terminal-backend-identity/fixtures";

function decodeOrThrow(source: unknown): TerminalBackendDecodeSuccess {
	const result = decodeTerminalBackend(source);
	if (!result.ok) throw new Error(`expected a successful decode, got ${result.code}`);
	return result;
}

describe("constants", () => {
	it("recognizes exactly tmux and native", () => {
		expect(TERMINAL_BACKENDS).toEqual(["tmux", "native"]);
	});

	it("treats tmux as the legacy effective backend", () => {
		expect(LEGACY_TERMINAL_BACKEND).toBe("tmux");
	});

	it("owns the future field name locally", () => {
		expect(TERMINAL_BACKEND_FIELD).toBe("terminalBackend");
	});
});

describe("isTerminalBackendIdentity", () => {
	it("accepts supported identities", () => {
		expect(isTerminalBackendIdentity("tmux")).toBe(true);
		expect(isTerminalBackendIdentity("native")).toBe(true);
	});

	it("rejects everything else", () => {
		for (const value of ["", "TMUX", "wezterm", 1, null, undefined, {}, ["native"], true]) {
			expect(isTerminalBackendIdentity(value)).toBe(false);
		}
	});
});

describe("decodeTerminalBackend — compatibility table", () => {
	it.each([...COMPAT_CASES])("$label", ({ input, expected }) => {
		const result = decodeTerminalBackend(input);
		expect(result.ok).toBe(expected.ok);

		if (expected.ok) {
			if (!result.ok) throw new Error("expected success");
			expect(result.backend).toBe(expected.backend);
			expect(result.present).toBe(expected.present);
		} else {
			if (result.ok) throw new Error("expected failure");
			expect(result.code).toBe(expected.code);
			// A failure never guesses a backend (the dedicated test below proves
			// native is never selected); `received` may echo the offending input.
			expect(result).not.toHaveProperty("backend");
		}
	});
});

describe("decodeTerminalBackend — legacy default", () => {
	it("resolves a missing field to effective tmux while preserving absence", () => {
		const result = decodeOrThrow(LEGACY_RECORD_NO_FIELD);
		expect(result.backend).toBe("tmux");
		expect(result.present).toBe(false);
	});

	it("ignores unrelated and unknown-future sibling properties", () => {
		expect(decodeOrThrow(LEGACY_RECORD_EXTRA_PROPS).present).toBe(false);
		expect(decodeOrThrow(UNKNOWN_FUTURE_SIBLING_RECORD).backend).toBe("tmux");
	});

	it("never selects native for any input without an explicit native field", () => {
		for (const { input, expected } of COMPAT_CASES) {
			const isExplicitNative = expected.ok && expected.present && expected.backend === "native";
			if (isExplicitNative) continue;
			const result = decodeTerminalBackend(input);
			if (result.ok) expect(result.backend).not.toBe("native");
		}
	});
});

describe("round-trip", () => {
	it.each([...TERMINAL_BACKENDS])("explicit %s round-trips deterministically", (backend) => {
		const source = { id: "task", [TERMINAL_BACKEND_FIELD]: backend };

		const decoded = decodeOrThrow(source);
		expect(decoded).toEqual({ ok: true, backend, present: true });
		expect(decodeTerminalBackend(source)).toEqual(decoded); // deterministic

		const encoded = encodeTerminalBackend(source, decoded);
		expect(encoded).toEqual(source);
		expect(encodeTerminalBackend(source, decoded)).toEqual(encoded); // deterministic
		expect(decodeTerminalBackend(encoded)).toEqual(decoded); // closes the loop
	});

	it("preserves property order when re-encoding an explicit record", () => {
		const decoded = decodeOrThrow(EXPLICIT_NATIVE_WITH_EXTRAS);
		const encoded = encodeTerminalBackend(EXPLICIT_NATIVE_WITH_EXTRAS, decoded);
		expect(Object.keys(encoded)).toEqual(Object.keys(EXPLICIT_NATIVE_WITH_EXTRAS));
	});
});

describe("legacy re-encode never backfills", () => {
	it("does not add a backend field to an untouched legacy record", () => {
		const decoded = decodeOrThrow(LEGACY_RECORD_NO_FIELD);
		const encoded = encodeTerminalBackend(LEGACY_RECORD_NO_FIELD, decoded);

		expect(encoded).not.toHaveProperty(TERMINAL_BACKEND_FIELD);
		expect(encoded).toEqual(LEGACY_RECORD_NO_FIELD);
		expect(JSON.stringify(encoded)).not.toContain("tmux"); // effective tmux is never written out
	});

	it("keeps unrelated properties on a re-encoded legacy record", () => {
		const decoded = decodeOrThrow(LEGACY_RECORD_EXTRA_PROPS);
		const encoded = encodeTerminalBackend(LEGACY_RECORD_EXTRA_PROPS, decoded);
		expect(encoded).toEqual(LEGACY_RECORD_EXTRA_PROPS);
		expect(encoded).not.toHaveProperty(TERMINAL_BACKEND_FIELD);
	});
});

describe("immutability", () => {
	it("never mutates the input of decode or encode", () => {
		for (const source of [
			LEGACY_RECORD_NO_FIELD,
			LEGACY_RECORD_EXTRA_PROPS,
			EXPLICIT_NATIVE_WITH_EXTRAS,
		]) {
			const snapshot = structuredClone(source);
			const frozen = Object.freeze(structuredClone(source));

			const decoded = decodeTerminalBackend(frozen);
			expect(source).toEqual(snapshot);

			if (decoded.ok) {
				const encoded = encodeTerminalBackend(frozen, decoded);
				expect(encoded).not.toBe(frozen); // a fresh object, input untouched
				expect(frozen).toEqual(snapshot);
			}
		}
	});
});
