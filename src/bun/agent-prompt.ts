import type { PaneSessionEntry, Task } from "../shared/types";
import type { PaneInputOutcome, PaneInputStage } from "../shared/pane-input";
import { sendPaneInput } from "./pane-input";
import { agentPromptSubmitKey, coalesceAgentPromptSubmit } from "./agent-prompt-submit-coalescer";
import { DEFAULT_TMUX_SOCKET, tmux, taskSessionName, PANE_ID_FORMAT, TMUX_AGENT_PANE_OPTION, TMUX_LAST_AGENT_PANE_OPTION } from "./tmux";
import { createLogger } from "./logger";

const log = createLogger("agent-prompt");

/**
 * Delay between typing the prompt and sending Enter — gives the agent's input
 * layer time to process the paste buffer so Enter lands as a discrete submit.
 */
export const AGENT_PROMPT_ENTER_DELAY_MS = 800;

/** Query tmux for the session's currently-active pane id, or null. */
async function getActivePane(tmuxSession: string, socket: string): Promise<string | null> {
	try {
		return await tmux.activePaneId(tmuxSession, { socket });
	} catch { /* best effort */ }
	return null;
}

/** The live pane ids across every window of `tmuxSession`, in tmux's listing order. */
async function listLivePaneIds(tmuxSession: string, socket: string): Promise<string[]> {
	try {
		const rows = await tmux.listPanes(PANE_ID_FORMAT, { target: tmuxSession, scope: "session", socket });
		return rows.map((row) => row.paneId).filter(Boolean);
	} catch { /* best effort */ }
	return [];
}

/**
 * Tag `paneId` as an agent pane so the `after-select-pane` tmux hook records it
 * when focused (see {@link resolveAgentPromptTargetPane}). Best-effort: a failure
 * only means that pane can't be tracked yet, degrading to the focus heuristic.
 */
export async function markAgentPane(socket: string, paneId: string): Promise<void> {
	try {
		await tmux.setPaneOption(paneId, TMUX_AGENT_PANE_OPTION, "1", { socket, bestEffort: true });
	} catch (err) {
		log.debug("markAgentPane failed", { paneId, error: String(err) });
	}
}

/** Mark several agent panes concurrently (best-effort). */
async function markAgentPanes(socket: string, paneIds: string[]): Promise<void> {
	await Promise.all(paneIds.map((id) => markAgentPane(socket, id)));
}

/** The pane id the focus hook recorded as the last-focused agent pane, or null. */
async function getLastFocusedAgentPane(tmuxSession: string, socket: string): Promise<string | null> {
	try {
		return (await tmux.showOption(tmuxSession, TMUX_LAST_AGENT_PANE_OPTION, { socket })) || null;
	} catch { /* best effort — the session may be gone */ }
	return null;
}

/**
 * Resolve the pane a hand-off prompt should be typed into.
 *
 * `agentPanes` is the task's recorded agent-pane registry (`sessionState.panes`),
 * the only reliable source of "which panes run an agent" — `pane_current_command`
 * is useless here because an agent constantly spawns child processes (a live
 * Claude pane reports `zsh`/`node` at random moments). Routing rules (issue #609):
 *
 *  - LAST-FOCUSED live agent pane → target it. The `after-select-pane` tmux hook
 *    records the last agent pane the user focused (per session), so a hand-off
 *    follows the agent they were actually working in — and, crucially, is NOT
 *    hijacked when a shell / dev-server split is the pane currently in focus.
 *  - Exactly ONE live agent pane → target it unconditionally.
 *  - Exactly ONE unresolved main-agent entry → target tmux's first pane. This
 *    covers legacy tasks and the brief Codex pre-hook interval, when pane[0]'s
 *    ID has not been persisted yet but a shell split may be focused.
 *  - TWO OR MORE live agent panes with nothing recorded yet → respect the user's
 *    focus when the focused pane IS one of them, else the first live agent pane.
 *    Never a shell split: tmux reports "delivered" for any pane, so a hand-off
 *    typed into a shell reads as a clean send while the agent got nothing.
 *  - ZERO known agent panes (legacy tasks with no sessionState) → fall back to
 *    the active pane, preserving the historical behavior.
 *
 * Returns the pane id, or null when nothing usable could be resolved.
 */
