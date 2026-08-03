/**
 * Neutral vocabulary for pane input: the closed key set, the request, the verdicts and the
 * guards. Each backend owns its encoding. See `decisions/201-backend-neutral-pane-input.md`.
 */

/** Every control key the seam can express. One tuple; the union is derived from it. */
export const PANE_INPUT_KEYS = [
	"enter",
	"escape",
	"tab",
	"backspace",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"ctrl-c",
	"ctrl-d",
	"ctrl-l",
	"ctrl-u",
] as const;

export type PaneInputKey = (typeof PANE_INPUT_KEYS)[number];

const KEY_SET = new Set<string>(PANE_INPUT_KEYS);

export function isPaneInputKey(key: string): key is PaneInputKey {
	return KEY_SET.has(key);
}

/** One atomic step. Text is always literal; a key is always from the closed set. */
export type PaneInputStep =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "key"; readonly key: PaneInputKey; readonly count?: number };

/**
 * Steps that go in together, optionally after a wait. The wait is a gap, not a
 * readiness handshake, and it is executed by whoever performs the program.
 */
export interface PaneInputStage {
	readonly delayBeforeMs?: number;
	readonly steps: readonly PaneInputStep[];
}

/** A process this seam must be able to tell apart from its successor. */
export interface NativeProcessIdentity {
	readonly pid: number;
	/**
	 * The registry record's start signature. Required, because a pid alone is not an
	 * identity: the OS hands it to an unrelated successor.
	 */
	readonly startSignature: string;
}

/**
 * The exact pane a program is pinned to, discriminated so neither backend carries
 * the other's impossible fields. Every field must match before a write.
 * tmux identity rests on the server's own token; native identity is host plus shell.
 */
export type PaneIncarnation =
	| {
			readonly backend: "tmux";
			readonly taskId: string;
			readonly paneId: string;
			readonly sessionName: string;
			/** Random, minted once per tmux server lifetime and stored inside it. */
			readonly serverToken: string;
	  }
	| {
			readonly backend: "native";
			readonly taskId: string;
			readonly paneId: string;
			readonly sessionId: string;
			readonly host: NativeProcessIdentity;
			readonly shell: NativeProcessIdentity;
	  };

/** A whole delivery: the unit that is forwarded once and recorded by id. */
export interface PaneInputProgram {
	readonly deliveryId: string;
	readonly incarnation: PaneIncarnation;
	readonly stages: readonly PaneInputStage[];
	/** Whole-program budget, measured from the moment the executor admits it. */
	readonly deadlineMs?: number;
	/**
	 * Mandatory. 1 for a first dispatch; every intentional retransmission of the SAME
	 * id increments it. Above 1 it is a probe: it reports a retained record's outcome,
	 * or `owner-process-replaced` when none survives, and never executes.
	 */
	readonly attempt: number;
}

export const PANE_INPUT_LIMITS = {
	maxStages: 8,
	maxSteps: 32,
	maxKeyRepeat: 512,
	/**
	 * UTF-8 bytes of ONE coalesced stage, sized by the TIGHTER of two backend limits and
	 * rejected rather than split. tmux: text becomes space-separated hex in one argv
	 * element, 3 bytes out per byte in, against Linux MAX_ARG_STRLEN of 131 072 — so the
	 * ceiling is ~43 600. Native: the host frame is 64 KiB with the payload base64-encoded.
	 */
	maxStageBytes: 40_000,
	/** UTF-8 bytes of the whole program, so a retention window of records is cheap. */
	maxProgramBytes: 64_000,
	maxTotalDelayMs: 2_000,
	maxDeadlineMs: 8_000,
	defaultDeadlineMs: 5_000,
	/** Every identity string a record retains is bounded, so a record cannot grow. */
	maxIdentityLength: 256,
	/** Bound on a free-text detail, which is retained with the outcome. */
	maxDetailLength: 1_000,
} as const;

