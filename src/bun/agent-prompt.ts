import type { PaneSessionEntry, Task } from "../shared/types";
import {
	type PaneIncarnation,
	type PaneInputOutcome,
	type PaneInputStage,
	isPaneInputRetryableAsNewDelivery,
	samePaneIncarnation,
	utf8Length,
} from "../shared/pane-input";
import { type AgentPromptDelivery, agentPromptHeld } from "../shared/agent-prompt-delivery";
import type { AgentPromptEpilogue } from "./agent-prompt-delivery";
import { deliverPaneInput, newPaneInputDeliveryId, pinTaskPane, sendPaneInput } from "./pane-input";
import {
	agentMessageHoldKey,
	hasStrandedAgentMessage,
	holdAgentMessage,
	type HeldAgentMessageReport,
	type HeldDeliveryResult,
	type HeldMessageBatch,
} from "./agent-message-hold";
import { noteDev3TypedPrompt, retractDev3TypedPrompt } from "./agent-typed-prompt-claims";
import { AGENT_MESSAGE_BURST_SEPARATOR } from "../shared/agent-message-envelope";
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
 * text is a text step, so the tmux adapter pastes it from a buffer and a prompt whose
 * content reads like a key name (`C-c`, `Escape`) is delivered rather than pressed.
 */
function agentPromptStages(prompt: string): PaneInputStage[] {
	return [
		{ steps: [{ kind: "text", text: prompt }] },
		{ delayBeforeMs: AGENT_PROMPT_ENTER_DELAY_MS, steps: [{ kind: "key", key: "enter" }] },
	];
}

/** The text-only program a held message's own paste is delivered as. */
function agentMessageTextStages(prompt: string): PaneInputStage[] {
	return [{ steps: [{ kind: "text", text: prompt }] }];
}

/**
 * The submit-only program the Enter that ends a burst is delivered as. Separate from
 * the text because the seam caps a program's in-band delays at two seconds
 * ({@link PANE_INPUT_LIMITS}) and the quiet window is many times that.
 *
 * It still carries the hand-off's own gap: two back-to-back `send-keys` are milliseconds
 * apart, and Claude Code then reads the burst's last paste and the CR as one paste with a
 * newline in it — the text sits in the box unsubmitted, and every later message stacks
 * onto it.
 */
function agentPromptSubmitStages(): PaneInputStage[] {
	return [{ delayBeforeMs: AGENT_PROMPT_ENTER_DELAY_MS, steps: [{ kind: "key", key: "enter" }] }];
}

/** A scrolled-up pane refused the keys but is still the same pane: the hold waits for it. */
function heldDeliveryResult(outcome: PaneInputOutcome): HeldDeliveryResult {
	if (outcome.status === "delivered") return "landed";
	return outcome.status === "not-started" && outcome.reason === "pane-in-mode" ? "deferred" : "failed";
}

/**
 * The exact pane generation each held text last landed in. A stranded box belongs to
 * that generation only: after a tmux restart the same `%id` names a different, empty box.
 */
const landedIncarnations = new Map<string, PaneIncarnation>();

/** A held text, typed against a pin this adapter keeps, so the generation it reached is known. */
async function typeHeldText(task: Task, paneId: string, holdKey: string, text: string): Promise<PaneInputOutcome> {
	const pin = await pinTaskPane(task, paneId);
	if (!pin.ok) {
		return {
			deliveryId: "",
			backend: "tmux",
			paneId,
			status: "not-started",
			reason: pin.reason,
			retryableAsNewDelivery: isPaneInputRetryableAsNewDelivery(pin.reason),
			detail: pin.detail,
		};
	}
	const outcome = await deliverPaneInput(task, {
		deliveryId: newPaneInputDeliveryId("agent-prompt"),
		attempt: 1,
		incarnation: pin.incarnation,
		stages: agentMessageTextStages(text),
	});
	if (outcome.status === "delivered") landedIncarnations.set(holdKey, pin.incarnation);
	return outcome;
}