export async function resolveAgentPromptTargetPane(
	tmuxSession: string,
	socket: string,
	agentPanes: PaneSessionEntry[] | undefined,
): Promise<string | null> {
	const activePane = await getActivePane(tmuxSession, socket);

	const registeredIds = (agentPanes ?? [])
		.map((p) => p.paneId)
		.filter((id): id is string => Boolean(id));
	const hasUnresolvedAgentPane = (agentPanes ?? []).some((pane) => !pane.paneId);

	if (registeredIds.length > 0 || hasUnresolvedAgentPane) {
		const orderedLivePaneIds = await listLivePaneIds(tmuxSession, socket);
		const livePaneIds = new Set(orderedLivePaneIds);
		const liveAgentPanes = [...new Set(registeredIds.filter((id) => livePaneIds.has(id)))];

		// Self-heal: ensure every live agent pane carries the focus-hook marker,
		// regardless of which launch/resume path created it. Fire-and-forget so it
		// never delays delivery; it only makes the hook track this pane from the
		// next focus onward.
		void markAgentPanes(socket, liveAgentPanes);

		// Prefer the agent pane the user focused most recently. Requires the pane to
		// still be live AND a known agent pane, so a stale/dead recorded id or a
		// last-focused non-agent split never wins.
		const lastFocused = await getLastFocusedAgentPane(tmuxSession, socket);
		if (lastFocused && liveAgentPanes.includes(lastFocused)) return lastFocused;

		if (liveAgentPanes.length === 1 && !hasUnresolvedAgentPane) return liveAgentPanes[0] ?? null;
		// Legacy main panes and a newly launched Codex pane can briefly have no
		// recorded pane ID. Their session-state entry is pane[0], and tmux lists
		// that initial pane first, so prefer it over an unrelated focused shell.
		if (agentPanes?.length === 1 && hasUnresolvedAgentPane) return orderedLivePaneIds[0] ?? null;
		// ≥2 live agents and nothing recorded: honour the user's focus only when it
		// IS one of them. Typing a hand-off into the focused shell used to look like
		// a clean delivery (tmux takes the keys either way) while the agent never
		// saw a word — and a review that clears itself on that "success" is gone.
		if (liveAgentPanes.length > 0) {
			if (activePane && liveAgentPanes.includes(activePane)) return activePane;
			log.info("agent prompt routed to the first live agent pane", {
				session: tmuxSession,
				activePane: activePane ?? "none",
				chosen: liveAgentPanes[0] ?? "none",
				liveAgents: liveAgentPanes.length,
			});
			return liveAgentPanes[0] ?? null;
		}
		// No live agent pane at all → fall through to the active pane below.
	}

	// Legacy tasks with no agent registry: the active pane is the only guess there
	// is. Logged, because it is also the one route that can land in a plain shell.
	log.info("agent prompt falling back to the active pane (no live agent pane known)", {
		session: tmuxSession,
		activePane: activePane ?? "none",
		registered: registeredIds.length,
	});
	return activePane;
}

/**
 * Schedule the single submit keypress that ends a prompt delivery. Exactly one
 * per delivery: callers invoke it only from the success path of the paste, and
 * it never retries — a re-sent Enter would submit whatever the agent's input
 * box holds at that moment.
 */
export function scheduleAgentPromptSubmit(send: () => void | Promise<void>, context: Record<string, string>): void {
	setTimeout(() => {
		// `send` runs synchronously inside the timer — a `.then(send)` hop would
		// defer it by a microtask, which is a real behavior change for callers that
		// drive the clock (and for how promptly the agent sees the submit).
		try {
			void Promise.resolve(send()).catch((err) =>
				log.warn("agent prompt submit failed", { ...context, error: String(err) }),
			);
		} catch (err) {
			log.warn("agent prompt submit threw", { ...context, error: String(err) });
		}
	}, AGENT_PROMPT_ENTER_DELAY_MS);
}

/**
 * The program every agent prompt is: type the text, wait, then submit it.
 *
 * Two stages rather than one, because Claude Code's input layer reads a fast
 * "text Enter" as a single paste — newline included — and never submits. The
 * text is a text step, so the tmux adapter sends it with `-l` and a prompt whose
 * content reads like a key name (`C-c`, `Escape`) is typed rather than pressed.
 *
 * A coalesced delivery stops after the text: its Enter is a delivery of its own,
 * held by {@link coalesceAgentPromptSubmit}, because the seam caps a program's
 * in-band delays at two seconds and the quiet window is ten.
 */
