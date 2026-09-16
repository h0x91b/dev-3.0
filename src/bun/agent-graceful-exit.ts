/**
 * Ask a task's agent CLI to quit on its own terms before the terminal is torn down.
 *
 * `tmux kill-session` and the native host's SIGHUP ladder are fire-and-forget, so the
 * worktree process reaper and the worktree removal that follow race whatever the CLI
 * runs on its way out — Claude Code's `SessionEnd` hooks are the case that surfaced
 * this: a hook that needs a couple of seconds is SIGKILLed as a stray worktree process
 * before it writes. This module types each adapter's quit command into every live
 * agent pane, then waits a bounded time for the pane's process tree to empty — which
 * includes the hooks the agent leaves behind. Whatever is still alive at the deadline
 * is left to the kill that follows; this step never blocks teardown for good.
 *
 * Two questions, deliberately answered by two different signals:
 *  - BEFORE typing: is the agent itself running under this pane? Identity, matched
 *    against the process table, so a shell job the user left behind never gets a
 *    slash command typed at it.
 *  - AFTER typing: has the pane's whole subtree emptied? Not "is the agent gone" —
 *    an exit hook outlives the agent, and waiting for it is the entire point.
 *
 * See `decisions/2026/09/15/graceful-agent-exit-before-teardown.md`.
 */

import { basename } from "node:path";
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
 * Freshness the poll asks of the shared `ps` snapshot. Below the poll interval, so
 * every tick sees a new table, but non-zero so simultaneous teardowns share one spawn
 * instead of each forking its own `ps`.
 */
export const GRACEFUL_AGENT_EXIT_PROCESS_MAX_AGE_MS = 200;

/** One live agent pane: where to type, and whose process tree says when it is gone. */
export interface AgentExitTarget {
	paneId: string;
	/** The pane's root process: the launch-script shell whose child is the agent. */
	rootPid: number;
	entry: PaneSessionEntry;
}

export type GracefulAgentExitOutcome =
	/**
	 * Nothing was typed. `no-process-evidence` is the platform answer: without a
	 * readable process table the agent cannot be identified, and typing a slash
	 * command at an unidentified pane is worse than skipping the step.
	 */
	| {
			kind: "skipped";
			/** `no-agent-process`: the agent left, or what runs in the pane is not it. */
			reason: "no-agent-pane" | "no-exit-command" | "no-agent-process" | "not-delivered" | "no-process-evidence" | "failed";
			detail?: string;
	  }
	| { kind: "exited"; elapsedMs: number; panes: number }
	| { kind: "timed-out"; elapsedMs: number; panes: number; stillRunning: string[] };

export interface GracefulAgentExitOptions {
	timeoutMs?: number;
	pollMs?: number;
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

	// pane[0] is persisted at launch without an id (`tmux-pty.ts`) and gains one only
	// once the pane is listed, so a single entry with no id is the normal main pane,
	// not just legacy state. tmux lists the initial pane first. A recorded id that
	// tmux no longer lists is a pane that is gone, not one to guess at.
	const [firstRow] = rows ?? [];
	const firstEntry = entries[0];
	if (entries.length === 1 && firstEntry && !firstEntry.paneId && firstRow && firstRow.panePid > 0) {
		return [{ paneId: firstRow.paneId, rootPid: firstRow.panePid, entry: firstEntry }];
	}
	return [];
}

/** The process table, as much of it as this step needs. */
export interface AgentProcessEvidence {
	tree: Map<number, number[]>;
	cmdlines: Map<number, string>;
}

/**
 * The process table, or `null` when this platform cannot produce one.
 *
 * `collectProcessInfo` reports a failed or missing `ps` as an EMPTY table rather than
 * an error — `runText` swallows every failure and returns "". An empty table would
 * read as "every agent already left", so it is reported as absent evidence instead,
 * the same rule `terminal-process-ownership/collector.ts` follows for Windows.
 */
export async function readAgentProcessEvidence(maxAgeMs = GRACEFUL_AGENT_EXIT_PROCESS_MAX_AGE_MS): Promise<AgentProcessEvidence | null> {
	if (process.platform === "win32") return null;
	try {
		const { tree, cmdlines } = await collectProcessInfo({ maxAgeMs });
		if (tree.size === 0) return null;
		return { tree, cmdlines };
	} catch {
		return null;
	}
}

/** Interpreter and packaging suffixes that hide an agent's own name. */
const PROGRAM_SUFFIX = /\.(js|mjs|cjs|exe|cmd|bat)$/i;

/**
 * The program names a command line starts with: argv0 and, for an interpreted CLI,
 * the script it runs (`node …/gemini.js`). Parsing stops at the first flag, because
 * an agent's own command line carries the whole task prompt after its flags and any
 * word in it would otherwise match.
 */
export function leadingProgramNames(cmdline: string): string[] {
	const names: string[] = [];
	for (const token of cmdline.trim().split(/\s+/)) {
		if (!token) continue;
		if (token.startsWith("-")) break;
		names.push(basename(token).replace(PROGRAM_SUFFIX, "").toLowerCase());
		if (names.length === 3) break;
	}
	return names;
}

