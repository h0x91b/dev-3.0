/**
 * The native adapter: the only place neutral keys become PTY bytes and the only place the
 * writer lease is consulted. It never claims a lease, never attaches a client, and never
 * reports `delivered`. See `decisions/2026/08/06/backend-neutral-pane-input.md`.
 */

import type { Task } from "../shared/types";
import {
	PANE_INPUT_LIMITS,
	PANE_INPUT_OUTCOME_BASE_FIELDS,
	PANE_INPUT_OUTCOME_FIELDS,
	describePaneIncarnation,
	isPaneInputReason,
	isPaneInputReasonLegalOn,
	isPaneInputRetryableAsNewDelivery,
	paneInputStepCount,
	samePaneIncarnation,
	decodePaneInputProgram,
	validatePaneInputProgram,
	validatePaneInputSize,
	type PaneIncarnation,
	type PaneInputKey,
	type PaneInputPin,
	type PaneInputOutcome,
	type PaneInputProgram,
	type PaneInputReason,
	type PaneInputStep,
} from "../shared/pane-input";
import { createLogger } from "./logger";
import { forwardToOwner, isForwardToOwnerError, resolvePaneOwner } from "./native-pane-owner";
import type { NativeTaskTerminal } from "./native-task-terminal";
import { inspectNativeTaskPane } from "./native-task-panes";

import { nativePaneTerminal } from "./pty-server";
import { inspectNativePaneIdentity, type RecordProblem } from "./native-pane-identity";
import { monotonicNowMs, runPaneInputProgramOnce, type PaneInputExecution } from "./pane-input-ledger";

const log = createLogger("pane-input-native");

/**
 * Internal CLI-socket method that performs one program inside the app process holding
 * the pane's writer lease. Owner-side only: {@link runNativePaneInputAsOwner} resolves
 * no owner and forwards nothing, so a program cannot bounce between two processes.
 */
export const NATIVE_PANE_INPUT_METHOD = "_native.runPaneInputProgram";

/** Neutral key → PTY bytes. Must cover every {@link PaneInputKey}. */
const PANE_INPUT_KEY_BYTES: Readonly<Record<PaneInputKey, string>> = {
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	backspace: "\x7f",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	// Same CSI base as the renderer's shift map, so a pane sees one encoding whoever
	// typed into it (see src/mainview/shift-key-sequences.ts).
	home: "\x1b[H",
	end: "\x1b[F",
	"ctrl-c": "\x03",
	"ctrl-d": "\x04",
	"ctrl-l": "\x0c",
	"ctrl-u": "\x15",
};

