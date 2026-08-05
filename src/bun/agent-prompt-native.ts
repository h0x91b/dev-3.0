/**
 * Agent-pane discovery and prompt delivery for the NATIVE terminal backend —
 * the counterpart of the tmux logic in {@link ./agent-prompt}.
 *
 * Three things make this different from tmux, and they are the whole reason the
 * module exists:
 *
 *  - **Discovery is structural, not heuristic.** The agent always runs in the
 *    coordinator's first pane: `startNativeTaskPanes` launches the agent wrapper
 *    there, and every later split is a plain shell (`nativePaneAction` never
 *    passes a launch spec). `createSplitTree` names that pane deterministically
 *    and `recover()` drops dead panes out of the tree, so "`pane-1` is in the
 *    pane set and alive" IS "the agent is running". No focus tracking, no
 *    command sniffing.
 *  - **A binding is not permission to write.** The host grants the writer lease
 *    to ONE client across all dev3 app processes and silently drops an
 *    observer's input, so ownership is resolved from the host itself
 *    (`resolvePaneOwner`, decision 191) before anything is typed.
 *  - **The delivery travels, not the bytes.** When another app process owns the
 *    lease, the whole delivery is forwarded to it over the socket the CLI
 *    already speaks and performed there exactly once. The forwarding process
 *    never also writes, and the owner-side entry point never forwards again, so
 *    there is no hop loop and no double submit.
 *
 * Never touches tmux, and never falls back to it: an unresolvable or unproven
 * target is an honest "no live agent session".
 *
 * A write here can never be PROVEN: `NativeTaskTerminal.write` is void and the host
 * cannot acknowledge input yet (decision 201). So the best answer this module has is
 * `unconfirmed` — it reports that instead of the optimistic "delivered" it used to.
 */

import type { Task } from "../shared/types";
import type { AgentPromptDelivery } from "../shared/agent-prompt-delivery";
import { scheduleAgentPromptSubmit } from "./agent-prompt";
import { createLogger } from "./logger";
import { forwardToOwner, resolvePaneOwner } from "./native-pane-owner";
import type { NativeTaskTerminal } from "./native-task-terminal";
import { nativeTaskPanesState } from "./native-task-panes";
import { ensureNativePanePtySession, nativePaneTerminal, reattachNativeTaskSession } from "./pty-server";

const log = createLogger("agent-prompt-native");

/** The coordinator pane the task's agent runs in (see the module header). */
export const NATIVE_AGENT_PANE_ID = "pane-1";

/** Carriage return — what a native PTY needs as the discrete "submit" keypress. */
const SUBMIT_KEY = "\r";

/**
 * Internal CLI-socket method that performs one prompt delivery inside the app
 * process holding the pane's writer lease. Owner-side only: its handler calls
 * {@link deliverNativePromptAsOwner}, which never forwards, so a delivery can
 * never bounce between two processes.
 */
export const NATIVE_PROMPT_DELIVERY_METHOD = "_native.deliverPrompt";

/** Params of {@link NATIVE_PROMPT_DELIVERY_METHOD} — a whole delivery, already resolved. */
export interface NativePromptDeliveryParams {
	taskId: string;
	paneId: string;
	/** Final text, envelope-wrapping already applied by the sender. */
	text: string;
}

/**
 * The task's live agent pane id, or null when no agent is running. Extra
 * shell-only splits never qualify, and a pane set that outlived its agent pane
 * (shells still open, `pane-1` gone) correctly resolves to null. Reads the
 * coordinator from disk, so it answers the same in every app process.
 */
export async function resolveNativeAgentPane(taskId: string): Promise<string | null> {
	const state = await nativeTaskPanesState(taskId);
	if (!state) return null;
	const agentPane = state.panes.find((pane) => pane.paneId === NATIVE_AGENT_PANE_ID);
	return agentPane?.alive ? agentPane.paneId : null;
}

/** Type the prompt, then submit it after the shared delay. One paste, one CR. */
function typeThenSubmit(terminal: NativeTaskTerminal, paneId: string, prompt: string): void {
	terminal.write(prompt);
	scheduleAgentPromptSubmit(() => terminal.write(SUBMIT_KEY), { paneId });
}

/**
 * This process's binding for `paneId`, binding it on demand when there is none —
 * the app restarted, or this is simply not the process that launched the task.
 * Never spawns: both helpers only rediscover an already-running host.
 */
async function bindPane(task: Task, paneId: string): Promise<NativeTaskTerminal | null> {
	const existing = nativePaneTerminal(task.id, paneId);
	if (existing) return existing;
	if (!task.worktreePath) return null;

	try {
		if (paneId === NATIVE_AGENT_PANE_ID) {
			await reattachNativeTaskSession(task.id, task.projectId, task.worktreePath);
		} else {
			const state = await nativeTaskPanesState(task.id);
			const pane = state?.panes.find((p) => p.paneId === paneId && p.alive);
			if (!pane) return null;
			await ensureNativePanePtySession(task.id, paneId, pane.sessionId, task.projectId, task.worktreePath);
		}
	} catch (err) {
		log.warn("Binding the native pane before prompt delivery failed", {
			taskId: task.id.slice(0, 8),
			paneId,
			error: String(err),
		});
		return null;
	}
	return nativePaneTerminal(task.id, paneId);
}