/** Gone means absent, dead, or another generation; "cannot tell right now" keeps the messages. */
async function paneStillThere(task: Task, paneId: string, holdKey: string): Promise<boolean> {
	const pin = await pinTaskPane(task, paneId);
	if (!pin.ok) return pin.reason === "backend-failure";
	const landed = landedIncarnations.get(holdKey);
	return !landed || samePaneIncarnation(landed, pin.incarnation);
}

/** The refusal a direct prompt gets while the pane's box holds a stranded peer message. */
function inputOccupied(paneId: string): PaneInputOutcome {
	return {
		deliveryId: "",
		backend: "tmux",
		paneId,
		status: "not-started",
		reason: "input-occupied",
		retryableAsNewDelivery: true,
		detail: "a peer message is waiting unsent in the agent's input box — press Enter there first",
	};
}

/**
 * The receiving task's attention badge, because the sender was already told `held` and
 * nothing reaches it later. Loaded lazily: the push channel is app-side UI plumbing.
 */
async function reportHeldMessage(task: Task, event: HeldAgentMessageReport): Promise<void> {
	const reason =
		event.kind === "stranded"
			? `A peer message is typed in the agent's input box but not sent. Press Enter there to send it${event.waiting > 0 ? `; ${event.waiting} more wait until you do` : ""}.`
			: `${event.messages} held peer message(s) were not delivered: ${event.why}.${event.paths ? ` They are saved in ${event.paths.join(", ")}.` : ""}`;
	try {
		const { pushCliAttention } = await import("./rpc-handlers/shared");
		pushCliAttention({ taskId: task.id, projectId: task.projectId, reason });
	} catch (err) {
		log.warn("could not raise the held-message badge", { taskId: task.id.slice(0, 8), error: String(err) });
	}
}

/**
 * Write a held backlog to one file and hand the hold the pointer to type instead. The
 * receipt is left before anything is typed, like every dev3-typed prompt's, or the
 * receiver's submit hook would record the pointer as the user's own prompt.
 */
async function batchHeldMessages(task: Task, paneId: string, holdKey: string, texts: string[]): Promise<HeldMessageBatch | null> {
	const { discardHeldMessageBatch, spillHeldMessageBatch } = await import("./agent-message-spill");
	const spilled = await spillHeldMessageBatch(task, texts);
	if (!spilled) return null;
	noteDev3TypedPrompt(task.id, spilled.pointer);
	return {
		text: spilled.pointer,
		bytes: utf8Length(spilled.pointer),
		path: spilled.path,
		discard: async () => {
			retractDev3TypedPrompt(task.id, spilled.pointer);
			await discardHeldMessageBatch(spilled.path);
		},
		deliver: async (separator) => {
			const typed = await typeHeldText(task, paneId, holdKey, `${separator}${spilled.pointer}`);
			const result = heldDeliveryResult(typed);
			if (result === "failed") log.warn("held message batch pointer did not land", { taskId: task.id.slice(0, 8), paneId, status: typed.status });
			return result;
		},
	};
}

/**
 * Hold a whole `dev3 message` for `paneId`: nothing is typed now, so nothing can land
 * in the middle of the line the user is writing.
 *
 * Text and Enter are separate deliveries against FRESH pins, taken when the hold
 * releases, so a pane that dies inside the window fails them and says so instead of
 * typing into its successor. The Enter follows only when a text provably landed — an
 * Enter into an unknown input box would submit whatever is sitting in it.
 */
