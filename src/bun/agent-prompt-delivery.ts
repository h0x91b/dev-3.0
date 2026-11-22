/**
 * The ONE backend-neutral entry point for typing a prompt into a task's agent.
 *
 * Everything that hands a task's agent some text goes through here: `dev3 message`
 * (immediate), scheduled-message delivery, the Create-PR / auto-merge / commit
 * hand-offs, and the rebase-conflict hand-off. Before this seam existed each of
 * them called the tmux helpers directly, so a task running on the native backend
 * had no pane to find and every send failed with "no live agent session" while the
 * agent was plainly alive (seq 1371).
 *
 * Rules, all load-bearing:
 *  - The task's persisted backend identity decides the path, and a task whose
 *    marker cannot be read throws instead of guessing (`taskTerminalBackendIdentity`).
 *  - A native task NEVER falls back to tmux. If its agent pane cannot be resolved
 *    or written to, the answer is the caller's honest "no live agent session" —
 *    not a tmux send that would type into nothing.
 *  - `hold` types NOTHING now: the whole message waits for the traffic into that pane
 *    to go quiet, so a burst of `dev3 message` sends becomes one agent turn and no
 *    peer's text lands in the middle of the user's own line. Only the message paths
 *    ask for it; button hand-offs type and submit at once.
 *  - …unless the pane they aim at shows a prompt (#2342). A digit typed into a menu
 *    picks a row and the Enter approves it, so a hand-off into such a pane is held
 *    behind the prompt like a message, and the user is told why nothing appeared.
 *  - A held message never follows focus. Task-addressed, it goes to the main
 *    agent; bound to one agent (`author`), to that agent only — checked again at
 *    release. Hand-offs keep the focus rule (`agent-message-target.ts`).
 *  - Four answers reach the caller, never fewer. `unconfirmed` is the native arm's
 *    everyday answer (its host cannot acknowledge input) and tmux's answer when a
 *    send stopped mid-program, so nothing may report it as either success or
 *    failure; `held` means dev3 has it and has typed none of it — see
 *    `src/shared/agent-prompt-delivery.ts`.
 */

import type { ScheduledMessageAuthor, ScheduledMessageTarget, Task } from "../shared/types";
import {
	AGENT_PROMPT_HELD_BEHIND_PROMPT,
	type AgentPromptDelivery,
	agentPromptDeliveryFromPaneInput,
	agentPromptHeld,
} from "../shared/agent-prompt-delivery";
import { holdMessageForPane, resolveHandoffPane, sendPromptToAgentPane, sendPromptToPane } from "./agent-prompt";
import { type HeldMessageTarget, addressedAgentRefusal, resolveMainAgentTarget } from "./agent-message-target";
import { resolveNativeAgentPane, sendPromptToNativeAgentPane, sendPromptToNativePane } from "./agent-prompt-native";
import { agentPromptLedger } from "./agent-prompt-ledger";
import { createLogger } from "./logger";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { refreshClaudeHooksForTask } from "./agent-hooks-refresh";
import { noteDev3TypedPrompt, retractDev3TypedPrompt } from "./agent-typed-prompt-claims";
import { type HookDeliverable, agentMessageAlreadyHeld, agentMessageHoldKey, hasStrandedAgentMessage } from "./agent-message-hold";

const log = createLogger("agent-prompt-delivery");

/**
 * Text appended once at the end of the agent's turn, after every message in the
 * burst and before its Enter. Async and called at typing time, never at queue
 * time, so a trailer describing live state is built from live state; returning
 * "" adds nothing at all.
 */
export type AgentPromptEpilogue = () => Promise<string>;

/**
 * Append the trailer to a prompt that is typed in one piece. A trailer that
 * throws costs the trailer, never the message it was riding on.
 */
export async function withEpilogue(prompt: string, epilogue?: AgentPromptEpilogue): Promise<string> {
	if (!epilogue) return prompt;
	try {
		const trailer = await epilogue();
		return trailer ? `${prompt}\n\n${trailer}` : prompt;
	} catch {
		return prompt;
	}
}

/**
 * Type `prompt` into `task`'s agent (or into one concrete pane) and submit it,
 * reporting which of the three answers the backend could actually give.
 */