/**
 * The pids under `rootPid` that ARE this pane's agent — matched on the recorded
 * launch command's own name, never on a substring of a command line.
 */
export function agentPidsUnder(target: AgentExitTarget, evidence: AgentProcessEvidence): number[] {
	const wanted = basename(target.entry.agentCmd).replace(PROGRAM_SUFFIX, "").toLowerCase();
	if (!wanted) return [];
	return collectDescendants(target.rootPid, evidence.tree).filter((pid) => {
		const cmdline = evidence.cmdlines.get(pid);
		return cmdline ? leadingProgramNames(cmdline).includes(wanted) : false;
	});
}

/**
 * Whether the pane has nothing running under it any more. This — not "the agent
 * process is gone" — is what ends the wait: an exit hook is a separate process that
 * outlives the agent, and letting it finish is the reason this step exists.
 */
function paneSubtreeEmpty(rootPid: number, evidence: AgentProcessEvidence): boolean {
	return collectDescendants(rootPid, evidence.tree).length === 0;
}

/**
 * Type each live agent's quit command and wait, bounded, for its pane to go quiet.
 * Never throws: every failure is logged and reported as an outcome, because the kill
 * that follows is the real guarantee — this step only buys the agent its exit hooks.
 */
export async function requestGracefulAgentExit(task: Task, options: GracefulAgentExitOptions = {}): Promise<GracefulAgentExitOutcome> {
	try {
		return await runGracefulAgentExit(task, options);
	} catch (error) {
		log.warn("graceful agent exit: step failed, proceeding to kill", { taskId: task.id.slice(0, 8), error: String(error) });
		return { kind: "skipped", reason: "failed", detail: String(error) };
	}
}

async function runGracefulAgentExit(task: Task, options: GracefulAgentExitOptions): Promise<GracefulAgentExitOutcome> {
	const timeoutMs = options.timeoutMs ?? GRACEFUL_AGENT_EXIT_TIMEOUT_MS;
	const pollMs = options.pollMs ?? GRACEFUL_AGENT_EXIT_POLL_MS;
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

	// No process table, no identity — and an unidentified pane is not one to type a
	// slash command into. Said out loud, because the alternative is a feature that is
	// silently off on a whole platform.
	const evidence = await readAgentProcessEvidence();
	if (!evidence) {
		log.info("graceful agent exit: no process evidence on this platform, skipping", { taskId, platform: process.platform, panes: targets.length });
		return { kind: "skipped", reason: "no-process-evidence" };
	}

	const asked: AgentExitTarget[] = [];
	let alreadyGone = 0;
	let withoutCommand = 0;
	for (const target of targets) {
		const agentPids = agentPidsUnder(target, evidence);
		if (agentPids.length === 0) {
			// Either the agent already left, or whatever runs in this pane is not it.
			// Both mean the same thing here: nothing to ask.
			alreadyGone += 1;
			continue;
		}
		const program = getAgentAdapter(target.entry.agentCmd, target.entry.agentFamily ?? undefined).exitProgram();
		if (!program) {
			withoutCommand += 1;
			log.info("graceful agent exit: no quit command for this agent", { taskId, paneId: target.paneId, agentCmd: target.entry.agentCmd });
			continue;
		}
		let outcome: Awaited<ReturnType<typeof sendPaneInput>>;
		try {
			outcome = await sendPaneInput(task, target.paneId, program, { idPrefix: "agent-exit" });
		} catch (error) {
			log.warn("graceful agent exit: quit command could not be sent", { taskId, paneId: target.paneId, error: String(error) });
			continue;
		}
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
		if (alreadyGone === targets.length) return { kind: "skipped", reason: "no-agent-process" };
		if (alreadyGone + withoutCommand === targets.length) return { kind: "skipped", reason: "no-exit-command" };
		return { kind: "skipped", reason: "not-delivered" };
	}

	const startedAt = now();
	const deadline = startedAt + timeoutMs;
	const pids = asked.map((target) => target.rootPid);
	for (;;) {
		const fresh = await readAgentProcessEvidence();
		if (fresh === null) {
			// The table was readable a moment ago; treat a transient read failure as
			// "keep waiting" rather than as "the pane is quiet".
		} else if (pids.every((pid) => paneSubtreeEmpty(pid, fresh))) {
			const elapsedMs = now() - startedAt;
			log.info("graceful agent exit: agent left on request", { taskId, panes: asked.length, elapsedMs });
			return { kind: "exited", elapsedMs, panes: asked.length };
		}
		if (now() >= deadline) break;
		await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
	}
	const elapsedMs = now() - startedAt;
	const final = await readAgentProcessEvidence();
	const stillRunning = asked
		.filter((target) => !final || !paneSubtreeEmpty(target.rootPid, final))
		.map((target) => target.paneId);
	log.warn("graceful agent exit: timed out, proceeding to kill", { taskId, timeoutMs, elapsedMs, stillRunning, evidence: final ? "read" : "unreadable" });
	return { kind: "timed-out", elapsedMs, panes: asked.length, stillRunning };
}
