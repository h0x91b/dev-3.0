/**
 * Bind a message to one agent PROCESS (a self-reminder's author, an `--agent`
 * address, a sender awaiting a reply), so a multi-agent task never delivers it to
 * the focused sibling or to the shell an exited agent left behind. Why:
 * decisions/2026/10/06/scheduled-self-reminder-author-binding.md and
 * decisions/2026/10/26/agent-addressed-messages-and-replies.md.
 */

import type { ScheduledMessageAuthor, Task } from "../shared/types";
import { pinTaskPane } from "./pane-input";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { collectProcessInfo } from "./port-scanner";
import { isSameAgentProcess, readAgentProcessSignature } from "./agent-process-signature";
import { NATIVE_AGENT_PANE_ID } from "./agent-prompt-native";
import { nativeTaskPanesState } from "./native-task-panes";
import { DEFAULT_TMUX_SOCKET, PANE_ID_PID_FORMAT, taskSessionName, tmux } from "./tmux";

export type AuthorPaneResolution = { ok: true; paneId: string } | { ok: false; detail: string };

/**
 * An agent identity, or why none can be proven. `unsupported` and `no-agent` are
 * answers; `unknown` means a probe failed and says nothing about the agent.
 */
export type AgentIdentity =
	| { ok: true; author: ScheduledMessageAuthor }
	| { ok: false; reason: "unsupported" | "no-agent" | "unknown"; detail: string };

/** Why nothing is captured on Windows: the identity is `pid@start`, and only `ps` or `/proc` read that today. */
export const AGENT_IDENTITY_UNSUPPORTED_DETAIL = "agent identity cannot be verified on Windows yet";

