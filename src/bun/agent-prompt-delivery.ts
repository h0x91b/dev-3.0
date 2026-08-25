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
 *  - Four answers reach the caller, never fewer. `unconfirmed` is the native arm's
 *    everyday answer (its host cannot acknowledge input) and tmux's answer when a
 *    send stopped mid-program, so nothing may report it as either success or
 *    failure; `held` means dev3 has it and has typed none of it — see
 *    `src/shared/agent-prompt-delivery.ts`.
 */

import type { ScheduledMessageTarget, Task } from "../shared/types";
import { type AgentPromptDelivery, agentPromptDeliveryFromPaneInput } from "../shared/agent-prompt-delivery";
import { holdMessageForAgentPane, holdMessageForPane, sendPromptToAgentPane, sendPromptToPane } from "./agent-prompt";
import { sendPromptToNativeAgentPane, sendPromptToNativePane } from "./agent-prompt-native";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { refreshClaudeHooksForTask } from "./agent-hooks-refresh";

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
	opts: { hold?: boolean; epilogue?: AgentPromptEpilogue } = {},
): Promise<AgentPromptDelivery> {
	// The prompt about to land will fire UserPromptSubmit, so the hooks have to be
	// in place before it is typed, not after. A no-op unless something rewrote the
	// settings file behind us. Done at hold time too: a held message may land many
	// seconds later, but nothing else runs on its behalf in between.
	await refreshClaudeHooksForTask(task);

	if (taskTerminalBackendIdentity(task) === "native") {
		// The native arm folds the trailer in NOW rather than at release time, so a
		// held message carries a snapshot up to one hold window old. Its delivery is
		// a closure that may be forwarded to whichever process owns the pane's
		// writer lease, and a closure does not cross a process boundary — a stale
		// trailer beats a trailer that silently vanishes on the forwarding path.
		const text = await withEpilogue(prompt, opts.epilogue);
		return target.kind === "pane"
			? sendPromptToNativePane(task, target.paneId, text, opts)
			: sendPromptToNativeAgentPane(task, text, opts);
	}
	if (opts.hold) {
		return target.kind === "pane"
			? holdMessageForPane(task, target.paneId, prompt, opts.epilogue)
			: holdMessageForAgentPane(task, prompt, task.sessionState?.panes, opts.epilogue);
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
