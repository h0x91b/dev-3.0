import { describe, expect, it } from "vitest";

// The neutral half of the pane-input seam: the closed key set, the request guards, and
// the canonical rendering the ledger compares byte for byte. Backend encodings live in
// the adapters and are covered by their own tests.
import {
	PANE_INPUT_KEYS,
	PANE_INPUT_LIMITS,
	canonicalPaneIncarnation,
	describePaneIncarnation,
	isPaneInputKey,
	PANE_INPUT_OUTCOME_FIELDS,
	PANE_INPUT_REASON_SCHEMA,
	isPaneInputReason,
	isPaneInputReasonLegalOn,
	isPaneInputRetryableAsNewDelivery,
	paneInputCanonicalProgram,
	paneInputDeadlineMs,
	paneInputPaneKey,
	paneInputStepCount,
	paneInputTotalDelayMs,
	samePaneIncarnation,
	utf8Length,
	validatePaneInputProgram,
	validatePaneInputSize,
	type PaneIncarnation,
	type PaneInputProgram,
	type PaneInputStage,
	type PaneInputStep,
} from "../../shared/pane-input";

const TASK_ID = "ef0ea197-8cac-4134-99dc-1566191ccca7";

const NATIVE: PaneIncarnation = {
	backend: "native",
	taskId: TASK_ID,
	paneId: "pane-2",
	sessionId: "dev3-task-ef0ea197-pane-2",
	host: { pid: 4242, startSignature: "host-sig" },
	shell: { pid: 4243, startSignature: "shell-sig" },
};

const TMUX: PaneIncarnation = {
	backend: "tmux",
	taskId: TASK_ID,
	paneId: "%3",
	sessionName: "dev3-task-ef0ea197",
	serverToken: "srv-token-1",
};

function program(stages: PaneInputStage[], overrides: Partial<PaneInputProgram> = {}): PaneInputProgram {
	return { deliveryId: "d1", attempt: 1, incarnation: NATIVE, stages, ...overrides };
}

/** A stand-in adapter encoding: text verbatim, every key one byte. */
const oneBytePerKey = (step: PaneInputStep): string =>
	step.kind === "text" ? step.text : "K".repeat(step.count ?? 1);

/** "Type this, wait, submit" as two stages — the shape callers build by hand. */
function submitStages(text: string, submitDelayMs: number): PaneInputStage[] {
	return [
		{ steps: [{ kind: "text", text }] },
		{ delayBeforeMs: submitDelayMs, steps: [{ kind: "key", key: "enter" }] },
	];
}

describe("the key set is closed and derived from one tuple", () => {
	it("has no duplicates and rejects anything outside it", () => {
		expect(new Set(PANE_INPUT_KEYS).size).toBe(PANE_INPUT_KEYS.length);
		expect(isPaneInputKey("left")).toBe(true);
		expect(isPaneInputKey("Left")).toBe(false);
		expect(isPaneInputKey("C-c")).toBe(false);
		expect(isPaneInputKey("f5")).toBe(false);
	});
});