/**
 * Perform a delivery in THIS process, which must hold the writer lease.
 *
 * The owner-side half of the forwarding hop, and deliberately a dead end: it
 * resolves no owner and forwards nothing, so a stale answer can never make two
 * processes bounce one message back and forth. Returns false when the lease is
 * not (or no longer) ours — the sender then reports an undelivered message
 * rather than a phantom success.
 */
export async function deliverNativePromptAsOwner(params: NativePromptDeliveryParams): Promise<boolean> {
	const terminal = nativePaneTerminal(params.taskId, params.paneId);
	if (!terminal) return false;
	if (terminal.hostRole() !== "writer") {
		// The lease may have fallen vacant between the sender resolving us and this
		// call landing; claiming is safe because the host refuses while it is held.
		if ((await terminal.claimHostWriter()) !== "writer") {
			log.warn("Owner-routed delivery arrived without the writer lease", {
				taskId: params.taskId.slice(0, 8),
				paneId: params.paneId,
			});
			return false;
		}
	}
	typeThenSubmit(terminal, params.paneId, params.text);
	return true;
}

/** Nothing was sent, and it is proven — the caller may report a failure and may re-send. */
function notDelivered(reason: string, detail: string): AgentPromptDelivery {
	return { status: "not-delivered", reason, detail };
}

/** The best answer a write into a native PTY has: the bytes went out, unacknowledged. */
function wroteUnconfirmed(): AgentPromptDelivery {
	return {
		status: "unconfirmed",
		reason: "unacknowledged",
		detail: "the text was written to the native pane, whose host cannot acknowledge input yet",
	};
}

/**
 * Type `prompt` into one native pane, wherever its writer lease lives.
 *
 * The best case is `unconfirmed`, never `delivered`: the write itself is unprovable.
 * Every other answer is `not-delivered` and proven — no owner, no binding, or a lease
 * that moved — so a caller can tell "nothing happened" from "cannot say".
 */
export async function sendPromptToNativePane(task: Task, paneId: string, prompt: string): Promise<AgentPromptDelivery> {
	const terminal = await bindPane(task, paneId);
	if (!terminal) return notDelivered("pane-absent", `no live native pane ${paneId} to bind`);

	const owner = await resolvePaneOwner(terminal);
	const context = { taskId: task.id.slice(0, 8), paneId, owner: owner.kind };

	switch (owner.kind) {
		case "local":
			typeThenSubmit(terminal, paneId, prompt);
			return wroteUnconfirmed();

		case "vacant": {
			// Nobody is typing — take the lease and deliver here.
			if ((await terminal.claimHostWriter()) === "writer") {
				typeThenSubmit(terminal, paneId, prompt);
				return wroteUnconfirmed();
			}
			log.info("Writer lease was taken while claiming it; not delivering", context);
			return notDelivered("read-only", "another process took the pane's writer lease while claiming it");
		}

		case "peer": {
			// Forward the WHOLE delivery, never the bytes, and never write locally
			// as well — that is what keeps it exactly once.
			const params: NativePromptDeliveryParams = { taskId: task.id, paneId, text: prompt };
			try {
				const delivered = await forwardToOwner<{ delivered: boolean }>(
					owner,
					NATIVE_PROMPT_DELIVERY_METHOD,
					params as unknown as Record<string, unknown>,
				);
				log.info("Prompt delivery routed to the owning app process", { ...context, ownerPid: owner.pid });
				// The wire stays a boolean: it answers "did the owner write", which is as much
				// as the owner itself can know. True is therefore unconfirmed, not delivered.
				return delivered?.delivered === true
					? wroteUnconfirmed()
					: notDelivered("read-only", `the owning app process (pid ${owner.pid}) did not hold the lease`);
			} catch (err) {
				log.warn("Forwarding the prompt to the owning app process failed", {
					...context,
					ownerPid: owner.pid,
					error: String(err),
				});
				// The request left this process, so its fate is genuinely unknown — the owner
				// may have written before the reply was lost.
				return {
					status: "unconfirmed",
					reason: "owner-unreachable",
					detail: `forwarding to owner ${owner.pid} failed: ${String(err)}`,
				};
			}
		}

		case "unknown":
		case "gone":
		default:
			// The host cannot name an owner, so a write here would be dropped
			// silently. Report it as undelivered rather than guess.
			log.info("No provable writer for this native pane", context);
			return notDelivered("owner-unknown", "the host cannot name a writer for this pane");
	}
}

/** Deliver `prompt` to the task's live native agent pane. */
export async function sendPromptToNativeAgentPane(task: Task, prompt: string): Promise<AgentPromptDelivery> {
	const paneId = await resolveNativeAgentPane(task.id);
	if (!paneId) {
		log.info("No live native agent pane for this task", { taskId: task.id.slice(0, 8) });
		return notDelivered("pane-absent", "the task has no live native agent pane");
	}
	return sendPromptToNativePane(task, paneId, prompt);
}
