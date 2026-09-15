/**
 * Ask a task's agent CLI to quit on its own terms before the terminal is torn down.
 *
 * `tmux kill-session` and the native host's SIGHUP ladder are fire-and-forget, so the
 * worktree process reaper and the worktree removal that follow race whatever the CLI
 * runs on its way out — Claude Code's `SessionEnd` hooks are the case that surfaced
 * this: a hook that needs a couple of seconds is SIGKILLed as a stray worktree process
 * before it writes. This module types each adapter's quit command into every live
 * agent pane, then waits a bounded time for the agent's process tree to empty — which
 * includes its exit hooks. Whatever is still alive at the deadline is left to the kill
 * that follows; this step never blocks teardown for good.
 * See `decisions/2026/09/15/graceful-agent-exit-before-teardown.md`.
 */

import { getAgentAdapter } from "../shared/agent-adapters";
import type { PaneSessionEntry, Task } from "../shared/types";
import { NATIVE_AGENT_PANE_ID } from "./agent-prompt-native";
import { createLogger } from "./logger";
import { nativeTaskPanesState } from "./native-task-panes";
import { sendPaneInput } from "./pane-input";
import { collectDescendants, collectProcessInfo } from "./port-scanner";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { DEFAULT_TMUX_SOCKET, PANE_ID_PID_FORMAT, taskSessionName, tmux } from "./tmux";

const log = createLogger("agent-exit");

/** How long teardown waits for the agent to leave after being asked. */
export const GRACEFUL_AGENT_EXIT_TIMEOUT_MS = 30_000;
export const GRACEFUL_AGENT_EXIT_POLL_MS = 250;
/**
 * When the process tree cannot be read at all (no `ps` on this platform), one blind
 * wait of this length replaces the poll: long enough for a hook that appends a line,
 * short enough that teardown still feels immediate.
 */
export const GRACEFUL_AGENT_EXIT_BLIND_WAIT_MS = 5_000;

/** One live agent pane: where to type, and whose process tree says when it is gone. */
export interface AgentExitTarget {
	paneId: string;
	/** The pane's root process: the launch-script shell whose child is the agent. */
	rootPid: number;
	entry: PaneSessionEntry;
}

export type GracefulAgentExitOutcome =
	/** No live agent pane, or no adapter with a quit command — nothing was typed. */
	| { kind: "skipped"; reason: "no-agent-pane" | "no-exit-command" | "already-exited" | "not-delivered"; detail?: string }
	| { kind: "exited"; elapsedMs: number; panes: number }
	| { kind: "timed-out"; elapsedMs: number; panes: number; stillRunning: string[] }
	/** The tree could not be read; the blind wait ran instead of the poll. */
	| { kind: "blind-wait"; elapsedMs: number; panes: number };