function holdAgentMessageForPane(
	task: Task,
	paneId: string,
	prompt: string,
	epilogue?: AgentPromptEpilogue,
): AgentPromptDelivery {
	const context = { taskId: task.id.slice(0, 8), paneId };
	const holdKey = agentMessageHoldKey("tmux", task.id, paneId);
	const delayMs = holdAgentMessage(
		holdKey,
		{
			text: prompt,
			alive: () => paneStillThere(task, paneId, holdKey),
			report: (event) => void reportHeldMessage(task, event),
			batch: (texts) => batchHeldMessages(task, paneId, holdKey, texts),
			deliver: async (separator) => {
				const text = await typeHeldText(task, paneId, holdKey, `${separator}${prompt}`);
				const result = heldDeliveryResult(text);
				if (result === "failed") log.warn("held agent message text did not land", { ...context, status: text.status });
				return result;
			},
			bytes: utf8Length(prompt),
			...(epilogue
				? {
					epilogue: async (budgetBytes) => {
						const trailer = await epilogue();
						if (!trailer) return false;
						if (utf8Length(trailer) > budgetBytes) {
							// A board that does not fit would split the turn, and the piece the
							// receiver drops is the first one — the messages, not the snapshot.
							log.info("board trailer dropped: it would push the turn past one terminal read", {
								...context,
								trailerBytes: String(utf8Length(trailer)),
								budgetBytes: String(budgetBytes),
							});
							return false;
						}
						const sent = await sendPaneInput(
							task,
							paneId,
							agentMessageTextStages(`${AGENT_MESSAGE_BURST_SEPARATOR}${trailer}`),
							{ idPrefix: "agent-epilogue" },
						);
						return sent.status === "delivered";
					},
				}
				: {}),
			submit: async () => {
				const submit = await sendPaneInput(task, paneId, agentPromptSubmitStages(), { idPrefix: "agent-submit" });
				const result = heldDeliveryResult(submit);
				if (result === "failed") log.warn("held agent message submit did not land", { ...context, status: submit.status });
				return result;
			},
		},
		context,
	);
	return agentPromptHeld(delayMs);
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
): Promise<PaneInputOutcome> {
	const { tmuxSession, socket } = tmuxRouting(task);
	const targetPane = await resolveAgentPromptTargetPane(tmuxSession, socket, agentPanes);
	if (!targetPane) return noTargetPane(`no agent pane could be resolved in ${tmuxSession}`);
	if (hasStrandedAgentMessage(agentMessageHoldKey("tmux", task.id, targetPane))) return inputOccupied(targetPane);
	return sendPaneInput(task, targetPane, agentPromptStages(prompt), { idPrefix: "agent-prompt" });
}

/**
 * Hold a `dev3 message` for the task's agent pane. Resolution happens NOW, so a task
 * with no agent pane is refused while its sender is still listening; the typing itself
 * happens when the pane goes quiet.
 */
export async function holdMessageForAgentPane(
	task: Task,
	prompt: string,
	agentPanes: PaneSessionEntry[] | undefined,
	epilogue?: AgentPromptEpilogue,
): Promise<AgentPromptDelivery> {
	const { tmuxSession, socket } = tmuxRouting(task);
	const targetPane = await resolveAgentPromptTargetPane(tmuxSession, socket, agentPanes);
	if (!targetPane) {
		return {
			status: "not-delivered",
			reason: "pane-absent",
			detail: `no agent pane could be resolved in ${tmuxSession}`,
		};
	}
	return holdAgentMessageForPane(task, targetPane, prompt, epilogue);
}

/**
 * Hold a `dev3 message` for one concrete pane id (the `{ kind: "pane" }` scheduled
 * target). Liveness is checked now rather than only at the pin: a message held for a
 * pane that is already gone would fail silently long after its sender walked away.
 */
export async function holdMessageForPane(
	task: Task,
	paneId: string,
	prompt: string,
	epilogue?: AgentPromptEpilogue,
): Promise<AgentPromptDelivery> {
	const { tmuxSession, socket } = tmuxRouting(task);
	const live = await listLivePaneIds(tmuxSession, socket);
	if (!live.includes(paneId)) {
		return { status: "not-delivered", reason: "pane-absent", detail: `pane ${paneId} is not live in ${tmuxSession}` };
	}
	return holdAgentMessageForPane(task, paneId, prompt, epilogue);
}

/**
 * Deliver `prompt` to a concrete pane id (the `{ kind: "pane" }` scheduled-message
 * target). A stale pane id from a previous tmux lifetime is refused by the pin —
 * the server generation is part of the pinned incarnation — so it never silently
 * misfires into whatever pane inherited the id.
 */
export async function sendPromptToPane(task: Task, paneId: string, prompt: string): Promise<PaneInputOutcome> {
	if (hasStrandedAgentMessage(agentMessageHoldKey("tmux", task.id, paneId))) return inputOccupied(paneId);
	return sendPaneInput(task, paneId, agentPromptStages(prompt), { idPrefix: "agent-prompt" });
}
