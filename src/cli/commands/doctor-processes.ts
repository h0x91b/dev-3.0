/**
 * `dev3 doctor --processes` — read-only inventory of native terminal processes
 * (seq 1383).
 *
 * The answer to "which dev3 task owns THIS pid" on the one platform whose
 * process viewer cannot show it: macOS Activity Monitor lists every host as the
 * bare executable basename, and Windows Task Manager's image-name column does
 * the same. This command gives the same identity the host already carries in its
 * argv0, from the on-disk session records, with no app and no socket.
 *
 * DELIBERATELY NARROW OUTPUT: task seq, logical pane, role, pid + parent,
 * executable basename, and liveness. Never a title, prompt, worktree path,
 * token, endpoint, or raw command line — this output lands in bug reports.
 *
 * Strictly read-only: it lists, parses, and probes liveness with signal 0. It
 * never writes, removes, migrates, or signals anything.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRecord } from "../../bun/native-terminal-registry/record";
import { isValidSessionId, sessionsRootDir } from "../../bun/native-terminal-registry/paths";
import { paneIdFromSessionId } from "../../bun/native-terminal-registry/process-naming";

/** Alive = answers signal 0; stale = record outlived its process; unknown = unreadable. */
export type NativeProcessState = "alive" | "stale" | "unknown";

export type NativeProcessRole = "host" | "shell";

export interface NativeProcessRow {
	sessionId: string;
	/** Human task number, or null for a session started outside a task. */
	seq: string | null;
	/** Logical pane id (`pane-1`), or null when the session id carries none. */
	paneId: string | null;
	role: NativeProcessRole;
	pid: number | null;
	/** The owning host's pid; null on the host row itself (it is detached). */
	parentPid: number | null;
	/** Executable BASENAME only — never a full path. */
	executable: string | null;
	state: NativeProcessState;
}

/** Everything this command touches outside itself, injectable for tests. */
export interface ProcessInventoryDeps {
	sessionsDir: string;
	listDirs: (dir: string) => string[];
	readFile: (path: string) => string;
	isAlive: (pid: number) => boolean;
}

export function realProcessInventoryDeps(sessionsDir: string = sessionsRootDir()): ProcessInventoryDeps {
	return {
		sessionsDir,
		listDirs: (dir) =>
			readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name),
		readFile: (path) => readFileSync(path, "utf8"),
		isAlive: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (err) {
				// EPERM means it exists and belongs to someone else — still alive.
				return (err as NodeJS.ErrnoException)?.code === "EPERM";
			}
		},
	};
}

/** Last path segment of an executable, with no assumption about the separator. */
function executableName(path: string | undefined): string | null {
	if (!path) return null;
	const segments = path.replaceAll("\\", "/").split("/");
	return segments[segments.length - 1] || null;
}

/**
 * Every discoverable native session as one host row plus one shell row, sorted
 * by task number then pane so the same task's processes sit together.
 */
export function collectNativeProcesses(deps: ProcessInventoryDeps): NativeProcessRow[] {
	let sessionIds: string[];
	try {
		sessionIds = deps.listDirs(deps.sessionsDir).filter(isValidSessionId);
	} catch {
		return []; // no native session root yet — nothing to report, not a failure
	}
	const rows: NativeProcessRow[] = [];
	for (const sessionId of sessionIds.sort()) {
		let record: ReturnType<typeof parseRecord> = null;
		try {
			record = parseRecord(deps.readFile(join(deps.sessionsDir, sessionId, "record.json")));
		} catch {
			record = null;
		}
		if (!record) {
			// A session directory we cannot interpret: say so instead of hiding it —
			// "unknown" and "nothing here" are very different answers to the user.
			rows.push({
				sessionId,
				seq: null,
				paneId: null,
				role: "host",
				pid: null,
				parentPid: null,
				executable: null,
				state: "unknown",
			});
			continue;
		}
		const seq = record.identity?.seq ?? null;
		// A record written before seq 1383 has no identity block, but its session id
		// still ends in the pane it belongs to — so say which pane rather than "—".
		const paneId = record.identity?.paneId ?? paneIdFromSessionId(sessionId);
		const hostAlive = deps.isAlive(record.host.pid);
		rows.push({
			sessionId,
			seq,
			paneId,
			role: "host",
			pid: record.host.pid,
			parentPid: null,
			executable: executableName(record.host.executable),
			state: hostAlive ? "alive" : "stale",
		});
		rows.push({
			sessionId,
			seq,
			paneId,
			role: "shell",
			pid: record.shell.pid,
			parentPid: record.host.pid,
			executable: executableName(record.shell.command[0]),
			state: deps.isAlive(record.shell.pid) ? "alive" : "stale",
		});
	}
	return rows.sort(compareRows);
}

/** Numeric-aware ordering: seq, then variant, then pane, then host before shell. */
function compareRows(a: NativeProcessRow, b: NativeProcessRow): number {
	const bySeq = seqSortKey(a.seq) - seqSortKey(b.seq);
	if (bySeq !== 0) return bySeq;
	const bySession = a.sessionId.localeCompare(b.sessionId);
	if (bySession !== 0) return bySession;
	return a.role === b.role ? 0 : a.role === "host" ? -1 : 1;
}

function seqSortKey(seq: string | null): number {
	if (!seq) return Number.MAX_SAFE_INTEGER; // unidentified sessions sort last
	const [main = "0", variant = "0"] = seq.split("-");
	return Number(main) * 1000 + Number(variant);
}

const STATE_MARK: Record<NativeProcessState, string> = { alive: "●", stale: "○", unknown: "?" };

export function renderNativeProcesses(rows: NativeProcessRow[]): string {
	if (rows.length === 0) return "No native terminal sessions on this machine.\n";
	const header = ["", "TASK", "PANE", "ROLE", "PID", "PARENT", "EXECUTABLE", "STATE"];
	const body = rows.map((row) => [
		STATE_MARK[row.state],
		row.seq ? `seq:${row.seq}` : "—",
		row.paneId ?? "—",
		row.role,
		row.pid === null ? "—" : String(row.pid),
		row.parentPid === null ? "—" : String(row.parentPid),
		row.executable ?? "—",
		row.state,
	]);
	const widths = header.map((_, column) =>
		Math.max(header[column]!.length, ...body.map((cells) => cells[column]!.length)),
	);
	const line = (cells: string[]): string =>
		cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
	return [line(header), ...body.map(line), ""].join("\n");
}
