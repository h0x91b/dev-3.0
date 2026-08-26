/**
 * The tmux socket FILE, as opposed to the tmux server behind it.
 *
 * tmux leaves the socket file on disk when its server dies, and `kill-server`
 * does not unlink it. Every pid-keyed socket name (`dev3-live-test-<pid>`) is
 * therefore one file that never goes away — 1353 of them accumulated on the
 * maintainer's machine behind a single live server before this module existed.
 *
 * dev3 does not compose the socket directory anywhere else: the client always
 * passes `-L <name>` and tmux resolves the directory itself. This is the one
 * place that mirrors that resolution, and it is read-only about it — nothing
 * here sets TMUX_TMPDIR or renames anything.
 */
import { unlinkSync } from "node:fs";
import { join } from "node:path";

/** Only files with this prefix are ever swept. Never widen it. */
export const SWEEP_SOCKET_PREFIX = "dev3-";

/**
 * A socket younger than this is left alone even when nothing answers on it: a
 * server that has just been asked for may not have finished binding.
 */
export const SWEEP_MIN_AGE_MS = 60_000;

/**
 * Where tmux puts `-L <name>`: `$TMUX_TMPDIR` else `/tmp`, plus `tmux-<uid>`.
 * Mirrors tmux's own `make_label()`; `/tmp` is hardcoded there, so TMPDIR is
 * deliberately not consulted.
 */
export function tmuxSocketDir(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): string {
	const base = env.TMUX_TMPDIR && env.TMUX_TMPDIR.length > 0 ? env.TMUX_TMPDIR : "/tmp";
	return join(base, `tmux-${uid}`);
}

export function tmuxSocketPath(socket: string, env?: NodeJS.ProcessEnv, uid?: number): string {
	return join(tmuxSocketDir(env, uid), socket);
}

/**
 * Unlink one socket file. Returns whether a file was actually removed, so a
 * caller can tell "cleaned up" from "was never there".
 */
export function removeTmuxSocketFile(socket: string, env?: NodeJS.ProcessEnv): boolean {
	try {
		unlinkSync(tmuxSocketPath(socket, env));
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether anything is listening on a socket file. `unknown` is not a synonym for
 * `dead`: an unreadable socket protects itself.
 */
export type SocketLiveness = "listening" | "dead" | "unknown";

export interface SocketFileFacts {
	readonly name: string;
	readonly uid: number;
	readonly mtimeMs: number;
	/** Guards against unlinking something in that directory that is not a socket. */
	readonly isSocket: boolean;
	readonly liveness: SocketLiveness;
}

export interface SweepDecision {
	readonly remove: readonly string[];
	readonly kept: number;
}

/**
 * Cheap, no-IO pre-filter: worth probing at all? Prefix, ownership and age only,
 * so the sweep opens a connection to a couple of dozen files instead of every
 * socket on the machine.
 */
export function isSweepCandidate(
	file: Pick<SocketFileFacts, "name" | "uid" | "isSocket" | "mtimeMs">,
	ourUid: number,
	nowMs: number,
	minAgeMs = SWEEP_MIN_AGE_MS,
): boolean {
	if (!file.name.startsWith(SWEEP_SOCKET_PREFIX)) return false;
	if (file.uid !== ourUid) return false;
	if (!file.isSocket) return false;
	return nowMs - file.mtimeMs >= minAgeMs;
}

/**
 * Which socket files are safe to unlink. Pure, because a cleanup guard that
 * stops guarding looks exactly like a clean machine.
 *
 * Five conditions, all required: dev3-prefixed name, owned by us, actually a
 * socket, older than {@link SWEEP_MIN_AGE_MS}, and NOTHING listening on it.
 */
export function selectSweepableSockets(input: {
	readonly files: readonly SocketFileFacts[];
	readonly ourUid: number;
	readonly nowMs: number;
	readonly minAgeMs?: number;
}): SweepDecision {
	const remove: string[] = [];
	for (const file of input.files) {
		if (!isSweepCandidate(file, input.ourUid, input.nowMs, input.minAgeMs)) continue;
		if (file.liveness !== "dead") continue;
		remove.push(file.name);
	}
	return { remove, kept: input.files.length - remove.length };
}