describe("validation runs before anything is executed", () => {
	it("accepts a plain two-stage submit program, rejects an empty program and a stage with no steps", () => {
		expect(validatePaneInputProgram(program(submitStages("hello", 800)))).toBeNull();
		expect(validatePaneInputProgram(program([]))).toBe("no stages");
		expect(validatePaneInputProgram(program([{ steps: [] }]))).toBe("stage without steps");
	});

	// NUL cannot cross a process argv, so no backend can carry it honestly.
	it("rejects an unknown key, an out-of-range repeat and text containing U+0000", () => {
		expect(validatePaneInputProgram(program([{ steps: [{ kind: "key", key: "pageup" as never }] }]))).toContain(
			"unknown key",
		);
		expect(
			validatePaneInputProgram(
				program([{ steps: [{ kind: "key", key: "left", count: PANE_INPUT_LIMITS.maxKeyRepeat + 1 }] }]),
			),
		).toContain("key repeat out of range");
		const bad = program([{ steps: [{ kind: "text", text: "before\u0000after" }] }]);
		expect(validatePaneInputProgram(bad)).toContain("U+0000");
	});

	it("rejects delays and deadlines that cannot work", () => {
		expect(
			validatePaneInputProgram(
				program([
					{ steps: [{ kind: "text", text: "a" }] },
					{ delayBeforeMs: PANE_INPUT_LIMITS.maxTotalDelayMs + 1, steps: [{ kind: "key", key: "enter" }] },
				]),
			),
		).toContain("total delay too long");
		expect(validatePaneInputProgram(program(submitStages("hi", 1_000), { deadlineMs: 500 }))).toContain(
			"cannot cover",
		);
	});

	it("rejects a missing delivery id and a non-positive attempt", () => {
		expect(validatePaneInputProgram(program([{ steps: [{ kind: "text", text: "a" }] }], { deliveryId: "" }))).toBe(
			"deliveryId must be a bounded string",
		);
		expect(validatePaneInputProgram(program([{ steps: [{ kind: "text", text: "a" }] }], { attempt: 0 }))).toContain(
			"invalid attempt",
		);
	});

	it("requires a native incarnation to pin both processes, pid AND signature", () => {
		const steps: PaneInputStage[] = [{ steps: [{ kind: "text", text: "a" }] }];
		const withHost = (host: unknown): PaneInputProgram =>
			program(steps, { incarnation: { ...NATIVE, host } as PaneIncarnation });
		expect(validatePaneInputProgram(withHost({ pid: 0, startSignature: "s" }))).toBe(
			"a native incarnation must pin the host pid",
		);
		expect(validatePaneInputProgram(withHost({ pid: 5, startSignature: "" }))).toBe(
			"a native incarnation must pin the host start signature",
		);
		expect(
			validatePaneInputProgram(
				program(steps, { incarnation: { ...NATIVE, shell: { pid: 5, startSignature: "" } } as PaneIncarnation }),
			),
		).toBe("a native incarnation must pin the shell start signature");
	});

	it("requires a tmux incarnation to pin the session name and the server token, and rejects unknown backends", () => {
		const steps: PaneInputStage[] = [{ steps: [{ kind: "text", text: "a" }] }];
		expect(validatePaneInputProgram(program(steps, { incarnation: { ...TMUX, sessionName: "" } }))).toBe(
			"a tmux incarnation must pin the session name",
		);
		// A restarted server mints the same %ids and its pid can be recycled, so identity
		// rests on a token the server itself holds.
		expect(validatePaneInputProgram(program(steps, { incarnation: { ...TMUX, serverToken: "" } }))).toBe(
			"a tmux incarnation must pin the tmux server token",
		);
		expect(validatePaneInputProgram(program(steps, { incarnation: TMUX }))).toBeNull();
		const bad = program(steps, { incarnation: { ...TMUX, backend: "screen" } as unknown as PaneIncarnation });
		expect(validatePaneInputProgram(bad)).toContain("unknown backend");
	});
});

describe("size guards count UTF-8 bytes, per stage and per program", () => {
	it("counts UTF-8 bytes, passing a small program and rejecting ONE stage over the limit, multibyte included", () => {
		expect(utf8Length("abc")).toBe(3);
		expect(utf8Length("héllo")).toBe(6);
		expect(utf8Length("日本語")).toBe(9);
		expect(utf8Length("🎉")).toBe(4);

		expect(validatePaneInputSize(program(submitStages("deploy", 800)), oneBytePerKey)).toBeNull();
		const over = "x".repeat(PANE_INPUT_LIMITS.maxStageBytes + 1);
		expect(validatePaneInputSize(program([{ steps: [{ kind: "text", text: over }] }]), oneBytePerKey)).toContain(
			"single-operation limit",
		);
		const emoji = "🎉".repeat(PANE_INPUT_LIMITS.maxStageBytes / 4 + 1);
		expect(emoji.length).toBeLessThan(PANE_INPUT_LIMITS.maxStageBytes);
		expect(validatePaneInputSize(program([{ steps: [{ kind: "text", text: emoji }] }]), oneBytePerKey)).toContain(
			"single-operation limit",
		);
	});

	it("counts a coalesced stage as a whole, not step by step", () => {
		const half = "x".repeat(PANE_INPUT_LIMITS.maxStageBytes - 10);
		const detail = validatePaneInputSize(
			program([{ steps: [{ kind: "text", text: half }, { kind: "text", text: "y".repeat(20) }] }]),
			oneBytePerKey,
		);
		expect(detail).toContain("stage 1");
		expect(detail).toContain("single-operation limit");
	});

	it("rejects a program whose legal stages add up past the program limit", () => {
		const stage = (): PaneInputStage => ({
			steps: [{ kind: "text", text: "x".repeat(PANE_INPUT_LIMITS.maxStageBytes) }],
		});
		expect(validatePaneInputSize(program([stage(), stage()]), oneBytePerKey)).toContain(
			`over the ${PANE_INPUT_LIMITS.maxProgramBytes}-byte limit`,
		);
	});

	it("uses the adapter's own encoding rather than assuming one", () => {
		const stages: PaneInputStage[] = [{ steps: [{ kind: "key", key: "left", count: 500 }] }];
		expect(validatePaneInputSize(program(stages), oneBytePerKey)).toBeNull();
		const hugeKey = (): string => "Z".repeat(PANE_INPUT_LIMITS.maxStageBytes + 1);
		expect(validatePaneInputSize(program(stages), hugeKey)).toContain("single-operation limit");
	});
});