export interface GracefulAgentExitOptions {
	timeoutMs?: number;
	pollMs?: number;
	blindWaitMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Live agent panes of `task`, paired with the pane root pid the exit poll watches.
 * Routed by the task's own backend identity, like every other teardown step.
 */
export async function resolveAgentExitTargets(task: Task): Promise<AgentExitTarget[]> {
	const entries = task.sessionState?.panes ?? [];
	if (entries.length === 0) return [];

	if (taskTerminalBackendIdentity(task) === "native") {
		const state = await nativeTaskPanesState(task.id);
		const agentPane = state?.panes.find((pane) => pane.paneId === NATIVE_AGENT_PANE_ID);
		const entry = entries[0];
		if (!agentPane?.alive || !entry) return [];
		return [{ paneId: agentPane.paneId, rootPid: agentPane.shellPid, entry }];
	}

	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	const rows = await tmux.listPanes(PANE_ID_PID_FORMAT, { target: taskSessionName(task.id), scope: "session", socket });
	const live = new Map((rows ?? []).map((row) => [row.paneId, row.panePid] as const));
	const targets: AgentExitTarget[] = [];
	for (const entry of entries) {
		if (!entry.paneId) continue;
		const rootPid = live.get(entry.paneId);
		if (rootPid === undefined || rootPid <= 0) continue;
		targets.push({ paneId: entry.paneId, rootPid, entry });
	}
	if (targets.length > 0) return targets;

	// A legacy main pane, or a freshly launched Codex pane, can have no recorded id
	// yet. Its entry is pane[0] and tmux lists the initial pane first. A recorded id
	// that tmux no longer lists is a pane that is gone, not one to guess at.
	const [firstRow] = rows ?? [];
	const firstEntry = entries[0];
	if (entries.length === 1 && firstEntry && !firstEntry.paneId && firstRow && firstRow.panePid > 0) {
		return [{ paneId: firstRow.paneId, rootPid: firstRow.panePid, entry: firstEntry }];
	}
	return [];
}

/**
 * Whether the agent under each pane root is gone. The launch script hands the pane
 * over to an interactive shell when the agent exits, so the pane itself stays alive
 * and the signal is the root having no descendants left. `null` when the tree
 * cannot be read on this platform.
 */
export async function agentTreesEmpty(rootPids: readonly number[]): Promise<Map<number, boolean> | null> {
	let tree: Map<number, number[]>;
	try {
		({ tree } = await collectProcessInfo({ maxAgeMs: 0 }));
	} catch {
		return null;
	}
	return new Map(rootPids.map((pid) => [pid, collectDescendants(pid, tree).length === 0] as const));
}

/**
 * Type each live agent's quit command and wait, bounded, for it to leave. Never
 * throws: every failure is logged and reported as an outcome, because the kill that
 * follows is the real guarantee — this step only buys the agent its exit hooks.
 */
export async function requestGracefulAgentExit(task: Task, options: GracefulAgentExitOptions = {}): Promise<GracefulAgentExitOutcome> {
	const timeoutMs = options.timeoutMs ?? GRACEFUL_AGENT_EXIT_TIMEOUT_MS;
	const pollMs = options.pollMs ?? GRACEFUL_AGENT_EXIT_POLL_MS;
	const blindWaitMs = options.blindWaitMs ?? GRACEFUL_AGENT_EXIT_BLIND_WAIT_MS;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const taskId = task.id.slice(0, 8);

	let targets: AgentExitTarget[];
	try {
		targets = await resolveAgentExitTargets(task);
	} catch (error) {
		log.warn("graceful agent exit: could not list agent panes", { taskId, error: String(error) });
		return { kind: "skipped", reason: "no-agent-pane", detail: String(error) };
	}
	if (targets.length === 0) return { kind: "skipped", reason: "no-agent-pane" };

	// Nothing to ask when the agent already left on its own — typing a slash command
	// into the shell that replaced it would only litter the pane.
	const before = await agentTreesEmpty(targets.map((target) => target.rootPid));
	const asked: AgentExitTarget[] = [];
	let alreadyGone = 0;
	let withoutCommand = 0;
	for (const target of targets) {
		if (before?.get(target.rootPid)) {
			alreadyGone += 1;
			continue;
		}
		const program = getAgentAdapter(target.entry.agentCmd, target.entry.agentFamily ?? undefined).exitProgram();
		if (!program) {
			withoutCommand += 1;
			log.info("graceful agent exit: no quit command for this agent", { taskId, paneId: target.paneId, agentCmd: target.entry.agentCmd });
			continue;
		}
		const outcome = await sendPaneInput(task, target.paneId, program, { idPrefix: "agent-exit" });
		if (outcome.status === "delivered" || outcome.status === "indeterminate") {
			asked.push(target);
			continue;
		}
		log.warn("graceful agent exit: quit command not delivered", {
			taskId,
			paneId: target.paneId,
			status: outcome.status,
			reason: outcome.reason,
			detail: outcome.detail,
		});
	}
	if (asked.length === 0) {
		if (alreadyGone === targets.length) return { kind: "skipped", reason: "already-exited" };
		if (alreadyGone + withoutCommand === targets.length) return { kind: "skipped", reason: "no-exit-command" };
		return { kind: "skipped", reason: "not-delivered" };
	}

	const startedAt = now();
	const deadline = startedAt + timeoutMs;
	if (before === null) {
		await sleep(blindWaitMs);
		const elapsedMs = now() - startedAt;
		log.info("graceful agent exit: process tree unreadable, waited blind", { taskId, panes: asked.length, elapsedMs });
		return { kind: "blind-wait", elapsedMs, panes: asked.length };
	}
	const pids = asked.map((target) => target.rootPid);
	for (;;) {
		const empty = await agentTreesEmpty(pids);
		if (empty === null) {
			// The tree was readable a moment ago; treat a transient read failure as "keep waiting".
		} else if (pids.every((pid) => empty.get(pid))) {
			const elapsedMs = now() - startedAt;
			log.info("graceful agent exit: agent left on request", { taskId, panes: asked.length, elapsedMs });
			return { kind: "exited", elapsedMs, panes: asked.length };
		}
		if (now() >= deadline) break;
		await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
	}
	const elapsedMs = now() - startedAt;
	const finalEmpty = await agentTreesEmpty(pids);
	const stillRunning = asked.filter((target) => !finalEmpty?.get(target.rootPid)).map((target) => target.paneId);
	log.warn("graceful agent exit: timed out, proceeding to kill", { taskId, timeoutMs, elapsedMs, stillRunning });
	return { kind: "timed-out", elapsedMs, panes: asked.length, stillRunning };
}