/**
 * Every reason, and which verdict each may appear on. One table is the source for the
 * `PaneInputReason` union, the runtime validator, and retryability, so a producer and a
 * decoder cannot drift apart.
 */
export type PaneInputStatus = "delivered" | "not-started" | "partial" | "indeterminate";

export const PANE_INPUT_REASON_SCHEMA = {
	"pane-absent": { on: ["not-started"], retryable: false },
	"pane-dead": { on: ["not-started", "partial"], retryable: false },
	"incarnation-changed": { on: ["not-started", "partial"], retryable: false },
	"owner-unknown": { on: ["not-started"], retryable: true },
	"owner-unreachable": { on: ["not-started", "indeterminate"], retryable: true },
	"read-only": { on: ["not-started"], retryable: true },
	"executor-saturated": { on: ["not-started"], retryable: true },
	"invalid-input": { on: ["not-started"], retryable: false },
	"duplicate-mismatch": { on: ["not-started"], retryable: false },
	"deadline-exceeded": { on: ["not-started", "partial", "indeterminate"], retryable: false },
	"backend-failure": { on: ["not-started", "partial", "indeterminate"], retryable: false },
	"lease-lost": { on: ["indeterminate"], retryable: false },
	unacknowledged: { on: ["indeterminate"], retryable: false },
	"owner-process-replaced": { on: ["indeterminate"], retryable: false },
} as const satisfies Record<string, { readonly on: readonly PaneInputStatus[]; readonly retryable: boolean }>;

export type PaneInputReason = keyof typeof PANE_INPUT_REASON_SCHEMA;

export function isPaneInputReason(reason: unknown): reason is PaneInputReason {
	return typeof reason === "string" && Object.prototype.hasOwnProperty.call(PANE_INPUT_REASON_SCHEMA, reason);
}

/** Whether `reason` is legal on `status`. */
export function isPaneInputReasonLegalOn(reason: PaneInputReason, status: PaneInputStatus): boolean {
	return (PANE_INPUT_REASON_SCHEMA[reason].on as readonly string[]).includes(status);
}

/**
 * Whether the caller may try again — as a NEW delivery id, the only retry this seam
 * supports. Derived from the schema, so it cannot disagree with legality.
 */
export function isPaneInputRetryableAsNewDelivery(reason: PaneInputReason): boolean {
	return PANE_INPUT_REASON_SCHEMA[reason].retryable;
}

/** The fields each verdict carries beyond the shared base. Nothing else is allowed. */
export const PANE_INPUT_OUTCOME_FIELDS = {
	delivered: ["acceptedThrough"],
	"not-started": ["reason", "retryableAsNewDelivery", "detail"],
	partial: ["acceptedThrough", "uncertainStep", "reason", "detail"],
	indeterminate: ["possiblyAcceptedThrough", "reason", "detail"],
} as const satisfies Record<PaneInputStatus, readonly string[]>;

export const PANE_INPUT_OUTCOME_BASE_FIELDS = ["deliveryId", "backend", "paneId", "status", "executor"] as const;

interface PaneInputOutcomeBase {
	readonly deliveryId: string;
	readonly backend: PaneIncarnation["backend"];
	readonly paneId: string;
	/**
	 * Which process incarnation produced this verdict. A caller that probes and gets
	 * a different executor knows its delivery's record is gone.
	 */
	readonly executor?: string;
}

/**
 * Four verdicts. `acceptedThrough` / `possiblyAcceptedThrough` count FLATTENED
 * steps, so they compare directly with {@link paneInputStepCount}.
 */