function nativeStepBytes(step: PaneInputStep): string {
	return step.kind === "text" ? step.text : PANE_INPUT_KEY_BYTES[step.key].repeat(step.count ?? 1);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The pane's live incarnation, from OBSERVATION only: nothing is started, stopped or
 * reconciled while pinning. Absent, proven dead and unprovable stay three answers.
 */
export async function resolveNativePaneIncarnation(task: Task, paneId: string): Promise<PaneInputPin> {
	const seen = await inspectNativeTaskPane(task.id, paneId);
	switch (seen.kind) {
		case "coordinator-absent":
			return { ok: false, reason: "pane-absent", detail: `task ${task.id.slice(0, 8)} has no native pane set` };
		case "pane-absent":
			return { ok: false, reason: "pane-absent", detail: `no pane ${paneId} in this task's pane set` };
		case "coordinator-unreadable":
			// Cannot prove anything about the pane, which is never the same as absence.
			return { ok: false, reason: "backend-failure", detail: seen.detail };
		case "session-problem":
			return sessionProblemPin(seen.sessionId, seen.problem);
		case "foreign-record":
			// A record naming another session proves nothing about THIS pane.
			return {
				ok: false,
				reason: "backend-failure",
				detail: `pane ${paneId} holds a record for ${seen.recordSessionId}, not ${seen.sessionId}`,
			};
		case "observed":
			if (seen.ownership === "dead") {
				return { ok: false, reason: "pane-dead", detail: `a process of ${seen.sessionId} is gone` };
			}
			if (seen.ownership === "reused") {
				// A live pid whose identity no longer matches is not this pane's process.
				return {
					ok: false,
					reason: "backend-failure",
					detail: `${seen.sessionId} no longer owns its recorded processes`,
				};
			}
			// No start signature means this seam cannot express the incarnation, and the
			// pane is neither dead nor the caller's mistake. On win32 that is by design
			// (ownership is a Job Object); anywhere else the record is simply missing it.
			if (!seen.host.startSignature || !seen.shell.startSignature) {
				const why =
					process.platform === "win32"
						? "on win32 ownership evidence is a job object, not a process start signature"
						: "its record carries no process start signature";
				return { ok: false, reason: "backend-failure", detail: `pane input cannot pin ${seen.sessionId}: ${why}` };
			}
			return {
				ok: true,
				incarnation: {
					backend: "native",
					taskId: task.id,
					paneId,
					sessionId: seen.sessionId,
					host: seen.host,
					shell: seen.shell,
				},
			};
	}
}

/**
 * A session record that could not be accepted. Only a record that is GONE proves death;
 * corrupt, foreign or unreadable proves nothing, so it stays a backend failure.
 */
function sessionProblemPin(sessionId: string, problem: RecordProblem): Extract<PaneInputPin, { ok: false }> {
	switch (problem.kind) {
		case "absent":
			return { ok: false, reason: "pane-absent", detail: `session ${sessionId} no longer exists` };
		case "missing":
			// The directory outlived its record: the pane was there and its session is gone.
			return { ok: false, reason: "pane-dead", detail: `session ${sessionId} lost its record` };
		case "unreadable-file":
			return { ok: false, reason: "backend-failure", detail: `session ${sessionId} could not be read: ${problem.message}` };
		case "invalid-json":
			return { ok: false, reason: "backend-failure", detail: `session ${sessionId} has a corrupt record` };
		case "foreign-schema":
			return {
				ok: false,
				reason: "backend-failure",
				detail: `session ${sessionId} was written by another dev3 version (schema ${String(problem.schemaVersion)})`,
			};
		case "invalid-fields":
			return { ok: false, reason: "backend-failure", detail: `session ${sessionId} has an unusable record` };
	}
}

interface Verdicts {
	/** Nothing was dispatched, and that is PROVEN. The only place retryability lives. */
	notStarted(reason: PaneInputReason, detail: string): PaneInputOutcome;
	/** Bytes may have landed. `possiblyAccepted` is the honest upper bound. */
	unsure(possiblyAccepted: number, reason: PaneInputReason, detail: string): PaneInputOutcome;
}

function verdicts(program: PaneInputProgram): Verdicts {
	const base = { deliveryId: program.deliveryId, backend: "native" as const, paneId: program.incarnation.paneId };
	return {
		notStarted: (reason, detail) => ({
			...base,
			status: "not-started",
			reason,
			retryableAsNewDelivery: isPaneInputRetryableAsNewDelivery(reason),
			detail,
		}),
		unsure: (possiblyAcceptedThrough, reason, detail) => ({
			...base,
			status: "indeterminate",
			possiblyAcceptedThrough,
			reason,
			detail,
		}),
	};
}

/**
 * Whether the pane is still the pinned incarnation, the WRITE TARGET is that same
 * incarnation, and it is still ours to write. A PRE-DISPATCH guard, never evidence that
 * a write succeeded.
 */
function checkWritable(
	terminal: NativeTaskTerminal,
	pinned: PaneIncarnation,
): { ok: true } | { ok: false; reason: PaneInputReason; detail: string } {
	if (pinned.backend !== "native") {
		return { ok: false, reason: "invalid-input", detail: "a native write needs a native incarnation" };
	}
	const inspected = inspectNativePaneIdentity(terminal.sessionId);
	if (!inspected.ok) {
		// The SAME taxonomy the pin uses, two lines apart: only a record that is gone proves
		// death. A transient EACCES or a newer build's schema proves nothing.
		const pin = sessionProblemPin(terminal.sessionId, inspected.problem);
		return { ok: false, reason: pin.reason, detail: pin.detail };
	}
	const identity = inspected.identity;
	const live: PaneIncarnation = {
		backend: "native",
		taskId: pinned.taskId,
		paneId: pinned.paneId,
		sessionId: identity.sessionId,
		host: identity.host,
		shell: identity.shell,
	};
	if (!samePaneIncarnation(pinned, live)) {
		return {
			ok: false,
			reason: "incarnation-changed",
			detail: `pinned ${describePaneIncarnation(pinned)}, live ${describePaneIncarnation(live)}`,
		};
	}

	// The binding the bytes would travel through must BE that incarnation, judged on what
	// it captured at bind time rather than on pids it could share with a successor.
	const bound = terminal.boundIdentity;
	if (!bound) {
		return {
			ok: false,
			reason: "incarnation-changed",
			detail: "the write target captured no registry-proved identity when it was bound",
		};
	}
	const boundAs: PaneIncarnation = {
		backend: "native",
		taskId: pinned.taskId,
		paneId: pinned.paneId,
		sessionId: bound.sessionId,
		host: bound.host,
		shell: bound.shell,
	};
	if (!samePaneIncarnation(pinned, boundAs)) {
		return {
			ok: false,
			reason: "incarnation-changed",
			detail: `the write target is a stale binding: it was bound to ${describePaneIncarnation(boundAs)}`,
		};
	}
	if (terminal.hostRole() !== "writer") {
		return { ok: false, reason: "read-only", detail: "this process does not hold the pane's writer lease" };
	}
	return { ok: true };
}

/**
 * Write the program's stages, one coalesced `write` per stage, guarded before each
 * stage and never after: nothing here can confirm a write, so the first dispatched
 * byte turns the whole verdict indeterminate.
 */
async function writeProgram(
	terminal: NativeTaskTerminal,
	program: PaneInputProgram,
	execution: PaneInputExecution,
): Promise<PaneInputOutcome> {
	const v = verdicts(program);
	let dispatched = 0;
	const overBudget = (where: string): PaneInputOutcome =>
		dispatched === 0
			? v.notStarted("deadline-exceeded", `the program's budget ran out ${where}`)
			: v.unsure(dispatched, "deadline-exceeded", `the program's budget ran out ${where}`);

	for (const stage of program.stages) {
		const delay = stage.delayBeforeMs ?? 0;
		if (delay > 0) {
			if (monotonicNowMs() + delay > execution.deadlineAtMs) return overBudget("before a stage delay");
			await sleep(delay);
		}
		if (execution.signal.aborted) {
			return dispatched === 0
				? v.notStarted("deadline-exceeded", "the program was aborted before its first stage")
				: v.unsure(dispatched, "deadline-exceeded", "the program was aborted mid-program");
		}
		const writable = checkWritable(terminal, program.incarnation);
		if (!writable.ok) {
			return dispatched === 0
				? v.notStarted(writable.reason, writable.detail)
				: v.unsure(dispatched, "lease-lost", `${writable.detail} — the stages already written cannot be confirmed`);
		}
		if (monotonicNowMs() > execution.deadlineAtMs) return overBudget("before a stage");

		try {
			terminal.write(stage.steps.map(nativeStepBytes).join(""));
		} catch (err) {
			// Bytes may be partly on the socket; no byte boundary is knowable.
			return v.unsure(dispatched + stage.steps.length, "backend-failure", `writing a stage failed: ${String(err)}`);
		}
		dispatched += stage.steps.length;
		execution.progress(dispatched);
	}
	return v.unsure(dispatched, "unacknowledged", "every stage was written to the host, which cannot acknowledge input yet");
}

function rejectProgram(program: PaneInputProgram, detail: string): PaneInputOutcome {
	return {
		deliveryId: program?.deliveryId ?? "",
		backend: "native",
		paneId: program?.incarnation?.paneId ?? "",
		status: "not-started",
		reason: "invalid-input",
		retryableAsNewDelivery: false,
		detail,
	};
}

/**
 * Perform a program in THIS process, which must hold the writer lease. The owner-side
 * half of the forwarding hop, and deliberately a dead end.
 */
export async function runNativePaneInputAsOwner(request: PaneInputProgram): Promise<PaneInputOutcome> {
	// Own it, then validate and size-bound it BEFORE the ledger admits it: the sender's
	// validation is not evidence about what this process received.
	const decoded = decodePaneInputProgram(request);
	if (!decoded.ok) return rejectProgram(request, decoded.detail);
	const program = decoded.value;
	const invalid = validatePaneInputProgram(program) ?? validatePaneInputSize(program, nativeStepBytes);
	if (invalid) return rejectProgram(program, invalid);

	return runPaneInputProgramOnce(program, async (execution) => {
		const v = verdicts(program);
		const terminal = nativePaneTerminal(program.incarnation.taskId, program.incarnation.paneId);
		if (!terminal) return v.notStarted("pane-dead", "no binding for this pane in the owning process");

		// No claim here: only the resolving sender may take a vacant lease.
		const writable = checkWritable(terminal, program.incarnation);
		if (!writable.ok) {
			log.warn("Owner-routed pane input arrived without a writable pane", {
				taskId: program.incarnation.taskId.slice(0, 8),
				paneId: program.incarnation.paneId,
				reason: writable.reason,
			});
			return v.notStarted(writable.reason, writable.detail);
		}
		return writeProgram(terminal, program, execution);
	});
}

/**
 * Strictly validate a peer owner's outcome against the shared schema. A reply that does
 * not describe THIS delivery, carries a field its verdict lacks, pairs a reason with an
 * illegal verdict, or contradicts canonical retryability is refused as uncertainty.
 */
function validateOwnerOutcome(program: PaneInputProgram, outcome: unknown): PaneInputOutcome | string {
	if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return "the owner sent no usable outcome";
	const o = outcome as Record<string, unknown>;
	if (o.deliveryId !== program.deliveryId) return `the owner answered for delivery ${String(o.deliveryId)}`;
	if (o.backend !== "native") return `the owner answered for the ${String(o.backend)} backend`;
	if (o.paneId !== program.incarnation.paneId) return `the owner answered for pane ${String(o.paneId)}`;
	if (typeof o.executor !== "string" || o.executor.length === 0 || o.executor.length > PANE_INPUT_LIMITS.maxIdentityLength) {
		return "the owner did not identify itself within bounds";
	}
	if (o.detail !== undefined && (typeof o.detail !== "string" || o.detail.length > PANE_INPUT_LIMITS.maxDetailLength)) {
		return "the owner's detail is not a bounded string";
	}

	const status = o.status;
	if (status === "delivered") return "the owner claimed a delivered native program, which no host can acknowledge yet";
	if (status === "partial") return "the owner claimed a partial native program, which no host can acknowledge yet";
	if (status !== "not-started" && status !== "indeterminate") return `the owner sent an unknown status ${String(status)}`;

	// Exactly the fields this verdict has, and nothing else.
	const allowed = new Set<string>([...PANE_INPUT_OUTCOME_BASE_FIELDS, ...PANE_INPUT_OUTCOME_FIELDS[status]]);
	for (const field of Object.keys(o)) {
		if (!allowed.has(field)) return `the owner's ${status} reply carries an unexpected field ${field}`;
	}

	if (!isPaneInputReason(o.reason)) return `the owner sent an unknown reason ${String(o.reason)}`;
	if (!isPaneInputReasonLegalOn(o.reason, status)) return `${o.reason} is not a legal ${status} reason`;

	const total = paneInputStepCount(program);
	const bounded = (value: unknown): boolean =>
		Number.isInteger(value) && (value as number) >= 0 && (value as number) <= total;

	if (status === "not-started") {
		if (o.retryableAsNewDelivery !== isPaneInputRetryableAsNewDelivery(o.reason)) {
			return `the owner's retry verdict contradicts ${o.reason}`;
		}
	} else if (!bounded(o.possiblyAcceptedThrough)) {
		return `the owner's possiblyAcceptedThrough ${String(o.possiblyAcceptedThrough)} is out of range`;
	}
	return outcome as PaneInputOutcome;
}

/**
 * Send `program` to its native pane, wherever the writer lease lives. The owner is
 * resolved ONCE, the program is forwarded whole at most once, and a failure after
 * dispatch is never retried here.
 */
export async function deliverNativePaneInput(task: Task, program: PaneInputProgram): Promise<PaneInputOutcome> {
	const oversized = validatePaneInputSize(program, nativeStepBytes);
	if (oversized) return rejectProgram(program, oversized);

	const v = verdicts(program);
	const paneId = program.incarnation.paneId;

	// Never ATTACH here. Attaching a client can make this process the writer — the host
	// grants the lease to the first client and an attach may claim a vacant slot — and
	// input arriving out of sight must not change who owns the keyboard.
	const terminal = nativePaneTerminal(task.id, paneId);
	if (!terminal) {
		return v.notStarted("read-only", "this process holds no binding to the pane, and pane input never attaches one");
	}

	const owner = await resolvePaneOwner(terminal);
	const context = { taskId: task.id.slice(0, 8), paneId, owner: owner.kind };

	switch (owner.kind) {
		case "local":
			return runPaneInputProgramOnce(program, async (execution) => {
				const writable = checkWritable(terminal, program.incarnation);
				if (!writable.ok) return v.notStarted(writable.reason, writable.detail);
				return writeProgram(terminal, program, execution);
			});

		case "vacant":
			// Input arriving out of sight must never MUTATE writer ownership: taking a vacant
			// lease would hand the keyboard to whoever typed last. Explicit Take control owns
			// every lease change.
			log.info("Pane has no writer; pane input does not claim one", context);
			return v.notStarted("read-only", "no process holds this pane's writer lease, and pane input never claims it");

		case "peer": {
			// Forward the WHOLE program, never the bytes, and never write locally too. The
			// owner records the delivery id, so a probe reports the original's fate.
			try {
				const reply = await forwardToOwner<unknown>(
					owner,
					NATIVE_PANE_INPUT_METHOD,
					program as unknown as Record<string, unknown>,
				);
				const validated = validateOwnerOutcome(program, reply);
				if (typeof validated !== "string") {
					log.info("Pane input program routed to the owning app process", { ...context, ownerPid: owner.pid });
					return validated;
				}
				log.warn("Rejecting an unusable outcome from the owning app process", {
					...context,
					ownerPid: owner.pid,
					detail: validated,
				});
				// The request went out, so its fate is unknown whatever the reply said.
				return v.unsure(paneInputStepCount(program), "owner-unreachable", validated);
			} catch (err) {
				log.warn("Forwarding pane input to the owning app process failed", {
					...context,
					ownerPid: owner.pid,
					phase: isForwardToOwnerError(err) ? err.phase : "unknown",
					error: String(err),
				});
				const detail = `forwarding to owner ${owner.pid} failed: ${String(err)}`;
				// Only a failure proven to precede dispatch may be reported as "nothing
				// happened"; once the framed request was accepted by the peer socket the
				// owner may have performed all of it.
				if (isForwardToOwnerError(err) && err.phase === "before-dispatch") {
					return v.notStarted("owner-unreachable", detail);
				}
				return v.unsure(paneInputStepCount(program), "owner-unreachable", detail);
			}
		}

		case "gone":
			return v.notStarted("pane-dead", "the pane's host is gone");

		case "unknown":
		default:
			// The host cannot name an owner, so a write here would be dropped silently.
			log.info("No provable writer for this native pane", context);
			return v.notStarted("owner-unknown", "the host could not name the pane's writer");
	}
}