const SCRIPT_RUNTIMES = new Set(["node", "bun", "deno", "python", "python3"]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell"]);
const MAX_ANCESTRY = 64;

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

function unproven(reason: "unsupported" | "no-agent" | "unknown", detail: string): AgentIdentity {
	return { ok: false, reason, detail };
}

/** The recorded entry of `paneId`; a native main agent is recorded without a pane id, as the first entry, unless parked (a woken plain shell). */
function entryFor(task: Task, paneId: string) {
	const panes = task.sessionState?.panes ?? [];
	const exact = panes.find((p) => p.paneId === paneId);
	if (exact || taskTerminalBackendIdentity(task) !== "native" || paneId !== NATIVE_AGENT_PANE_ID) return exact;
	return panes[0]?.paneId || panes[0]?.parked ? undefined : panes[0];
}

/** Start signature of the native main pane's root process: a restart gets a new root, an exit into the handed-over shell keeps it. */
async function nativeMainGeneration(task: Task, paneId: string, root: PaneRoot): Promise<string> {
	if (taskTerminalBackendIdentity(task) !== "native" || paneId !== NATIVE_AGENT_PANE_ID) return "";
	return readAgentProcessSignature(root.rootPid);
}

/** `withGeneration`: read the native root's start signature too, for callers that store or compare it. */
async function identityOf(task: Task, paneId: string, root: PaneRoot, agentPid: number, withGeneration: boolean): Promise<AgentIdentity> {
	const agentProcess = await readAgentProcessSignature(agentPid);
	if (!agentProcess) return unproven("unknown", "the agent process ended while it was being identified");
	const sessionId = entryFor(task, paneId)?.sessionId ?? null;
	const paneGeneration = withGeneration ? await nativeMainGeneration(task, paneId, root) : "";
	return { ok: true, author: { paneId, sessionId, paneToken: root.paneToken, agentProcess, ...(paneGeneration ? { paneGeneration } : {}) } };
}

/** The agent that ran a `dev3` command from `paneId` (the CLI's own pid), or why none can be proven. */
export async function captureSenderAgent(
	task: Task,
	paneId: string | null | undefined,
	cliPid: number | null | undefined,
	options: { generation?: boolean } = {},
): Promise<AgentIdentity> {
	if (process.platform === "win32") return unproven("unsupported", AGENT_IDENTITY_UNSUPPORTED_DETAIL);
	const pane = paneId?.trim();
	if (!pane || !cliPid || !Number.isInteger(cliPid)) {
		return unproven("no-agent", "dev3 was not run from a task terminal pane, so there is no sending agent");
	}
	const root = await paneRoot(task, pane);
	if (!root) return unproven("unknown", `the sender's pane ${pane} could not be found`);
	const agentPid = agentAncestor(await processTable(), cliPid, root.rootPid);
	if (!agentPid) {
		return unproven("no-agent", "no agent process runs dev3 here (a shell in the pane, or an agent started through a wrapper script)");
	}
	return identityOf(task, pane, root, agentPid, options.generation === true);
}

/** Record the agent that ran `dev3 message` from `paneId`, or null when no agent can be proven. */
export async function captureScheduledMessageAuthor(
	task: Task,
	paneId: string | null | undefined,
	cliPid: number | null | undefined,
): Promise<ScheduledMessageAuthor | null> {
	const captured = await captureSenderAgent(task, paneId, cliPid, { generation: true });
	return captured.ok ? captured.author : null;
}

/**
 * The agent running in `paneId` right now: the non-shell child of its launch
 * script, or the same agent started again by hand in the shell it handed over to.
 * `no-agent` only on proof, that shell running no such agent; a setup script
 * still running or a failed `ps` is `unknown`.
 */
export async function readPaneAgentIdentity(task: Task, paneId: string, options: { generation?: boolean } = {}): Promise<AgentIdentity> {
	if (process.platform === "win32") return unproven("unsupported", AGENT_IDENTITY_UNSUPPORTED_DETAIL);
	const root = await paneRoot(task, paneId);
	if (!root) return unproven("unknown", `pane ${paneId} could not be read`);
	const table = await processTable();
	if (!table.cmdlines.has(root.rootPid)) return unproven("unknown", "the process table could not be read");
	if (isHandedOverShell(table, root.rootPid)) {
		const relaunched = relaunchedAgentPid(task, paneId, table, root.rootPid);
		if (!relaunched) return unproven("no-agent", `the agent in pane ${paneId} has exited`);
		return identityOf(task, paneId, root, relaunched, options.generation === true);
	}
	const agentPid = (table.childrenOf.get(root.rootPid) ?? []).find((pid) => !isShell(table, pid));
	if (!agentPid) return unproven("unknown", `no agent process is running in pane ${paneId} yet`);
	return identityOf(task, paneId, root, agentPid, options.generation === true);
}

/**
 * Does `paneId` run an agent right now — a live non-shell child of its launch script?
 * A bare shell at the root is what an exited agent leaves: whatever runs in it, a dev
 * server or the agent started again by hand, is not the agent a message may follow.
 */
async function paneRunsAgent(task: Task, paneId: string): Promise<PaneRoot | null> {
	const root = await paneRoot(task, paneId);
	if (!root) return null;
	const table = await processTable();
	if (!table.cmdlines.has(root.rootPid) || isHandedOverShell(table, root.rootPid)) return null;
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
		// A pane whose root is a bare interactive shell is a shell once its agent has ended: an agent
		// pane's root is its launch script. Only the same agent started there again by hand counts.
		if (isHandedOverShell(table, root.rootPid)) {
			if (relaunchedAgentPid(task, paneId, table, root.rootPid)) live.push(paneId);
			continue;
		}
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

function binaryName(word: string | undefined): string {
	return (word?.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
}

/**
 * The agent the user started again by hand in the shell an exited agent left
 * behind: a child of that shell running the binary dev3 launched in this pane
 * (`claude`, or `node …/codex`). Any other program there is not the agent.
 */
function relaunchedAgentPid(task: Task, paneId: string, table: ProcessTable, rootPid: number): number | null {
	const launched = binaryName(task.sessionState?.panes.find((p) => p.paneId === paneId)?.agentCmd?.trim().split(/\s+/)[0]);
	if (!launched || SHELLS.has(launched)) return null;
	for (const pid of table.childrenOf.get(rootPid) ?? []) {
		const [exe, script] = (table.cmdlines.get(pid)?.trim().split(/\s+/) ?? []).map(binaryName);
		if (exe === launched || (SCRIPT_RUNTIMES.has(exe ?? "") && script === launched)) return pid;
	}
	return null;
}

/**
 * The task's MAIN agent, seen through the shell that outlives it (`keepShell`).
 * `exited` is proof, not absence of evidence: the pane's launch script has been
 * replaced by the interactive shell it hands over to only after the agent ends,
 * and that shell runs no agent the user started again by hand.
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
	if (isHandedOverShell(table, root.rootPid)) return relaunchedAgentPid(task, paneId, table, root.rootPid) ? "alive" : "exited";
	return (table.childrenOf.get(root.rootPid) ?? []).some((pid) => !isShell(table, pid)) ? "alive" : "unknown";
}

/**
 * The pane the author lives in now, or a refusal. The recorded agent process still
 * running proves it outright. If it is gone, the only other acceptable answer is the
 * same conversation resumed somewhere NEW (another pane or tmux server) and running
 * an agent there; the same pane on the same server means the agent exited and what
 * is left is a shell. On native only the main agent can be found again: see
 * {@link resolveNativeMainAuthor}.
 */
export async function resolveScheduledMessageAuthorPane(task: Task, author: ScheduledMessageAuthor): Promise<AuthorPaneResolution> {
	if (process.platform === "win32") return { ok: false, detail: `${AGENT_IDENTITY_UNSUPPORTED_DETAIL}; not sent to another pane` };
	const who = `the addressed agent (pane ${author.paneId}${author.sessionId ? `, session ${author.sessionId.slice(0, 8)}` : ""})`;
	const gone: AuthorPaneResolution = { ok: false, detail: `${who} is no longer running in this task; not sent to another pane` };

	if (await isSameAgentProcess(author.agentProcess)) {
		const root = await paneRoot(task, author.paneId);
		if (root && root.paneToken === author.paneToken) return { ok: true, paneId: author.paneId };
		return gone;
	}

	if (taskTerminalBackendIdentity(task) === "native") return resolveNativeMainAuthor(task, author, gone);
	if (!author.sessionId) return gone;
	const matches = (task.sessionState?.panes ?? []).filter((p) => p.sessionId === author.sessionId && p.paneId);
	if (matches.length > 1) return { ok: false, detail: `${who} matches several panes; not guessing` };
	const candidate = matches[0]?.paneId;
	if (!candidate) return gone;
	const live = await paneRunsAgent(task, candidate);
	if (!live) return gone;
	const moved = candidate !== author.paneId || live.paneToken !== author.paneToken;
	return moved ? { ok: true, paneId: candidate } : gone;
}

/**
 * A native pane keeps its registry session id across a restart, so the generation
 * is the start signature of its root process: a resumed main agent runs under a new
 * root, an agent that exited leaves its shell under the same one. Only the main
 * agent (pane-1, recorded as the first `sessionState` entry) is rebound, and only
 * to the same conversation; anything recorded without a generation is dropped.
 */
async function resolveNativeMainAuthor(task: Task, author: ScheduledMessageAuthor, gone: AuthorPaneResolution): Promise<AuthorPaneResolution> {
	if (author.paneId !== NATIVE_AGENT_PANE_ID || !author.sessionId || !author.paneGeneration) return gone;
	if (entryFor(task, NATIVE_AGENT_PANE_ID)?.sessionId !== author.sessionId) return gone;
	const root = await paneRunsAgent(task, NATIVE_AGENT_PANE_ID);
	if (!root) return gone;
	const current = await readAgentProcessSignature(root.rootPid);
	// Compared by pid: a signature string alone can differ for the same process (lstart is local time).
	const was = rootPidOf(author.paneGeneration);
	return current && Number.isInteger(was) && rootPidOf(current) !== was ? { ok: true, paneId: NATIVE_AGENT_PANE_ID } : gone;
}

const rootPidOf = (signature: string): number => Number.parseInt(signature.split("@")[0] ?? "", 10);