export type PaneInputOutcome =
	/**
	 * The backend ACCEPTED every stage. On tmux that means the server took the keys for the
	 * pinned PANE — not that the program a caller had in mind read them. An agent that
	 * exited leaves its shell reading the same pane, so text plus Enter is then executed by
	 * that shell and still reported here as delivered.
	 */
	| (PaneInputOutcomeBase & { readonly status: "delivered"; readonly acceptedThrough: number })
	| (PaneInputOutcomeBase & {
			readonly status: "not-started";
			readonly reason: PaneInputReason;
			/** True only when a NEW delivery id may carry the same input again. */
			readonly retryableAsNewDelivery: boolean;
			readonly detail?: string;
	  })
	| (PaneInputOutcomeBase & {
			readonly status: "partial";
			readonly acceptedThrough: number;
			/** The step whose fate is unknown, or null when the stop was clean. */
			readonly uncertainStep: number | null;
			readonly reason: PaneInputReason;
			readonly detail?: string;
	  })
	| (PaneInputOutcomeBase & {
			readonly status: "indeterminate";
			readonly possiblyAcceptedThrough: number;
			readonly reason: PaneInputReason;
			readonly detail?: string;
	  });

/**
 * Pinning a pane either succeeds or fails for a NAMED reason: an absent pane, a dead
 * one, and a backend that could not answer are three different things.
 */
export type PaneInputPin =
	| { readonly ok: true; readonly incarnation: PaneIncarnation }
	| { readonly ok: false; readonly reason: "pane-absent" | "pane-dead" | "backend-failure"; readonly detail: string };

export function paneInputStepCount(program: PaneInputProgram): number {
	return program.stages.reduce((total, stage) => total + stage.steps.length, 0);
}

export function paneInputTotalDelayMs(program: PaneInputProgram): number {
	return program.stages.reduce((total, stage) => total + (stage.delayBeforeMs ?? 0), 0);
}

export function paneInputDeadlineMs(program: PaneInputProgram): number {
	return program.deadlineMs ?? PANE_INPUT_LIMITS.defaultDeadlineMs;
}

/**
 * The canonical rendering of a pinned incarnation — the single place its fields are
 * serialised, so nothing duplicates the host/shell signature layout. Canonical JSON,
 * because any delimiter can appear inside a session name.
 */
export function canonicalPaneIncarnation(incarnation: PaneIncarnation): string {
	return incarnation.backend === "tmux"
		? JSON.stringify(["tmux", incarnation.taskId, incarnation.paneId, incarnation.sessionName, incarnation.serverToken])
		: JSON.stringify([
				"native",
				incarnation.taskId,
				incarnation.paneId,
				incarnation.sessionId,
				incarnation.host.pid,
				incarnation.host.startSignature,
				incarnation.shell.pid,
				incarnation.shell.startSignature,
			]);
}

/**
 * The key programs are serialized and recorded under: the FULL pinned incarnation,
 * not just the pane id. A successor pane is a different key, so reusing a delivery id
 * against it is a new delivery rather than a payload mismatch.
 */
export function paneInputPaneKey(incarnation: PaneIncarnation): string {
	return canonicalPaneIncarnation(incarnation);
}

/** Whether two incarnations name the same pane in the same process lifetime. */
export function samePaneIncarnation(a: PaneIncarnation, b: PaneIncarnation): boolean {
	return canonicalPaneIncarnation(a) === canonicalPaneIncarnation(b);
}

/** One line naming an incarnation, for a verdict's detail. */
export function describePaneIncarnation(incarnation: PaneIncarnation): string {
	return incarnation.backend === "tmux"
		? `tmux ${incarnation.sessionName}@server ${incarnation.serverToken} pane ${incarnation.paneId}`
		: `native ${incarnation.sessionId} host ${incarnation.host.pid}/${incarnation.host.startSignature} shell ${incarnation.shell.pid}/${incarnation.shell.startSignature}`;
}

/** UTF-8 byte length, the unit both backends actually move. */
export function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Canonical JSON rendering of a program's pinned pane and payload. The executor
 * stores this and compares a probe byte for byte, so no hash and no caller digest is
 * involved. JSON rather than a joined string, because any delimiter can appear in text.
 */
