/**
 * On-disk discovery metadata for the detached-PTY prototype (spike — see
 * ./README.md). A fresh, unrelated process (a second client) reads this to
 * find the running host's loopback endpoint + per-run token, exactly like
 * `dev3 remote status/stop` rediscover a backgrounded server via remote-state.
 *
 * ISOLATION: this is an ADDITIVE, prototype-only path. It defaults to a NEW
 * `~/.dev3.0/pty-proto/` subdirectory and is fully overridable via
 * DEV3_PTY_PROTO_DIR (tests point it at a tmpdir). It never touches, renames,
 * or deletes any existing `~/.dev3.0/` entry, so the frozen on-disk layout and
 * every already-running dev3/tmux flow are unaffected.
 *
 * Dependency-light on purpose: only node:fs/node:path — no Bun runtime — so the
 * pure logic is unit-testable under vitest (which stubs the Bun global).
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PtyProtoState {
	/** PID of the detached host process that owns the shell. */
	hostPid: number;
	/** PID of the interactive shell the host spawned via Bun.Terminal. */
	shellPid: number;
	/** Loopback host the transport is bound to (always 127.0.0.1). */
	host: string;
	/** OS-assigned ephemeral TCP port of the WebSocket transport. */
	port: number;
	/** Per-run bearer token required on every attach. */
	token: string;
	startedAt: string;
	cols: number;
	rows: number;
}

/** Metadata directory: env override, else an additive `~/.dev3.0/pty-proto/`. */
export function stateDir(): string {
	const explicit = process.env.DEV3_PTY_PROTO_DIR;
	if (explicit) return explicit;
	const dev3Home = process.env.DEV3_HOME || `${process.env.HOME || "/tmp"}/.dev3.0`;
	return join(dev3Home, "pty-proto");
}

export function stateFile(): string {
	return join(stateDir(), "state.json");
}

export function logFile(): string {
	return join(stateDir(), "host.log");
}

/**
 * Is `pid` a live process? `kill(pid, 0)` sends no signal — it only probes.
 * ESRCH ⇒ dead. EPERM ⇒ exists but owned by another user (alive).
 */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function writeState(state: PtyProtoState): void {
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

/** Read the record, or null if absent/corrupt/incomplete. */
export function readState(): PtyProtoState | null {
	try {
		const parsed = JSON.parse(readFileSync(stateFile(), "utf-8")) as Partial<PtyProtoState>;
		if (
			typeof parsed.hostPid !== "number" ||
			typeof parsed.shellPid !== "number" ||
			typeof parsed.port !== "number" ||
			typeof parsed.host !== "string" ||
			typeof parsed.token !== "string"
		) {
			return null;
		}
		return {
			hostPid: parsed.hostPid,
			shellPid: parsed.shellPid,
			host: parsed.host,
			port: parsed.port,
			token: parsed.token,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
			cols: typeof parsed.cols === "number" ? parsed.cols : 80,
			rows: typeof parsed.rows === "number" ? parsed.rows : 24,
		};
	} catch {
		return null;
	}
}

/**
 * Remove ALL prototype metadata: the state file, the host log, and the
 * prototype directory itself (only if it is now empty — a non-recursive rmdir
 * so we never nuke an unexpected directory). Best-effort; safe to call twice.
 */
export function clearState(): void {
	for (const f of [stateFile(), logFile()]) {
		try {
			if (existsSync(f)) unlinkSync(f);
		} catch {
			// best-effort — a leftover file is harmless (liveness is re-checked)
		}
	}
	try {
		rmdirSync(stateDir());
	} catch {
		// dir not empty or already gone — leave it
	}
}