function agentPromptStages(prompt: string, coalesceSubmit: boolean): PaneInputStage[] {
	const type: PaneInputStage = { steps: [{ kind: "text", text: prompt }] };
	if (coalesceSubmit) return [type];
	return [type, { delayBeforeMs: AGENT_PROMPT_ENTER_DELAY_MS, steps: [{ kind: "key", key: "enter" }] }];
}

/** The submit-only program a held Enter is delivered as. */
function agentPromptSubmitStages(): PaneInputStage[] {
	return [{ steps: [{ kind: "key", key: "enter" }] }];
}

/**
 * Type the text now and hold its Enter until the traffic into `paneId` goes quiet.
 *
 * The submit is a separate delivery against a FRESH pin, so a pane that dies inside
 * the window fails the Enter and says so, instead of typing into its successor. Held
 * only when the text provably landed: a text stage that stopped mid-way leaves an
 * unknown input box, and an Enter into that would submit whatever is in it.
 */
async function sendCoalescedAgentPrompt(task: Task, paneId: string, prompt: string): Promise<PaneInputOutcome> {
	const outcome = await sendPaneInput(task, paneId, agentPromptStages(prompt, true), { idPrefix: "agent-prompt" });
	if (outcome.status !== "delivered") return outcome;
	const context = { taskId: task.id.slice(0, 8), paneId };
	coalesceAgentPromptSubmit(
		agentPromptSubmitKey("tmux", task.id, paneId),
		async () => {
			const submit = await sendPaneInput(task, paneId, agentPromptSubmitStages(), { idPrefix: "agent-submit" });
			if (submit.status !== "delivered") {
				log.warn("held agent prompt submit did not land", { ...context, status: submit.status });
			}
		},
		context,
	);
	return outcome;
}

/** The verdict for a prompt that never found a pane to aim at. */
function noTargetPane(detail: string): PaneInputOutcome {
	return {
		deliveryId: "",
		backend: "tmux",
		paneId: "",
		status: "not-started",
		reason: "pane-absent",
		retryableAsNewDelivery: false,
		detail,
	};
}

/** The tmux socket and session name `task` runs on. */
function tmuxRouting(task: Task): { tmuxSession: string; socket: string } {
	return { tmuxSession: taskSessionName(task.id), socket: task.tmuxSocket ?? DEFAULT_TMUX_SOCKET };
}

/**
 * Hand a task off to the AI agent running in its tmux session: pick the pane the
 * agent lives in (see {@link resolveAgentPromptTargetPane}), type `prompt` into
 * it, then submit it. This is the shared mechanism behind the Create-PR /
 * auto-merge buttons, the rebase-conflict handoff, and scheduled-message
 * delivery — the agent is a continuation of the user's conversation, so a
 * plain-language instruction is enough.
 *
 * Delivery goes through the guarded seam (decision 201), so the pane is pinned to
 * one tmux server generation and the verdict distinguishes "the pane is gone"
 * from "the server took the keys" from "nobody can say". Resolution is a
 * heuristic and pinning is a separate sighting, so a pane that dies in between is
 * reported by the send rather than by a pre-check.
 */
export async function sendPromptToAgentPane(
	task: Task,
	prompt: string,
	agentPanes: PaneSessionEntry[] | undefined,
	opts: { coalesceSubmit?: boolean } = {},
): Promise<PaneInputOutcome> {
	const { tmuxSession, socket } = tmuxRouting(task);
	const targetPane = await resolveAgentPromptTargetPane(tmuxSession, socket, agentPanes);
	if (!targetPane) return noTargetPane(`no agent pane could be resolved in ${tmuxSession}`);
	if (opts.coalesceSubmit) return sendCoalescedAgentPrompt(task, targetPane, prompt);
	return sendPaneInput(task, targetPane, agentPromptStages(prompt, false), { idPrefix: "agent-prompt" });
}

/**
 * Deliver `prompt` to a concrete pane id (the `{ kind: "pane" }` scheduled-message
 * target). A stale pane id from a previous tmux lifetime is refused by the pin —
 * the server generation is part of the pinned incarnation — so it never silently
 * misfires into whatever pane inherited the id.
 */
export async function sendPromptToPane(
	task: Task,
	paneId: string,
	prompt: string,
	opts: { coalesceSubmit?: boolean } = {},
): Promise<PaneInputOutcome> {
	if (opts.coalesceSubmit) return sendCoalescedAgentPrompt(task, paneId, prompt);
	return sendPaneInput(task, paneId, agentPromptStages(prompt, false), { idPrefix: "agent-prompt" });
}
