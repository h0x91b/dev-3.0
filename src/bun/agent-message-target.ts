/**
 * Where a held `dev3 message` goes. A task-addressed message goes to the task's
 * MAIN agent and nowhere else, whichever pane the user last looked at; an
 * addressed one goes to that exact agent process. Neither is ever redirected to a
 * sibling. Why: decisions/2026/10/26/agent-addressed-messages-and-replies.md.
 *
 * Button hand-offs (Create PR, commit, rebase) do not come through here: they keep
 * following focus via `resolveAgentPromptTargetPane`.
 */

import type { ScheduledMessageAuthor, Task } from "../shared/types";
import type { PaneRunListing } from "../shared/pane-runs";
import { encodeAgentHandle } from "../shared/agent-handle";
import { NATIVE_AGENT_PANE_ID } from "./agent-prompt-native";
import { listNativeTaskAgents } from "./native-agent-attribution";
import { nativeTaskPanesState } from "./native-task-panes";
import { liveAgentPaneIds, readPaneAgentIdentity, resolveScheduledMessageAuthorPane } from "./scheduled-message-author";
import { findAuxPanes } from "./task-aux-panes";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { DEFAULT_TMUX_SOCKET, PANE_ID_FORMAT, taskSessionName, tmux } from "./tmux";

/** What dev3 launched in a pane: the task's own agent, a `+ Agent` extra, or the AI Review agent. */
export type AgentPaneRole = "main" | "agent" | "review";

export type HeldMessageTarget =
	| { ok: true; paneId: string; author: ScheduledMessageAuthor | null }
	| { ok: false; detail: string };

function socketOf(task: Task): string {
	return task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
}

async function livePaneIds(task: Task): Promise<string[]> {
	if (taskTerminalBackendIdentity(task) === "native") {
		return ((await nativeTaskPanesState(task.id))?.panes ?? []).filter((pane) => pane.alive).map((pane) => pane.paneId);
	}
	try {
		const rows = await tmux.listPanes(PANE_ID_FORMAT, { target: taskSessionName(task.id), scope: "session", socket: socketOf(task) });
		return rows.map((row) => row.paneId).filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Every pane dev3 launched an agent in, by role. Native `+ Agent` and hunter panes
 * are not in sessionState; they are found by their launch-script sidecar.
 */
export async function agentPaneRoles(task: Task): Promise<Map<string, AgentPaneRole>> {
	const roles = new Map<string, AgentPaneRole>();
	if (taskTerminalBackendIdentity(task) === "native") {
		roles.set(NATIVE_AGENT_PANE_ID, "main");
		for (const agent of await listNativeTaskAgents(task)) roles.set(agent.paneId, "agent");
	} else {
		(task.sessionState?.panes ?? []).forEach((pane, index) => {
			if (pane.paneId && !roles.has(pane.paneId)) roles.set(pane.paneId, index === 0 ? "main" : "agent");
		});
	}
	for (const pane of await findAuxPanes(task, "columnAgent", socketOf(task))) {
		if (!roles.has(pane.paneId)) roles.set(pane.paneId, "review");
	}
	return roles;
}

/**
 * A pane listing with each agent pane's role and `--agent` handle, so a coordinator
 * can address the reviewer or an extra agent rather than whoever has focus.
 */
export async function withAgentPanes(task: Task, listing: PaneRunListing): Promise<PaneRunListing> {
	const roles = await agentPaneRoles(task).catch(() => new Map<string, AgentPaneRole>());
	if (roles.size === 0) return listing;
	const panes = await Promise.all(listing.panes.map(async (pane) => {
		const agentRole = roles.get(pane.paneId);
		if (!agentRole || pane.alive === false) return agentRole ? { ...pane, agentRole } : pane;
		const identity = await readPaneAgentIdentity(task, pane.paneId);
		return identity.ok
			? { ...pane, agentRole, agentHandle: encodeAgentHandle(identity.author) }
			: { ...pane, agentRole, agentHandleUnavailable: identity.detail };
	}));
	return { ...listing, panes };
}

/**
 * The main agent's pane on tmux: the first `sessionState` entry. A task with no
 * registry, or whose first entry has no pane id yet (Codex before its hook), uses
 * the first pane tmux lists, which is the one the task was created with.
 */
function mainTmuxPane(task: Task, live: string[]): string | null {
	const entries = task.sessionState?.panes ?? [];
	return entries[0]?.paneId || live[0] || null;
}

async function refusal(task: Task, why: string, mainPaneId: string | null, live: string[]): Promise<HeldMessageTarget> {
	const roles = await agentPaneRoles(task).catch(() => new Map<string, AgentPaneRole>());
	const others = live.filter((paneId) => paneId !== mainPaneId && roles.has(paneId));
	const hint = others.length > 0
		? ` Still running: ${others.map((paneId) => `pane ${paneId} (${roles.get(paneId)})`).join(", ")}. ` +
			`Address one with --agent <handle> from \`dev3 pane list --task ${task.id.slice(0, 8)}\`.`
		: "";
	return { ok: false, detail: `${why}; not sent to another agent.${hint}` };
}

/** The pane a task-addressed message goes to, with the agent it must still be there at delivery. */
export async function resolveMainAgentTarget(task: Task): Promise<HeldMessageTarget> {
	const live = await livePaneIds(task);
	const paneId = taskTerminalBackendIdentity(task) === "native" ? NATIVE_AGENT_PANE_ID : mainTmuxPane(task, live);
	if (!paneId || !live.includes(paneId)) {
		return refusal(task, `the task's main agent${paneId ? ` (pane ${paneId})` : ""} is not running`, paneId, live);
	}
	const identity = await readPaneAgentIdentity(task, paneId, { generation: true });
	if (identity.ok) return { ok: true, paneId, author: identity.author };
	if (identity.reason === "no-agent") return refusal(task, `the task's main agent has exited (${identity.detail})`, paneId, live);
	// Windows, or a probe that failed: the pane is still the main agent's, only unverified.
	return { ok: true, paneId, author: null };
}

/**
 * Asked again right before a held message is typed: null while `author` is still
 * the agent in `paneId`, otherwise why it is not. A message that waited out its
 * agent is dropped, never typed into whatever runs in that pane now.
 */
export async function addressedAgentRefusal(task: Task, author: ScheduledMessageAuthor, paneId: string): Promise<string | null> {
	const resolved = await resolveScheduledMessageAuthorPane(task, author);
	if (!resolved.ok) return resolved.detail;
	return resolved.paneId === paneId ? null : `the addressed agent moved to pane ${resolved.paneId}; not typed into pane ${paneId}`;
}

/**
 * Does a plain task-addressed message reach `agent`? Only while it is the task's
 * main agent, still that process, and no other agent (extra or AI Review) runs
 * there: then its reply command needs no `--agent`. Anything unproven says no.
 */
export async function isSoleMainAgent(task: Task, agent: ScheduledMessageAuthor): Promise<boolean> {
	const live = await liveAgentPaneIds(task);
	const reviews = await findAuxPanes(task, "columnAgent", socketOf(task), { strict: true }).catch(() => null);
	if (!live || !reviews) return false;
	const agents = new Set([...live, ...reviews.map((pane) => pane.paneId)]);
	const mainPaneId = taskTerminalBackendIdentity(task) === "native" ? NATIVE_AGENT_PANE_ID : mainTmuxPane(task, await livePaneIds(task));
	if (agents.size !== 1 || !mainPaneId || !agents.has(mainPaneId)) return false;
	const resolved = await resolveScheduledMessageAuthorPane(task, agent);
	return resolved.ok && resolved.paneId === mainPaneId;
}