export function paneInputCanonicalProgram(program: PaneInputProgram): string {
	return JSON.stringify({
		incarnation: canonicalPaneIncarnation(program.incarnation),
		stages: program.stages.map((stage) => ({
			delayBeforeMs: stage.delayBeforeMs ?? 0,
			steps: stage.steps.map((step) =>
				step.kind === "text" ? ["text", step.text] : ["key", step.key, step.count ?? 1],
			),
		})),
	});
}

/** A bounded, non-empty string — every identity a record retains must be one. */
function isIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= PANE_INPUT_LIMITS.maxIdentityLength;
}

function validateIncarnation(inc: PaneIncarnation): string | null {
	if (!inc || typeof inc !== "object" || Array.isArray(inc)) return "missing incarnation";
	// Exact primitive types, no objects and no coercion: this is checked before the
	// executor admits anything, so malformed input consumes no record.
	if (!isIdentity(inc.taskId)) return "incarnation taskId must be a bounded string";
	if (!isIdentity(inc.paneId)) return "incarnation paneId must be a bounded string";
	if (inc.backend === "tmux") {
		if (!isIdentity(inc.sessionName)) return "a tmux incarnation must pin the session name";
		// The forms the tmux adapter can actually put in a command, rejected here rather
		// than deeper down.
		if (!/^[A-Za-z0-9_.-]+$/.test(inc.sessionName)) return `unusable tmux session name "${inc.sessionName}"`;
		if (!/^%\d+$/.test(inc.paneId)) return `unusable tmux pane id "${inc.paneId}"`;
		// A restarted server mints the same pane ids again, so without its pid the
		// pane id names nothing in particular.
		if (!isIdentity(inc.serverToken) || !/^[A-Za-z0-9-]+$/.test(inc.serverToken)) {
			return "a tmux incarnation must pin the tmux server token";
		}
		return null;
	}
	if (inc.backend === "native") {
		if (!isIdentity(inc.sessionId)) return "a native incarnation must pin the registry session id";
		for (const [role, identity] of [
			["host", inc.host],
			["shell", inc.shell],
		] as const) {
			if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) {
				return `a native incarnation must pin the ${role} pid`;
			}
			if (!isIdentity(identity.startSignature)) {
				return `a native incarnation must pin the ${role} start signature`;
			}
		}
		return null;
	}
	return `unknown backend "${String((inc as { backend?: unknown }).backend)}"`;
}

/**
 * An owned, frozen copy of a caller's steps — or a rejection. It PRESERVES raw values
 * instead of coercing them, so an unknown step kind stays unknown and is refused rather
 * than silently becoming a key press.
 */
export type PaneInputDecoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

function decodeStep(raw: unknown): PaneInputDecoded<PaneInputStep> {
	if (!raw || typeof raw !== "object") return { ok: false, detail: "a step must be an object" };
	const step = raw as { kind?: unknown; text?: unknown; key?: unknown; count?: unknown };
	if (step.kind === "text") {
		if (typeof step.text !== "string") return { ok: false, detail: "a text step needs a string text" };
		return { ok: true, value: Object.freeze({ kind: "text", text: step.text }) };
	}
	if (step.kind === "key") {
		if (typeof step.key !== "string") return { ok: false, detail: "a key step needs a string key" };
		if (step.count !== undefined && typeof step.count !== "number") {
			return { ok: false, detail: "a key step's count must be a number" };
		}
		return {
			ok: true,
			value: Object.freeze({
				kind: "key",
				key: step.key as PaneInputKey,
				...(step.count === undefined ? {} : { count: step.count }),
			}),
		};
	}
	return { ok: false, detail: `unknown step kind "${String(step.kind)}"` };
}

