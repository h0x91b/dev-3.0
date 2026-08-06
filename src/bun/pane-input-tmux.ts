/**
 * The tmux adapter: the only place neutral keys become tmux key names. One stage is one
 * guarded command list, so no window exists between checking identity and sending.
 * See `decisions/2026/08/06/backend-neutral-pane-input.md`.
 */

import {
	describePaneIncarnation,
	type PaneInputKey,
	type PaneInputOutcome,
	type PaneInputProgram,
	type PaneInputReason,
	type PaneInputStage,
	type PaneInputStep,
} from "../shared/pane-input";
import { createLogger } from "./logger";
import type { PaneInputExecution } from "./pane-input-ledger";
import { monotonicNowMs } from "./pane-input-ledger";
import { tmux, isTmuxSpawnError, isTmuxTimeoutError } from "./tmux";

const log = createLogger("pane-input-tmux");

/** Neutral key → tmux `send-keys` key name. Must cover every {@link PaneInputKey}. */
const TMUX_KEY_NAMES: Readonly<Record<PaneInputKey, string>> = {
	enter: "Enter",
	escape: "Escape",
	tab: "Tab",
	backspace: "BSpace",
	up: "Up",
	down: "Down",
	right: "Right",
	left: "Left",
	home: "Home",
	end: "End",
	"ctrl-c": "C-c",
	"ctrl-d": "C-d",
	"ctrl-l": "C-l",
	"ctrl-u": "C-u",
};

/**
 * What one step puts into the pane, for size accounting only. tmux resolves key names
 * itself, so a key's wire form is its name rather than a byte sequence.
 */
export function tmuxStepPayload(step: PaneInputStep): string {
	return step.kind === "text" ? step.text : TMUX_KEY_NAMES[step.key].repeat(step.count ?? 1);
}

/** One stage as ordered chunks: literal text, or a run of key names. */
function tmuxStageChunks(stage: PaneInputStage): ({ literal: string } | { keys: string[] })[] {
	const chunks: ({ literal: string } | { keys: string[] })[] = [];
	for (const step of stage.steps) {
		const last = chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
		if (step.kind === "text") {
			if (last && "literal" in last) chunks[chunks.length - 1] = { literal: last.literal + step.text };
			else chunks.push({ literal: step.text });
			continue;
		}
		const names = Array<string>(step.count ?? 1).fill(TMUX_KEY_NAMES[step.key]);
		if (last && "keys" in last) last.keys.push(...names);
		else chunks.push({ keys: names });
	}
	return chunks;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Perform `program` against its tmux pane. */
export async function executeTmuxPaneInput(
	program: PaneInputProgram,
	socket: string,
	execution: PaneInputExecution,
): Promise<PaneInputOutcome> {
	const incarnation = program.incarnation;
	const base = { deliveryId: program.deliveryId, backend: "tmux" as const, paneId: incarnation.paneId };
	const notStarted = (reason: PaneInputReason, detail: string): PaneInputOutcome => ({
		...base,
		status: "not-started",
		reason,
		retryableAsNewDelivery: false,
		detail,
	});
	/** A clean stop: everything up to `accepted` went out, nothing after it ran. */
	const stoppedClean = (accepted: number, reason: PaneInputReason, detail: string): PaneInputOutcome =>
		accepted === 0
			? notStarted(reason, detail)
			: { ...base, status: "partial", acceptedThrough: accepted, uncertainStep: null, reason, detail };

	if (incarnation.backend !== "tmux") return notStarted("invalid-input", "a tmux send needs a tmux incarnation");

	let accepted = 0;
	for (const stage of program.stages) {
		const delay = stage.delayBeforeMs ?? 0;
		if (delay > 0) {
			if (monotonicNowMs() + delay > execution.deadlineAtMs) {
				return stoppedClean(accepted, "deadline-exceeded", "the program's budget ran out before a stage delay");
			}
			await sleep(delay);
		}
		const remainingMs = execution.deadlineAtMs - monotonicNowMs();
		if (remainingMs <= 0) {
			return stoppedClean(accepted, "deadline-exceeded", "the program's budget ran out before a stage");
		}

		if (execution.signal.aborted) {
			return stoppedClean(accepted, "deadline-exceeded", "the program was aborted before this stage");
		}

		let sent: boolean;
		try {
			({ sent } = await tmux.sendKeysGuarded({
				pane: incarnation.paneId,
				serverToken: incarnation.serverToken,
				session: incarnation.sessionName,
				chunks: tmuxStageChunks(stage),
				socket,
				timeoutMs: remainingMs,
				signal: execution.signal,
			}));
		} catch (err) {
			const detail = String(err);
			log.warn("tmux pane input failed mid-program", { paneId: incarnation.paneId, error: detail });
			// A spawn failure proves the command never reached the server.
			if (isTmuxSpawnError(err)) return stoppedClean(accepted, "backend-failure", detail);
			// A killed command may or may not have been applied first, and an unconfirmed stop
			// says so. Overlap is prevented by the tmux SERVER, which serializes commands
			// across clients; ledger quarantine only guards the native path, where an
			// abandoned writer really can interleave bytes.
			if (isTmuxTimeoutError(err)) {
				return {
					...base,
					status: "indeterminate",
					possiblyAcceptedThrough: accepted + stage.steps.length,
					reason: err.stopConfirmed ? "deadline-exceeded" : "backend-failure",
					detail,
				};
			}
			// The command was spawned and exited non-zero. A stage can be several nested
			// send-keys, so a prefix of it may already have reached the pane: only an
			// explicit false guard proves nothing was sent.
			return {
				...base,
				status: "indeterminate",
				possiblyAcceptedThrough: accepted + stage.steps.length,
				reason: "backend-failure",
				detail,
			};
		}

		if (!sent) {
			// The guard was false inside the same server turn, so nothing went out. tmux gives
			// one bit: moved, restarted, gone and copy-mode all answer the same way. A pane in
			// copy mode is still THIS incarnation, so re-pinning returns the same refusal.
			return stoppedClean(
				accepted,
				"incarnation-changed",
				`${describePaneIncarnation(incarnation)} did not pass the guard (moved, restarted, gone, or sitting in copy mode), so nothing was sent`,
			);
		}
		accepted += stage.steps.length;
		execution.progress(accepted);
	}
	return { ...base, status: "delivered", acceptedThrough: accepted };
}
