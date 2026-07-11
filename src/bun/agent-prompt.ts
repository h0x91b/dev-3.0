import type { PaneSessionEntry } from "../shared/types";
import * as pty from "./pty-server";
import { spawn } from "./spawn";
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
		const proc = spawn(pty.tmuxArgs(socket, "display-message", "-t", tmuxSession, "-p", "#{pane_id}"), { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		if ((await proc.exited) === 0) return stdout.trim() || null;
	} catch { /* best effort */ }
	return null;
}

/** The live pane ids across every window of `tmuxSession`, in tmux's listing order. */
async function listLivePaneIds(tmuxSession: string, socket: string): Promise<string[]> {
	try {
		const proc = spawn(pty.tmuxArgs(socket, "list-panes", "-s", "-t", tmuxSession, "-F", "#{pane_id}"), { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		if ((await proc.exited) === 0) {
			return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
		}
	} catch { /* best effort */ }
	return [];
}

/** Whether `paneId` is currently a live pane in `tmuxSession`. */
export async function isPaneLive(tmuxSession: string, socket: string, paneId: string): Promise<boolean> {
	return (await listLivePaneIds(tmuxSession, socket)).includes(paneId);
}

/**
 * Resolve the pane a hand-off prompt should be typed into.
 *
 * `agentPanes` is the task's recorded agent-pane registry (`sessionState.panes`),
 * the only reliable source of "which panes run an agent" — `pane_current_command`
 * is useless here because an agent constantly spawns child processes (a live
 * Claude pane reports `zsh`/`node` at random moments). Routing rules (issue #609):
 *
 *  - Exactly ONE live agent pane → target it unconditionally, even if a
 *    non-agent pane (a shell, a dev server) is currently focused. There is no
 *    ambiguity about where the agent lives, so focus must not misroute the prompt.
 *  - Exactly ONE unresolved main-agent entry → target tmux's first pane. This
 *    covers legacy tasks and the brief Codex pre-hook interval, when pane[0]'s
 *    ID has not been persisted yet but a shell split may be focused.
 *  - TWO OR MORE live agent panes, including a main pane whose id was not
 *    persisted → ambiguous; respect the user's focus and use the session's
 *    active pane.
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
function pasteThenEnter(socket: string, pane: string, text: string): boolean {
	try {
		const pasteProc = spawn(pty.tmuxArgs(socket, "send-keys", "-t", pane, text), { stdout: "pipe", stderr: "pipe" });
		pasteProc.exited.catch(() => {});
	} catch (err) {
		log.warn("send-keys paste failed", { paneId: pane, error: String(err) });
		return false;
	}
	setTimeout(() => {
		try {
			const enterProc = spawn(pty.tmuxArgs(socket, "send-keys", "-t", pane, "Enter"), { stdout: "pipe", stderr: "pipe" });
			enterProc.exited.catch(() => {});
		} catch (err) {
			log.warn("send-keys Enter failed", { paneId: pane, error: String(err) });
		}
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
