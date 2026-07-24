/**
 * Compatibility fixtures for the terminal backend identity codec.
 *
 * These stand in for records the codec must survive across the tmux-removal
 * roadmap: legacy records with no field, explicit current records, records
 * carrying an unknown future value or unrelated extra properties, and the
 * malformed / wrong-type inputs that must fail honestly. {@link COMPAT_CASES}
 * pairs each input with its expected decode so the tests stay data-driven.
 */

import {
	TERMINAL_BACKEND_FIELD,
	type TerminalBackendDecodeErrorCode,
	type TerminalBackendIdentity,
} from "./index";

/** Legacy record predating the field — the common on-disk shape today. */
export const LEGACY_RECORD_NO_FIELD = { id: "task-legacy", title: "Legacy task" } as const;

/** Legacy record that also carries unrelated properties the codec must ignore. */
export const LEGACY_RECORD_EXTRA_PROPS = {
	id: "task-legacy-extra",
	title: "Legacy with extras",
	createdAt: 1_700_000_000_000,
	nested: { runtime: "idle" },
} as const;

/** Explicit current records for each recognized identity. */
export const EXPLICIT_TMUX_RECORD = { id: "task-tmux", [TERMINAL_BACKEND_FIELD]: "tmux" } as const;
export const EXPLICIT_NATIVE_RECORD = { id: "task-native", [TERMINAL_BACKEND_FIELD]: "native" } as const;

/** Explicit record surrounded by unrelated properties (order preservation matters). */
export const EXPLICIT_NATIVE_WITH_EXTRAS = {
	id: "task-native-extra",
	[TERMINAL_BACKEND_FIELD]: "native",
	title: "Native with extras",
	labels: ["kill-tmux"],
} as const;

/** A record from a hypothetical future that stored an identity this build doesn't know. */
export const UNKNOWN_FUTURE_VALUE_RECORD = { id: "task-future", [TERMINAL_BACKEND_FIELD]: "wezterm" } as const;

/**
 * A future record that added a *sibling* field but no `terminalBackend` — it must
 * still decode as legacy, and the unknown sibling must survive a round-trip.
 */
export const UNKNOWN_FUTURE_SIBLING_RECORD = {
	id: "task-future-sibling",
	terminalBackendVersion: 2,
	terminalBackendCapabilities: ["images"],
} as const;

/** Field present but the wrong type — must fail with `invalid-type`, never coerce. */
export const WRONG_TYPE_RECORDS: readonly Record<string, unknown>[] = [
	{ id: "wrong-number", [TERMINAL_BACKEND_FIELD]: 1 },
	{ id: "wrong-null", [TERMINAL_BACKEND_FIELD]: null },
	{ id: "wrong-boolean", [TERMINAL_BACKEND_FIELD]: true },
	{ id: "wrong-object", [TERMINAL_BACKEND_FIELD]: {} },
	{ id: "wrong-array", [TERMINAL_BACKEND_FIELD]: ["native"] },
	{ id: "wrong-undefined", [TERMINAL_BACKEND_FIELD]: undefined },
];

/** Inputs that are not a plain object record — must fail with `malformed-container`. */
export const MALFORMED_CONTAINERS: readonly unknown[] = [
	null,
	undefined,
	"tmux",
	42,
	true,
	["tmux"],
	[{ [TERMINAL_BACKEND_FIELD]: "tmux" }],
];

interface DecodeSuccessExpectation {
	ok: true;
	backend: TerminalBackendIdentity;
	present: boolean;
}

interface DecodeFailureExpectation {
	ok: false;
	code: TerminalBackendDecodeErrorCode;
}

export interface CompatCase {
	label: string;
	input: unknown;
	expected: DecodeSuccessExpectation | DecodeFailureExpectation;
}

/** Every documented compatibility case with its expected decode outcome. */
export const COMPAT_CASES: readonly CompatCase[] = [
	{
		label: "legacy record with no field → effective tmux, absent",
		input: LEGACY_RECORD_NO_FIELD,
		expected: { ok: true, backend: "tmux", present: false },
	},
	{
		label: "legacy record with unrelated extras → effective tmux, absent",
		input: LEGACY_RECORD_EXTRA_PROPS,
		expected: { ok: true, backend: "tmux", present: false },
	},
	{
		label: "unknown future sibling field but no backend → effective tmux, absent",
		input: UNKNOWN_FUTURE_SIBLING_RECORD,
		expected: { ok: true, backend: "tmux", present: false },
	},
	{
		label: "explicit tmux → tmux, present",
		input: EXPLICIT_TMUX_RECORD,
		expected: { ok: true, backend: "tmux", present: true },
	},
	{
		label: "explicit native → native, present",
		input: EXPLICIT_NATIVE_RECORD,
		expected: { ok: true, backend: "native", present: true },
	},
	{
		label: "explicit native among unrelated properties → native, present",
		input: EXPLICIT_NATIVE_WITH_EXTRAS,
		expected: { ok: true, backend: "native", present: true },
	},
	{
		label: "unknown future value → unknown-value failure",
		input: UNKNOWN_FUTURE_VALUE_RECORD,
		expected: { ok: false, code: "unknown-value" },
	},
	...WRONG_TYPE_RECORDS.map(
		(input): CompatCase => ({
			label: `wrong type (${String(input.id)}) → invalid-type failure`,
			input,
			expected: { ok: false, code: "invalid-type" },
		}),
	),
	...MALFORMED_CONTAINERS.map(
		(input, index): CompatCase => ({
			label: `malformed container #${index} → malformed-container failure`,
			input,
			expected: { ok: false, code: "malformed-container" },
		}),
	),
];
