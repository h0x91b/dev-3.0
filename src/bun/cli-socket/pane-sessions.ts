import type { Project, Task } from "../../shared/types";
import * as data from "../data";
import { getPushMessage } from "../rpc-handlers";
import type { PromptSubmitHarness } from "../../shared/agent-terminal-prompt";
import * as agents from "../agents";
import { agentKey } from "../../shared/agent-adapters/families";
import { placePaneSession, placeRecordedPaneSession, placeUnaddressedPaneSession, type SessionPane } from "../pane-session-capture";
import { isInteractiveCodexConversation } from "../codex-resume-home";
import { configuredCodexHomes } from "../codex-task-selection";
import { log } from "./shared";

/**
 * Cheap pre-check for {@link capturePaneSession}: is this exact pane already
 * carrying this exact session id? Reads through the cache (no lock, no strict
 * re-parse) and answers false on any doubt — a stale or unreadable read only costs
 * one trip through the real locked path, which is idempotent anyway.
 */
async function paneSessionAlreadyRecorded(
	project: Project,
	taskId: string,
	paneId: string | null,
	sessionId: string,
): Promise<boolean> {
	try {
		const task = await data.getTask(project, taskId);
		const panes = task.sessionState?.panes ?? [];
		const pane = paneId ? panes.find((p) => p.paneId === paneId) : panes.length === 1 ? panes[0] : undefined;
		return pane?.sessionId === sessionId;
	} catch {
		return false;
	}
}

/**
 * Persist a hook-reported session id onto the sessionState pane it belongs to,
 * so resumeTask can `codex resume <id>` / `omp --resume <id>` the exact session
 * per pane — targeted recovery for multi-session worktrees (e.g. reviving
 * several bug hunters). Neither Codex nor omp takes a session id at launch, so
 * the id is only knowable post-hoc: the lifecycle hook reports the resumable id
 * together with $TMUX_PANE (see src/cli/commands/status-hook-request.ts).
 *
 * Matching, in order (see {@link placePaneSession}): the entry carrying this
 * paneId; else the entry already carrying this session id (the conversation was
 * resumed in a new pane); else the lone null-paneId entry (the main pane,
 * persisted before its paneId is known); else — only when no entry is left at all
 * and the reporting CLI is the task's own agent — a new main entry. Anything else
 * is ambiguous and skipped. A no-op once the id is already recorded. Claude
 * takes a launch id, so only its recorded panes follow their own conversation
 * (`/clear`, `/resume`); see {@link placeRecordedPaneSession}.
 *
 * The steady state is exactly that no-op — Codex fires this hook continuously for
 * the whole life of a session — so it is answered from the cached read BEFORE
 * taking the file lock. Going through the lock for it made every hook re-parse the
 * board strictly (14 MB on the largest measured board); see the 2026-08-16 freeze record.
 */
export async function capturePaneSession(
	project: Project,
	taskId: string,
	paneId: string | null,
	sessionId: string,
	harness: PromptSubmitHarness,
): Promise<void> {
	try {
		if (await paneSessionAlreadyRecorded(project, taskId, paneId, sessionId)) return;
		// Resolved outside the file lock: the agent registry has its own files.
		const cached = await data.getTask(project, taskId);
		// A `codex exec` or subagent in the pane fires the same hooks; only the
		// user's own conversation, once its rollout exists, may become the pane's.
		if (harness === "codex" && !(await isInteractiveCodexConversation(sessionId, await taskCodexHomes(project, cached)))) return;
		const mainEntry = harness === "claude" || cached.sessionState?.panes?.length ? null : await ownAgentPaneEntry(cached, harness);
		const { task: updated, result } = await data.updateTaskWith(project, taskId, (current) => {
			const panes = current.sessionState?.panes ?? [];
			const nextPanes = harness === "claude"
				? (paneId ? placeRecordedPaneSession(panes, paneId, sessionId) : null)
				: paneId
					? placePaneSession(panes, paneId, sessionId, mainEntry)
					: placeUnaddressedPaneSession(panes, sessionId, mainEntry);
			if (!nextPanes) return { updates: {}, result: { changed: false } };
			return { updates: { sessionState: { panes: nextPanes } }, result: { changed: true } };
		});
		if (result.changed) {
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("Captured agent pane session id", { taskId: taskId.slice(0, 8), paneId });
		}
	} catch (err) {
		log.warn("Failed to capture agent pane session id (non-fatal)", { error: String(err) });
	}
}

/** The Codex stores the task's own agent may write to, besides the managed accounts. */
async function taskCodexHomes(project: Project, task: Task): Promise<string[]> {
	if (!task.worktreePath) return [];
	const agent = task.agentId ? (await agents.getAllAgents()).find((entry) => entry.id === task.agentId) : undefined;
	try {
		return await configuredCodexHomes(project, task, agent, task.configId);
	} catch {
		return [];
	}
}

/**
 * The main-pane entry a hook may recreate when pane-exit reconciliation left the
 * task with none. Only for the task's own agent: resume relaunches panes[0] with
 * the task's agent, so recording another CLI's conversation there would resume it
 * with the wrong command. The account is left unset — Codex resume locates the
 * account store from the conversation file itself.
 */
async function ownAgentPaneEntry(task: Task, harness: PromptSubmitHarness): Promise<SessionPane | null> {
	if (!task.agentId) return null;
	const agent = (await agents.getAllAgents()).find((entry) => entry.id === task.agentId);
	if (!agent) return null;
	const config = agents.findConfig(agent, task.configId);
	const baseCommand = config?.baseCommandOverride || agent.baseCommand;
	if (agentKey(baseCommand, agent.agentFamily) !== harness) return null;
	return {
		agentCmd: baseCommand,
		sessionId: null,
		agentId: task.agentId,
		configId: task.configId,
		...(agent.agentFamily ? { agentFamily: agent.agentFamily } : {}),
	};
}