function decodeStage(raw: unknown): PaneInputDecoded<PaneInputStage> {
	if (!raw || typeof raw !== "object") return { ok: false, detail: "a stage must be an object" };
	const stage = raw as { delayBeforeMs?: unknown; steps?: unknown };
	if (stage.delayBeforeMs !== undefined && typeof stage.delayBeforeMs !== "number") {
		return { ok: false, detail: "a stage's delayBeforeMs must be a number" };
	}
	if (!Array.isArray(stage.steps)) return { ok: false, detail: "a stage needs a steps array" };
	const steps: PaneInputStep[] = [];
	for (const rawStep of stage.steps) {
		const decoded = decodeStep(rawStep);
		if (!decoded.ok) return decoded;
		steps.push(decoded.value);
	}
	return {
		ok: true,
		value: Object.freeze({
			...(stage.delayBeforeMs === undefined ? {} : { delayBeforeMs: stage.delayBeforeMs }),
			steps: Object.freeze(steps) as readonly PaneInputStep[],
		}),
	};
}

/** Own a caller's stages before anything awaits, preserving every raw value. */
export function decodePaneInputStages(raw: unknown): PaneInputDecoded<readonly PaneInputStage[]> {
	if (!Array.isArray(raw)) return { ok: false, detail: "stages must be an array" };
	const stages: PaneInputStage[] = [];
	for (const rawStage of raw) {
		const decoded = decodeStage(rawStage);
		if (!decoded.ok) return decoded;
		stages.push(decoded.value);
	}
	return { ok: true, value: Object.freeze(stages) as readonly PaneInputStage[] };
}

function decodeIncarnation(raw: unknown): PaneInputDecoded<PaneIncarnation> {
	if (!raw || typeof raw !== "object") return { ok: false, detail: "an incarnation must be an object" };
	const inc = raw as Record<string, unknown>;
	// Discriminants and identity fields are kept EXACTLY as given: coercing them here
	// would turn an invalid request into a valid one behind validation's back.
	if (inc.backend === "tmux") {
		return {
			ok: true,
			value: Object.freeze({
				backend: "tmux",
				taskId: inc.taskId,
				paneId: inc.paneId,
				sessionName: inc.sessionName,
				serverToken: inc.serverToken,
			}) as PaneIncarnation,
		};
	}
	if (inc.backend === "native") {
		const identity = (value: unknown): unknown => {
			if (!value || typeof value !== "object") return value;
			const id = value as { pid?: unknown; startSignature?: unknown };
			return Object.freeze({ pid: id.pid, startSignature: id.startSignature });
		};
		return {
			ok: true,
			value: Object.freeze({
				backend: "native",
				taskId: inc.taskId,
				paneId: inc.paneId,
				sessionId: inc.sessionId,
				host: identity(inc.host),
				shell: identity(inc.shell),
			}) as PaneIncarnation,
		};
	}
	return { ok: false, detail: `unknown backend "${String(inc.backend)}"` };
}

/**
 * An owned, frozen copy of a whole request, or a rejection. Every value is preserved as
 * given so {@link validatePaneInputProgram} sees what the caller actually sent.
 */
export function decodePaneInputProgram(raw: unknown): PaneInputDecoded<PaneInputProgram> {
	if (!raw || typeof raw !== "object") return { ok: false, detail: "a program must be an object" };
	const program = raw as Record<string, unknown>;
	const incarnation = decodeIncarnation(program.incarnation);
	if (!incarnation.ok) return incarnation;
	const stages = decodePaneInputStages(program.stages);
	if (!stages.ok) return stages;
	if (program.deadlineMs !== undefined && typeof program.deadlineMs !== "number") {
		return { ok: false, detail: "deadlineMs must be a number" };
	}
	return {
		ok: true,
		value: Object.freeze({
			deliveryId: program.deliveryId,
			attempt: program.attempt,
			incarnation: incarnation.value,
			stages: stages.value,
			...(program.deadlineMs === undefined ? {} : { deadlineMs: program.deadlineMs }),
		}) as PaneInputProgram,
	};
}