describe("one schema decides reasons, legality and retryability", () => {
	it("allows only retryable reasons on not-started, never a post-dispatch cause", () => {
		for (const reason of ["unacknowledged", "lease-lost", "owner-process-replaced"] as const) {
			expect(isPaneInputReasonLegalOn(reason, "not-started"), reason).toBe(false);
		}
		for (const [reason, rule] of Object.entries(PANE_INPUT_REASON_SCHEMA)) {
			if (!rule.retryable) continue;
			expect(isPaneInputReasonLegalOn(reason as never, "not-started"), reason).toBe(true);
		}
	});

	it("gives every verdict an exact field list and recognises only the reasons it defines", () => {
		expect(Object.keys(PANE_INPUT_OUTCOME_FIELDS).sort()).toEqual([
			"delivered",
			"indeterminate",
			"not-started",
			"partial",
		]);
		expect(PANE_INPUT_OUTCOME_FIELDS["not-started"]).toContain("retryableAsNewDelivery");
		expect(PANE_INPUT_OUTCOME_FIELDS.delivered).not.toContain("reason");
		expect(isPaneInputReason("read-only")).toBe(true);
		expect(isPaneInputReason("made-up")).toBe(false);
		expect(isPaneInputReason(undefined)).toBe(false);
	});
});

describe("retrying means a NEW delivery id, and only sometimes", () => {
	it("marks exactly the causes proven to precede dispatch", () => {
		for (const reason of ["owner-unknown", "read-only", "owner-unreachable", "executor-saturated"] as const) {
			expect(isPaneInputRetryableAsNewDelivery(reason), reason).toBe(true);
		}
		// Post-dispatch causes, caller bugs and dead panes are never retryable.
		for (const reason of [
			"lease-lost",
			"unacknowledged",
			"deadline-exceeded",
			"backend-failure",
			"owner-process-replaced",
			"invalid-input",
			"pane-absent",
			"pane-dead",
			"incarnation-changed",
			"duplicate-mismatch",
		] as const) {
			expect(isPaneInputRetryableAsNewDelivery(reason), reason).toBe(false);
		}
	});
});

