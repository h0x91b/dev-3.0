import type { PaneSessionEntry } from "../shared/types";
import { tmux, PANE_ID_FORMAT, TMUX_AGENT_PANE_OPTION, TMUX_LAST_AGENT_PANE_OPTION } from "./tmux";
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

/** Whether `paneId` is currently a live pane in `tmuxSession`. */
export async function isPaneLive(tmuxSession: string, socket: string, paneId: string): Promise<boolean> {
	return (await listLivePaneIds(tmuxSession, socket)).includes(paneId);
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
 *    focus and use the session's active pane.
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
		// ≥2 or 0 live agent panes → fall through to the active pane below.
	}

	return activePane;
}

/** Type `text` into `pane`, then send Enter as a discrete keypress after a short delay. */
async function pasteThenEnter(socket: string, pane: string, text: string): Promise<boolean> {
	try {
		// bestEffort swallows non-zero tmux exits inside the client, so a rejection
		// here means tmux itself failed to launch — nothing reached the pane. Report
		// false (and skip Enter) so callers don't drop a queued message as delivered.
		await tmux.sendKeys(pane, [text], { socket, bestEffort: true });
	} catch (err) {
		log.warn("send-keys paste failed", { paneId: pane, error: String(err) });
		return false;
	}
	setTimeout(() => {
		tmux.sendKeys(pane, ["Enter"], { socket, bestEffort: true }).catch((err) => {
			log.warn("send-keys Enter failed", { paneId: pane, error: String(err) });
		});
	}, AGENT_PROMPT_ENTER_DELAY_MS);
	return true;
}

/**
 * Hand a task off to the AI agent running in its tmux session: pick the pane the
 * agent lives in (see {@link resolveAgentPromptTargetPane}), type `prompt` into
 * it, then send Enter as a discrete keypress after a short delay. Returns false
 * when no target pane could be resolved (nothing was sent). This is the shared
 * mechanism behind the Create-PR / auto-merge buttons, the rebase-conflict
 * handoff, and scheduled-message delivery — the agent is a continuation of the
 * user's conversation, so a plain-language instruction is enough.
 */
export async function sendPromptToAgentPane(
	tmuxSession: string,
	socket: string,
	prompt: string,
	agentPanes: PaneSessionEntry[] | undefined,
): Promise<boolean> {
	const targetPane = await resolveAgentPromptTargetPane(tmuxSession, socket, agentPanes);
	if (!targetPane) return false;
	return pasteThenEnter(socket, targetPane, prompt);
}

/**
 * Deliver `prompt` to a concrete pane id (the `{ kind: "pane" }` scheduled-message
 * target). Returns false when the pane is no longer live (→ drop-with-notice),
 * so a stale pane id from a previous tmux lifetime never silently misfires.
 */
export async function sendPromptToPane(
	tmuxSession: string,
	socket: string,
	paneId: string,
	prompt: string,
): Promise<boolean> {
	if (!(await isPaneLive(tmuxSession, socket, paneId))) return false;
	return pasteThenEnter(socket, paneId, prompt);
}
