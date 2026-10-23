/**
 * Bind a self-reminder to the agent PROCESS that scheduled it, so a multi-agent
 * task does not fire it into the focused sibling or into the shell an exited agent
 * left behind. Why: decisions/2026/10/06/scheduled-self-reminder-author-binding.md.
 */

import type { ScheduledMessageAuthor, Task } from "../shared/types";
import { pinTaskPane } from "./pane-input";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { collectProcessInfo } from "./port-scanner";
import { spawn } from "./spawn";
import { NATIVE_AGENT_PANE_ID } from "./agent-prompt-native";
import { nativeTaskPanesState } from "./native-task-panes";
import { DEFAULT_TMUX_SOCKET, PANE_ID_PID_FORMAT, taskSessionName, tmux } from "./tmux";

export type AuthorPaneResolution = { ok: true; paneId: string } | { ok: false; detail: string };

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell"]);
const MAX_ANCESTRY = 64;

/** `pid@<ps lstart>`: a recycled pid has a different start time, so it never matches. "" when gone. */
async function readProcessStartSignature(pid: number): Promise<string> {
	if (!Number.isInteger(pid) || pid <= 0) return "";
	try {
		const proc = spawn(["ps", "-p", String(pid), "-o", "lstart="], { stdout: "pipe", stderr: "ignore" });
		const [raw, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const start = raw.trim().replace(/\s+/g, " ");
		return exitCode === 0 && start ? `${pid}@${start}` : "";
	} catch {
		return "";
	}
}

type ProcessTable = { parentOf: Map<number, number>; childrenOf: Map<number, number[]>; cmdlines: Map<number, string> };

async function processTable(): Promise<ProcessTable> {
	// Fresh, never the 5 s poller cache: the CLI asking us may be younger than it.
	const { tree, cmdlines } = await collectProcessInfo({ maxAgeMs: 0 });
	const parentOf = new Map<number, number>();
	for (const [ppid, children] of tree) for (const pid of children) parentOf.set(pid, ppid);
	return { parentOf, childrenOf: tree, cmdlines };
}

function isShell(table: ProcessTable, pid: number): boolean {
	const exe = table.cmdlines.get(pid)?.split(/\s+/)[0] ?? "";
	const name = (exe.split(/[\\/]/).pop() ?? "").replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase();
	return SHELLS.has(name);
}

/**
 * The process an agent pane runs: the direct child of the pane's root (the launch
 * script) on the CLI's ancestry. It must not be a shell, and a shell must sit
 * between it and the CLI — that is an agent's tool call. A human typing in a shell
 * split has no such process, so nothing is captured and routing stays task-level.
 */
function agentAncestor(table: ProcessTable, cliPid: number, rootPid: number): number | null {
	const between: number[] = [];
	let pid = cliPid;
	for (let i = 0; i < MAX_ANCESTRY; i++) {
		const parent = table.parentOf.get(pid);
		if (parent === undefined || parent <= 1) return null;
		if (parent === rootPid) break;
		between.push(pid);
		pid = parent;
	}
	if (table.parentOf.get(pid) !== rootPid || pid === cliPid || isShell(table, pid)) return null;
	return between.slice(1).some((p) => isShell(table, p)) ? pid : null;
}

type PaneRoot = { rootPid: number; paneToken: string };

/** The pane's root pid and its generation token: tmux server token, or the native registry session id. */
async function paneRoot(task: Task, paneId: string): Promise<PaneRoot | null> {
	if (taskTerminalBackendIdentity(task) === "native") {
		const pane = (await nativeTaskPanesState(task.id))?.panes.find((p) => p.paneId === paneId);
		return pane?.alive && pane.shellPid > 0 ? { rootPid: pane.shellPid, paneToken: pane.sessionId } : null;
	}
	const pin = await pinTaskPane(task, paneId);
	if (!pin.ok || pin.incarnation.backend !== "tmux") return null;
	const rows = await tmux.listPanes(PANE_ID_PID_FORMAT, {
		target: taskSessionName(task.id),
		scope: "session",
		socket: task.tmuxSocket ?? DEFAULT_TMUX_SOCKET,
	}).catch(() => []);
	const rootPid = rows.find((row) => row.paneId === paneId)?.panePid ?? 0;
	return rootPid > 0 ? { rootPid, paneToken: pin.incarnation.serverToken } : null;
}

/** Record the agent that ran `dev3 message` from `paneId`, or null when no agent can be proven. */
export async function captureScheduledMessageAuthor(
	task: Task,
	paneId: string | null | undefined,
	cliPid: number | null | undefined,
): Promise<ScheduledMessageAuthor | null> {
	const pane = paneId?.trim();
	if (!pane || !cliPid || !Number.isInteger(cliPid) || process.platform === "win32") return null;
	const root = await paneRoot(task, pane);
	if (!root) return null;
	const agentPid = agentAncestor(await processTable(), cliPid, root.rootPid);
	if (!agentPid) return null;
	const agentProcess = await readProcessStartSignature(agentPid);
	if (!agentProcess) return null;
	const sessionId = task.sessionState?.panes.find((p) => p.paneId === pane)?.sessionId ?? null;
	return { paneId: pane, sessionId, paneToken: root.paneToken, agentProcess };
}

function signaturePid(signature: string): number {
	return Number.parseInt(signature.split("@")[0] ?? "", 10);
}

/** Does `paneId` run an agent right now — a live non-shell child of its launch script? */
async function paneRunsAgent(task: Task, paneId: string): Promise<PaneRoot | null> {
	const root = await paneRoot(task, paneId);
	if (!root) return null;
	const table = await processTable();
	return (table.childrenOf.get(root.rootPid) ?? []).some((pid) => !isShell(table, pid)) ? root : null;
}

/**
 * The panes of the task that run an agent right now, or null when that cannot be told.
 * Candidates come from the backend: tmux, the recorded agent panes that still exist;
 * native, every live pane the coordinator knows (extra agents are not recorded in
 * `sessionState`). A pane counts when its launch script has a non-shell child; a stale
 * record and a shell split (even one running a program) never do. Windows has no process table: there
 * only a lone coordinator pane is provably the agent.
 */
export async function liveAgentPaneIds(task: Task): Promise<string[] | null> {
	const native = taskTerminalBackendIdentity(task) === "native";
	let candidates: string[];
	if (native) {
		const state = await nativeTaskPanesState(task.id);
		if (!state) return null;
		candidates = state.panes.filter((pane) => pane.alive).map((pane) => pane.paneId);
	} else {
		const recorded = task.sessionState?.panes ?? [];
		if (recorded.some((pane) => !pane.paneId)) return null;
		candidates = recorded.map((pane) => pane.paneId as string);
	}
	if (process.platform === "win32") {
		return native && candidates.length === 1 && candidates[0] === NATIVE_AGENT_PANE_ID ? candidates : null;
	}
	const table = await processTable();
	const live: string[] = [];
	for (const paneId of new Set(candidates)) {
		const root = await paneRoot(task, paneId);
		if (!root) continue;
		if (!table.cmdlines.has(root.rootPid)) return null; // `ps` failed or raced the pane
		// A pane whose root is a bare interactive shell is a shell, whatever it runs: an agent pane's
		// root is its launch script, which only becomes such a shell once the agent has ended.
		if (isHandedOverShell(table, root.rootPid)) continue;
		if ((table.childrenOf.get(root.rootPid) ?? []).some((pid) => !isShell(table, pid))) live.push(paneId);
	}
	return live;
}

/** What the keep-alive watchdog may conclude about a task's main agent. */
export type MainAgentLiveness = "alive" | "exited" | "unknown";

/** A bare interactive shell: what the launch script `exec`s once its agent has ended. */
function isHandedOverShell(table: ProcessTable, pid: number): boolean {
	const words = table.cmdlines.get(pid)?.trim().split(/\s+/) ?? [];
	return words.length === 1 && isShell(table, pid);
}

/**
 * The task's MAIN agent, seen through the shell that outlives it (`keepShell`).
 * `exited` is proof, not absence of evidence: the pane's launch script has been
 * replaced by the interactive shell it hands over to only after the agent ends.
 * Anything a probe cannot establish — no pane id, tmux or `ps` failing, a setup
 * script still running, Windows (no `ps`) — is `unknown`, because the watchdog
 * tears the terminal down on `exited`.
 */
export async function taskMainAgentLiveness(task: Task): Promise<MainAgentLiveness> {
	if (process.platform === "win32") return "unknown";
	const paneId = task.sessionState?.panes?.[0]?.paneId?.trim();
	if (!paneId) return "unknown";
	const root = await paneRoot(task, paneId);
	if (!root) return "unknown";
	const table = await processTable();
	if (!table.cmdlines.has(root.rootPid)) return "unknown"; // `ps` failed, timed out, or raced the pane
	if (isHandedOverShell(table, root.rootPid)) return "exited";
	return (table.childrenOf.get(root.rootPid) ?? []).some((pid) => !isShell(table, pid)) ? "alive" : "unknown";
}

/**
 * The pane the author lives in now, or a refusal. The recorded agent process still
 * running proves it outright. If it is gone, the only other acceptable answer is the
 * same conversation resumed somewhere NEW (another pane or tmux server) and running
 * an agent there; the same pane on the same server means the agent exited and what
 * is left is a shell.
 */
export async function resolveScheduledMessageAuthorPane(task: Task, author: ScheduledMessageAuthor): Promise<AuthorPaneResolution> {
	const who = `the agent that scheduled it (pane ${author.paneId}${author.sessionId ? `, session ${author.sessionId.slice(0, 8)}` : ""})`;
	const gone: AuthorPaneResolution = { ok: false, detail: `${who} is no longer running in this task; not sent to another pane` };

	const pid = signaturePid(author.agentProcess);
	const current = await readProcessStartSignature(pid);
	if (current && current === author.agentProcess) {
		const root = await paneRoot(task, author.paneId);
		if (root && root.paneToken === author.paneToken) return { ok: true, paneId: author.paneId };
		return gone;
	}

	if (!author.sessionId || taskTerminalBackendIdentity(task) !== "tmux") return gone;
	const matches = (task.sessionState?.panes ?? []).filter((p) => p.sessionId === author.sessionId && p.paneId);
	if (matches.length > 1) return { ok: false, detail: `${who} matches several panes; not guessing` };
	const candidate = matches[0]?.paneId;
	if (!candidate) return gone;
	const live = await paneRunsAgent(task, candidate);
	if (!live) return gone;
	const moved = candidate !== author.paneId || live.paneToken !== author.paneToken;
	return moved ? { ok: true, paneId: candidate } : gone;
}