describe("the canonical rendering is unambiguous", () => {
	it("is identical for programs that type the same thing, and differs on text, delay and incarnation", () => {
		expect(paneInputCanonicalProgram(program(submitStages("deploy", 800)))).toBe(
			paneInputCanonicalProgram(program(submitStages("deploy", 800), { deliveryId: "other" })),
		);
		const canonical = paneInputCanonicalProgram(program([{ steps: [{ kind: "text", text: "deploy" }] }]));
		expect(paneInputCanonicalProgram(program([{ steps: [{ kind: "text", text: "deploy " }] }]))).not.toBe(canonical);
		expect(paneInputCanonicalProgram(program(submitStages("x", 800)))).not.toBe(
			paneInputCanonicalProgram(program(submitStages("x", 900))),
		);
		expect(
			paneInputCanonicalProgram(
				program([{ steps: [{ kind: "text", text: "deploy" }] }], {
					incarnation: { ...NATIVE, host: { pid: 9999, startSignature: "host-sig" } },
				}),
			),
		).not.toBe(canonical);
	});

	it("cannot be confused by a moved step boundary, self-mimicking JSON, or escapes", () => {
		expect(paneInputCanonicalProgram(program([{ steps: [{ kind: "text", text: "ab" }] }]))).not.toBe(
			paneInputCanonicalProgram(program([{ steps: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }] }])),
		);
		expect(paneInputCanonicalProgram(program([{ steps: [{ kind: "text", text: '","key","enter",1]' }] }]))).not.toBe(
			paneInputCanonicalProgram(program([{ steps: [{ kind: "text", text: "x" }, { kind: "key", key: "enter" }] }])),
		);
		const variants = ['a"b', "a\\b", "a\nb", "a\\nb", "ab"].map((text) =>
			paneInputCanonicalProgram(program([{ steps: [{ kind: "text", text }] }])),
		);
		expect(new Set(variants).size).toBe(variants.length);
	});
});

describe("an incarnation is a structural identity", () => {
	it("separates incarnations that differ in any single field, start signature and server token included", () => {
		const successor: PaneIncarnation = { ...NATIVE, host: { pid: 4242, startSignature: "recycled" } };
		expect(samePaneIncarnation(NATIVE, successor)).toBe(false);
		expect(canonicalPaneIncarnation(NATIVE)).not.toBe(canonicalPaneIncarnation(successor));
		expect(samePaneIncarnation(TMUX, { ...TMUX, serverToken: "srv-token-2" })).toBe(false);

		expect(samePaneIncarnation(NATIVE, NATIVE)).toBe(true);
		expect(samePaneIncarnation(NATIVE, { ...NATIVE, sessionId: "other" })).toBe(false);
		expect(samePaneIncarnation(NATIVE, { ...NATIVE, paneId: "pane-3" })).toBe(false);
		expect(samePaneIncarnation(NATIVE, { ...NATIVE, shell: { pid: 1, startSignature: "shell-sig" } })).toBe(false);
		expect(samePaneIncarnation(NATIVE, TMUX)).toBe(false);
		expect(samePaneIncarnation(TMUX, { ...TMUX, sessionName: "dev3-task-other" })).toBe(false);
		// ...and names each in one readable line, per backend.
		expect(describePaneIncarnation(NATIVE)).toContain("host 4242/host-sig");
		expect(describePaneIncarnation(TMUX)).toContain("server srv-token-1");
	});

	// The ledger keys on this, so a successor pane is a NEW delivery slot rather than a
	// payload mismatch against its predecessor's id.
	it("keys the full incarnation without task/pane delimiter ambiguity", () => {
		expect(paneInputPaneKey(NATIVE)).not.toBe(
			paneInputPaneKey({ ...NATIVE, host: { pid: 4242, startSignature: "successor" } }),
		);
		expect(paneInputPaneKey(TMUX)).not.toBe(paneInputPaneKey({ ...TMUX, serverToken: "srv-token-2" }));
		expect(paneInputPaneKey({ ...NATIVE, taskId: "a:b", paneId: "c" })).not.toBe(
			paneInputPaneKey({ ...NATIVE, taskId: "a", paneId: "b:c" }),
		);
	});
});

describe("program accounting", () => {
	it("counts flattened steps (what acceptedThrough means), sums stage delays and defaults the deadline", () => {
		expect(paneInputStepCount(program(submitStages("x", 800)))).toBe(2);
		expect(paneInputStepCount(program([{ steps: [{ kind: "key", key: "left", count: 40 }] }]))).toBe(1);
		const p = program(submitStages("x", 700));
		expect(paneInputTotalDelayMs(p)).toBe(700);
		expect(paneInputDeadlineMs(p)).toBe(PANE_INPUT_LIMITS.defaultDeadlineMs);
		expect(paneInputDeadlineMs(program(submitStages("x", 700), { deadlineMs: 3_000 }))).toBe(3_000);
	});
});