export async function deliverAgentPrompt(
	task: Task,
	prompt: string,
	target: ScheduledMessageTarget = { kind: "agent" },
	opts: {
		hold?: boolean;
		epilogue?: AgentPromptEpilogue;
		author?: ScheduledMessageAuthor | null;
		/** Lets the agent's tool hook take a held message instead of the pane (tmux only). */
		hook?: Pick<HookDeliverable, "text" | "delivered" | "notice">;
	} = {},
): Promise<AgentPromptDelivery> {
	// The prompt about to land will fire UserPromptSubmit, so the hooks have to be
	// in place before it is typed, not after. A no-op unless something rewrote the
	// settings file behind us. Done at hold time too: a held message may land many
	// seconds later, but nothing else runs on its behalf in between.
	await refreshClaudeHooksForTask(task);

	// That same UserPromptSubmit is indistinguishable from the user typing, so
	// leave the receipt BEFORE the text can be submitted: this is the one seam
	// every dev3-caused prompt passes through, which is what makes the receipts a
	// complete set rather than a list of the paths someone remembered.
	noteDev3TypedPrompt(task.id, prompt);

	const native = taskTerminalBackendIdentity(task) === "native";
	if (opts.hold) {
		const bound = await heldMessagePane(task, target, opts.author ?? null);
		if (!bound.ok) return { status: "not-delivered", reason: "pane-absent", detail: bound.detail, paneId: "" };
		const author = bound.author;
		const verify = author ? () => addressedAgentRefusal(task, author, bound.paneId) : undefined;
		if (!native) return holdMessageForPane(task, bound.paneId, prompt, opts.epilogue, verify, hookOffer(task, prompt, opts));
		// The native arm folds the trailer in NOW rather than at release time, so a
		// held message carries a snapshot up to one hold window old. Its delivery is
		// a closure that may be forwarded to whichever process owns the pane's
		// writer lease, and a closure does not cross a process boundary — a stale
		// trailer beats a trailer that silently vanishes on the forwarding path.
		return sendPromptToNativePane(task, bound.paneId, await withEpilogue(prompt, opts.epilogue), { hold: true, verify });
	}
	const gatedPane = await handoffPaneBehindPrompt(task, target, native);
	if (gatedPane) return holdHandoffBehindPrompt(task, gatedPane, prompt, native, opts.epilogue);
	if (native) {
		const text = await withEpilogue(prompt, opts.epilogue);
		return target.kind === "pane"
			? sendPromptToNativePane(task, target.paneId, text, opts)
			: sendPromptToNativeAgentPane(task, text, opts);
	}
	// Nothing is held, so this send IS the whole turn: the trailer just rides on
	// the end of the text instead of being typed as its own stage.
	const text = await withEpilogue(prompt, opts.epilogue);
	const outcome =
		target.kind === "pane"
			? await sendPromptToPane(task, target.paneId, text)
			: await sendPromptToAgentPane(task, text, task.sessionState?.panes);
	return agentPromptDeliveryFromPaneInput(outcome);
}

/**
 * The hook side of a held message. A drained message is never typed, so the receipt
 * left for its prompt-submit hook is taken back: it would otherwise sit there and
 * swallow the user's own prompt if they ever typed the same text.
 */
function hookOffer(
	task: Task,
	prompt: string,
	opts: { epilogue?: AgentPromptEpilogue; hook?: Pick<HookDeliverable, "text" | "delivered" | "notice"> },
): HookDeliverable | undefined {
	const hook = opts.hook;
	if (!hook) return undefined;
	return {
		text: hook.text,
		...(hook.notice ? { notice: hook.notice } : {}),
		delivered: () => {
			retractDev3TypedPrompt(task.id, prompt);
			hook.delivered();
		},
		...(opts.epilogue ? { trailer: opts.epilogue } : {}),
	};
}

/** The pane a held message waits for, and the agent it is bound to there, if any. */
async function heldMessagePane(task: Task, target: ScheduledMessageTarget, author: ScheduledMessageAuthor | null): Promise<HeldMessageTarget> {
	if (target.kind === "pane") return { ok: true, paneId: target.paneId, author };
	return resolveMainAgentTarget(task);
}

/**
 * A hand-off aimed at a pane that shows a prompt joins that pane's hold. A re-click on
 * the same text adds no second copy: nothing visible happened, so re-clicks are likely.
 */
async function holdHandoffBehindPrompt(
	task: Task,
	paneId: string,
	prompt: string,
	native: boolean,
	epilogue: AgentPromptEpilogue | undefined,
): Promise<AgentPromptDelivery> {
	const text = native ? await withEpilogue(prompt, epilogue) : prompt;
	const key = agentMessageHoldKey(native ? "native" : "tmux", task.id, paneId);
	let delivery: AgentPromptDelivery;
	if (agentMessageAlreadyHeld(key, text)) {
		delivery = { ...agentPromptHeld(0, true), paneId };
	} else {
		delivery = native
			? await sendPromptToNativePane(task, paneId, text, { hold: true })
			: await holdMessageForPane(task, paneId, prompt, epilogue);
		// A native pane owned by another app process holds it there and cannot say why;
		// it was routed here only because this pane shows a prompt.
		if (native && delivery.status === "held") delivery = { ...agentPromptHeld(0, true), paneId };
	}
	if (delivery.reason === AGENT_PROMPT_HELD_BEHIND_PROMPT) await announceHeldBehindPrompt(task);
	return delivery;
}

/**
 * The pane an unheld hand-off would type into, when that pane shows a prompt. Asked only
 * when some pane of the task does, so the everyday hand-off resolves nothing extra.
 */
export async function handoffPaneBehindPrompt(
	task: Task,
	target: ScheduledMessageTarget,
	native = taskTerminalBackendIdentity(task) === "native",
): Promise<string | null> {
	const prompted = agentPromptLedger.promptPanes(task.id);
	if (prompted.size === 0) return null;
	const paneId =
		target.kind === "pane"
			? target.paneId
			: native
				? await resolveNativeAgentPane(task.id)
				: await resolveHandoffPane(task);
	if (!paneId || !prompted.has(paneId)) return null;
	// A stranded turn keeps its own refusal: the user has to press Enter there first.
	return !native && hasStrandedAgentMessage(agentMessageHoldKey("tmux", task.id, paneId)) ? null : paneId;
}

/** A click that typed nothing has to say so, or the button looks broken (#2342). */
export async function announceHeldBehindPrompt(task: Task): Promise<void> {
	try {
		const { pushCliToast } = await import("./rpc-handlers/shared");
		pushCliToast({
			taskId: task.id,
			projectId: task.projectId,
			message: "The agent is showing a prompt. dev3 sends this after you answer it.",
			messageKey: "kanban.handoffHeldBehindPrompt",
			level: "info",
		});
	} catch (err) {
		log.warn("could not announce a hand-off held behind a prompt", { taskId: task.id.slice(0, 8), error: String(err) });
	}
}