/** The rejection reason for `program`, or null when it is well-formed. */
export function validatePaneInputProgram(program: PaneInputProgram): string | null {
	if (!program || typeof program !== "object") return "no program";
	if (!isIdentity(program.deliveryId)) return "deliveryId must be a bounded string";
	if (!Number.isInteger(program.attempt) || program.attempt < 1) return `invalid attempt (${String(program.attempt)})`;

	const badIncarnation = validateIncarnation(program.incarnation);
	if (badIncarnation) return badIncarnation;

	if (!Array.isArray(program.stages) || program.stages.length === 0) return "no stages";
	if (program.stages.length > PANE_INPUT_LIMITS.maxStages) {
		return `too many stages (${program.stages.length} > ${PANE_INPUT_LIMITS.maxStages})`;
	}
	let steps = 0;
	for (const stage of program.stages) {
		if (!stage || !Array.isArray(stage.steps) || stage.steps.length === 0) return "stage without steps";
		const delay = stage.delayBeforeMs ?? 0;
		if (!Number.isInteger(delay) || delay < 0) return `invalid stage delay (${String(stage.delayBeforeMs)})`;
		steps += stage.steps.length;
		for (const step of stage.steps) {
			const bad = validateStep(step);
			if (bad) return bad;
		}
	}
	if (steps > PANE_INPUT_LIMITS.maxSteps) return `too many steps (${steps} > ${PANE_INPUT_LIMITS.maxSteps})`;

	const totalDelay = paneInputTotalDelayMs(program);
	if (totalDelay > PANE_INPUT_LIMITS.maxTotalDelayMs) {
		return `total delay too long (${totalDelay} > ${PANE_INPUT_LIMITS.maxTotalDelayMs}ms)`;
	}
	if (program.deadlineMs !== undefined && typeof program.deadlineMs !== "number") return "deadlineMs must be a number";
	const deadline = paneInputDeadlineMs(program);
	if (!Number.isInteger(deadline) || deadline <= 0 || deadline > PANE_INPUT_LIMITS.maxDeadlineMs) {
		return `deadline out of range (${deadline})`;
	}
	if (deadline <= totalDelay) return `deadline ${deadline}ms cannot cover ${totalDelay}ms of delays`;
	return null;
}

function validateStep(step: PaneInputStep): string | null {
	switch (step?.kind) {
		case "text":
			if (typeof step.text !== "string") return "text step without text";
			if (step.text.length === 0) return "empty text step";
			// NUL cannot cross a process argv, so no backend can carry it honestly. A
			// caller that means the byte can ask for it as a key once one exists.
			if (step.text.includes("\u0000")) return "text step contains U+0000, which no backend can carry";
			return null;
		case "key": {
			if (!isPaneInputKey(step.key)) return `unknown key "${String(step.key)}"`;
			const count = step.count ?? 1;
			if (!Number.isInteger(count) || count < 1 || count > PANE_INPUT_LIMITS.maxKeyRepeat) {
				return `key repeat out of range (${String(step.count)})`;
			}
			return null;
		}
		default:
			return `unknown step kind "${String((step as { kind?: unknown })?.kind)}"`;
	}
}

/**
 * The size guard, in the units a backend actually moves: one coalesced stage against
 * {@link PANE_INPUT_LIMITS.maxStageBytes} and the whole program against
 * `maxProgramBytes`. The adapter supplies its own encoding; run it before admission.
 */
export function validatePaneInputSize(
	program: PaneInputProgram,
	stepBytes: (step: PaneInputStep) => string,
): string | null {
	let programBytes = 0;
	for (const [index, stage] of program.stages.entries()) {
		const stageBytes = utf8Length(stage.steps.map(stepBytes).join(""));
		if (stageBytes > PANE_INPUT_LIMITS.maxStageBytes) {
			return `stage ${index + 1} is ${stageBytes} bytes, over the ${PANE_INPUT_LIMITS.maxStageBytes}-byte single-operation limit`;
		}
		programBytes += stageBytes;
	}
	if (programBytes > PANE_INPUT_LIMITS.maxProgramBytes) {
		return `program is ${programBytes} bytes, over the ${PANE_INPUT_LIMITS.maxProgramBytes}-byte limit`;
	}
	return null;
}
