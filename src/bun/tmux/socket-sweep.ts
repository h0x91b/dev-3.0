/**
 * The IO shell around {@link selectSweepableSockets}: read the socket directory,
 * ask each candidate socket whether anything is listening, unlink what the pure
 * decision allows.
 *
 * WHY A CONNECT PROBE AND NOT THE PROCESS TABLE. The obvious check is to look for
 * `tmux: server (/tmp/tmux-501/<name>)` in `ps`, and the fixtures in
 * `terminal-e2e-guard.test.ts` assume that string exists. MEASURED on macOS 15:
 * it does not. A live tmux server appears in `ps -Ao pid=,command=` as the single
 * word `tmux`, with no socket path anywhere, so a ps-based sweep sees ZERO live
 * servers and would have deleted the socket of the app's own running server. A
 * connect() to the socket answers the question directly instead: listening, or
 * nothing there. Verified against a live 54-session dev3 server (still 54
 * sessions afterwards) and against real leftover files.
 *
 * Split from socket-files.ts on purpose — that module has no dependencies beyond
 * node:fs, so a renderer test can import the unlink helper without dragging in
 * the logger, the spawn wrapper, or the tmux binary's module-load side effects.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { createLogger } from "../logger";
import {
	type SocketFileFacts,
	type SocketLiveness,
	isSweepCandidate,
	selectSweepableSockets,
	tmuxSocketDir,
} from "./socket-files";

const log = createLogger("tmux");

const PROBE_TIMEOUT_MS = 300;
const PROBE_BATCH = 32;

/**
 * Is anything listening on this unix socket? A dead tmux socket answers ENOENT
 * or ECONNREFUSED depending on the platform; every other outcome — a timeout, a
 * permission error — is `unknown`, which keeps the file.
 */
export function probeSocketLiveness(path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<SocketLiveness> {
	return new Promise((resolve) => {
		const socket = net.connect({ path });
		const done = (verdict: SocketLiveness): void => {
			socket.removeAllListeners();
			try {
				socket.destroy();
			} catch {
				// already gone
			}
			resolve(verdict);
		};
		socket.setTimeout(timeoutMs, () => done("unknown"));
		socket.once("connect", () => done("listening"));
		socket.once("error", (err: NodeJS.ErrnoException) => {
			done(err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "dead" : "unknown");
		});
	});
}

type RawFacts = Omit<SocketFileFacts, "liveness">;

function readSocketFiles(dir: string): RawFacts[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const files: RawFacts[] = [];
	for (const name of names) {
		try {
			const stat = statSync(join(dir, name));
			files.push({ name, uid: stat.uid, mtimeMs: stat.mtimeMs, isSocket: stat.isSocket() });
		} catch {
			// Vanished between readdir and stat, or unreadable — leave it alone.
		}
	}
	return files;
}

export interface SweepResult {
	readonly removed: number;
	readonly kept: number;
}

/**
 * Remove dev3-prefixed socket files with nothing listening on them. Runs once at
 * startup; best-effort by construction, since every failure mode is "one stale
 * file stays on disk".
 */
export async function sweepDeadTmuxSockets(): Promise<SweepResult> {
	if (process.platform === "win32") return { removed: 0, kept: 0 };
	const dir = tmuxSocketDir();
	const raw = readSocketFiles(dir);
	const ourUid = process.getuid?.() ?? -1;
	const nowMs = Date.now();
	// Only candidates are probed: prefix, ownership and age are free, a connect is
	// not. Batched, because a first sweep on a machine that has been leaking for
	// months has over a thousand of them and each probe holds a descriptor.
	const files: SocketFileFacts[] = [];
	for (let i = 0; i < raw.length; i += PROBE_BATCH) {
		const batch = raw.slice(i, i + PROBE_BATCH);
		files.push(
			...(await Promise.all(
				batch.map(async (file) => ({
					...file,
					liveness: isSweepCandidate(file, ourUid, nowMs)
						? await probeSocketLiveness(join(dir, file.name))
						: ("unknown" as SocketLiveness),
				})),
			)),
		);
	}
	const decision = selectSweepableSockets({ files, ourUid, nowMs });
	let removed = 0;
	for (const name of decision.remove) {
		try {
			unlinkSync(join(dir, name));
			removed += 1;
		} catch {
			// Another instance swept it first, or it is not ours to remove.
		}
	}
	if (removed > 0) log.info("swept dead tmux socket files", { dir, removed, kept: decision.kept });
	return { removed, kept: decision.kept };
}
