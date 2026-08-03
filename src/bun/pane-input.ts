/**
 * The one entry point for pane input: routing comes from the TASK, never the request.
 * See `decisions/201-backend-neutral-pane-input.md`.
 */

import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types";
import {
	isPaneInputRetryableAsNewDelivery,
	decodePaneInputProgram,
	decodePaneInputStages,
	validatePaneInputProgram,
	validatePaneInputSize,
	type PaneInputOutcome,
	type PaneInputPin,
	type PaneInputProgram,
	type PaneInputStage,
} from "../shared/pane-input";
import { deliverNativePaneInput, resolveNativePaneIncarnation } from "./pane-input-native";
import { executeTmuxPaneInput, tmuxStepPayload } from "./pane-input-tmux";
import { runPaneInputProgramOnce } from "./pane-input-ledger";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { DEFAULT_TMUX_SOCKET, taskSessionName, tmux } from "./tmux";

export type {
	PaneIncarnation,
	PaneInputOutcome,
	PaneInputProgram,
	PaneInputStage,
	PaneInputStep,
} from "../shared/pane-input";
/**
 * A globally unique delivery id. Random, not pid-and-counter: a successor counting from
 * zero would mint ids an owner still remembers from its predecessor.
 */
export function newPaneInputDeliveryId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

function refuse(
	program: PaneInputProgram,
	backend: "tmux" | "native",
	detail: string,
): PaneInputOutcome {
	return {
		deliveryId: program?.deliveryId ?? "",
		backend,
		paneId: program?.incarnation?.paneId ?? "",
		status: "not-started",
		reason: "invalid-input",
		retryableAsNewDelivery: false,
		detail,
	};
}

/** Pin `paneId` of `task` to the incarnation a program is then checked against. */
export async function pinTaskPane(task: Task, paneId: string): Promise<PaneInputPin> {
	if (taskTerminalBackendIdentity(task) === "native") return resolveNativePaneIncarnation(task, paneId);
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	// Observe first, so a pane that is genuinely gone is reported as absent rather than
	// surfacing later as a changed incarnation. The guarded send remains the authority:
	// this answer is already stale when it returns.
	const seen = await tmux.observePane({ pane: paneId, socket });
	if (seen.kind === "absent") {
		return { ok: false, reason: "pane-absent", detail: `no pane ${paneId} on this tmux server` };
	}
	if (seen.kind === "dead") {
		return { ok: false, reason: "pane-dead", detail: `pane ${paneId} is listed but its process is gone` };
	}
	if (seen.kind === "unusable") return { ok: false, reason: "backend-failure", detail: seen.detail };
	const sessionName = taskSessionName(task.id);
	if (seen.sessionName !== sessionName) {
		return {
			ok: false,
			reason: "pane-absent",
			detail: `pane ${paneId} belongs to session ${seen.sessionName}, not ${sessionName}`,
		};
	}
	// The token comes from the SAME sighting as the pane, its liveness and its session, so a
	// restart between two reads cannot pair one generation's pane with another's token.
	return {
		ok: true,
		incarnation: { backend: "tmux", taskId: task.id, paneId, sessionName, serverToken: seen.serverToken },
	};
}

/** Run one pinned program against its pane. */
export async function deliverPaneInput(task: Task, request: PaneInputProgram): Promise<PaneInputOutcome> {
	const backend = taskTerminalBackendIdentity(task);
	// Own the request before anything awaits: the caller keeps its object and may mutate it.
	const decoded = decodePaneInputProgram(request);
	if (!decoded.ok) return refuse(request, backend, decoded.detail);
	const program = decoded.value;

	const invalid = validatePaneInputProgram(program);
	if (invalid) return refuse(program, backend, invalid);
	if (program.incarnation.taskId !== task.id) {
		return refuse(program, backend, `program is pinned to task ${program.incarnation.taskId}, not ${task.id}`);
	}
	if (program.incarnation.backend !== backend) {
		return refuse(program, backend, `task runs on the ${backend} backend, but the program is pinned to ${program.incarnation.backend}`);
	}

	if (backend === "native") return deliverNativePaneInput(task, program);
	// Size is checked BEFORE admission, so a giant invalid program cannot consume a
	// ledger record or its retained canonical copy.
	const oversized = validatePaneInputSize(program, tmuxStepPayload);
	if (oversized) return refuse(program, backend, oversized);
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	return runPaneInputProgramOnce(program, (execution) => executeTmuxPaneInput(program, socket, execution));
}

/** Pin the pane, build the program, deliver it. */
export async function sendPaneInput(
	task: Task,
	paneId: string,
	stages: readonly PaneInputStage[],
	opts: { deliveryId?: string; idPrefix?: string; deadlineMs?: number; attempt?: number } = {},
): Promise<PaneInputOutcome> {
	// Everything the caller supplied is owned HERE, before the first await: pinning is
	// asynchronous, and a caller could otherwise change the steps, the deadline or the
	// attempt while it runs.
	const deliveryId = opts.deliveryId ?? newPaneInputDeliveryId(opts.idPrefix ?? "pane-input");
	const backend = taskTerminalBackendIdentity(task);
	const owned = decodePaneInputStages(stages);
	const attempt = opts.attempt ?? 1;
	const deadlineMs = opts.deadlineMs;
	if (!owned.ok) {
		return {
			deliveryId,
			backend,
			paneId,
			status: "not-started",
			reason: "invalid-input",
			retryableAsNewDelivery: false,
			detail: owned.detail,
		};
	}
	const pin = await pinTaskPane(task, paneId);
	if (!pin.ok) {
		return {
			deliveryId,
			backend,
			paneId,
			status: "not-started",
			reason: pin.reason,
			retryableAsNewDelivery: isPaneInputRetryableAsNewDelivery(pin.reason),
			detail: pin.detail,
		};
	}
	return deliverPaneInput(task, {
		deliveryId,
		incarnation: pin.incarnation,
		stages: owned.value,
		...(deadlineMs === undefined ? {} : { deadlineMs }),
		attempt,
	});
}

