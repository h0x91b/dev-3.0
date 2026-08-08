import { realpathSync } from "node:fs";
import { createLogger } from "./logger";
import { buildProcessTree, collectDescendants, collectProcessInfo } from "./port-scanner";
import { terminatePidsVerified } from "./process-reaper";
import { spawn } from "./spawn";

const log = createLogger("worktree-reaper");

const REAP_TERM_GRACE_MS = 1500;
const REAP_KILL_WAIT_MS = 2000;

/**
 * Every process of this user with its cwd, from ONE `lsof` call.
 *
 * Per-PID `lsof -a -p <pid> -d cwd` (what {@link getPidCwd} does) costs a spawn
 * each; the teardown needs the whole table, so it takes one ~0.5s snapshot of
 * ~900 processes instead of 900 spawns. Output is `-F pn`: a `p<pid>` line
 * followed by the `n<path>` line for its cwd. `ps -o` cannot substitute — cwd
 * is not a ps field, and env/args inspection is blocked for foreign PIDs under
 * the packaged `.app` hardened runtime (see decision 095).
 */
export async function listPidCwds(): Promise<Map<number, string>> {
	try {
		const proc = spawn(["lsof", "-a", "-d", "cwd", "-F", "pn"], { stdout: "pipe", stderr: "pipe" });
		const [output] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return parsePidCwds(output);
	} catch {
		return new Map();
	}
}

/** Parse `lsof -a -d cwd -F pn` output. Exported for tests. */
export function parsePidCwds(output: string): Map<number, string> {
	const cwds = new Map<number, string>();
	let pid: number | null = null;
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) {
			const parsed = parseInt(line.slice(1), 10);
			pid = isNaN(parsed) ? null : parsed;
		} else if (line.startsWith("n") && pid !== null) {
			const cwd = line.slice(1).trim();
			if (cwd) cwds.set(pid, cwd);
			pid = null;
		}
	}
	return cwds;
}

function isUnder(cwd: string, root: string): boolean {
	return cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * PIDs whose cwd sits inside `roots`, minus `protectedPids`. Pure, for tests.
 */
export function selectCwdHolders(
	cwds: Map<number, string>,
	roots: string[],
	protectedPids: Set<number>,
): number[] {
	const holders: number[] = [];
	for (const [pid, cwd] of cwds) {
		if (protectedPids.has(pid)) continue;
		if (roots.some((root) => isUnder(cwd, root))) holders.push(pid);
	}
	return holders;
}

/**
 * Never reap the app's own tree, nor the tmux server: tmux inherits its cwd
 * from whoever started the server, so a server launched from inside a worktree
 * would match the cwd filter — and killing it takes down EVERY task's terminal.
 */
export function selectProtectedPids(
	tree: Map<number, number[]>,
	cmdlines: Map<number, string>,
	selfPid: number = process.pid,
): Set<number> {
	const parents = new Map<number, number>();
	for (const [ppid, children] of tree) {
		for (const child of children) parents.set(child, ppid);
	}
	const promoted = new Set<number>([selfPid]);
	for (let pid = parents.get(selfPid); pid !== undefined && pid > 1 && !promoted.has(pid); pid = parents.get(pid)) {
		promoted.add(pid);
	}
	for (const pid of [...promoted]) {
		for (const descendant of collectDescendants(pid, tree)) promoted.add(descendant);
	}
	for (const [pid, cmdline] of cmdlines) {
		if (/(^|\/)tmux(\s|$)/.test(cmdline)) promoted.add(pid);
	}
	return promoted;
}

/**
 * Evict every process still living inside a task worktree, right before the
 * directory is deleted (or the task is frozen).
 *
 * The teardown chain only ever killed what it could trace: the task's tmux/native
 * tree, and dev-server children found by ppid walk or pool-port ownership. A
 * daemon an agent started that double-forks (`agent-browser`, watchers, MCP
 * servers, language servers) is reparented to init, holds no pool port, and so
 * survived every step — the worktree got unlinked underneath it and the process
 * ran forever. 18 orphaned `agent-browser` daemons from long-completed tasks,
 * each holding a headless Chromium, were found burning ~176% CPU. Ownership is
 * by cwd: whatever runs inside a worktree that is about to disappear is ours.
 *
 * Best-effort by design — a survivor is logged, never an abort. Blocking a
 * completion on one stubborn foreign process would be worse than the leak.
 */
export async function reapWorktreeProcesses(
	worktreePath: string | null | undefined,
	label: string,
): Promise<{ reaped: number[]; leftovers: number[] }> {
	if (!worktreePath) return { reaped: [], leftovers: [] };

	// lsof resolves symlinks in cwd paths (e.g. /tmp → /private/tmp), so match
	// against both spellings of the root.
	const roots = [worktreePath];
	try {
		const resolved = realpathSync(worktreePath);
		if (resolved !== worktreePath) roots.push(resolved);
	} catch {
		// Worktree already gone — the raw path still matches held cwds.
	}

	const [cwds, info] = await Promise.all([listPidCwds(), collectProcessInfo()]);
	const protectedPids = selectProtectedPids(info.tree, info.cmdlines);
	const holders = selectCwdHolders(cwds, roots, protectedPids);
	if (holders.length === 0) return { reaped: [], leftovers: [] };

	const targets = new Set(holders);
	const tree = await buildProcessTree();
	for (const pid of holders) {
		for (const descendant of collectDescendants(pid, tree)) {
			if (!protectedPids.has(descendant)) targets.add(descendant);
		}
	}
	const pids = [...targets];
	log.warn("Reaping processes left inside the task worktree", {
		label,
		worktreePath,
		pids,
		commands: holders.map((pid) => info.cmdlines.get(pid)?.slice(0, 120) ?? "?"),
	});

	const leftovers = await terminatePidsVerified(pids, {
		termGraceMs: REAP_TERM_GRACE_MS,
		killWaitMs: REAP_KILL_WAIT_MS,
	});
	if (leftovers.length > 0) {
		log.error("Worktree processes survived SIGKILL", { label, worktreePath, leftovers });
	}
	return { reaped: pids, leftovers };
}
