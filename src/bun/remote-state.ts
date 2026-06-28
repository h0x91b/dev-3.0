/**
 * Persisted lifecycle state for a running `dev3 remote` headless server.
 *
 * The server writes `~/.dev3.0/remote/state.json` on startup and removes it on
 * graceful shutdown. A SEPARATE process — `dev3 remote status/stop/url`, often a
 * fresh SSH session — reads it to discover the running server's PID, port, and
 * CLI socket, so it can query or stop the server without scraping the banner.
 *
 * Dependency-light on purpose: only `node:fs`/`node:path` + the pure `paths`
 * module, so the CLI bundle can import it directly without pulling in any of the
 * bun/electrobun runtime. This is an ADDITIVE on-disk path — older app versions
 * never read it, so it does not touch the frozen `~/.dev3.0/` layout invariants.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { RemoteServerState } from "../shared/types";
import { DEV3_HOME } from "./paths";

export const REMOTE_DIR = `${DEV3_HOME}/remote`;
export const REMOTE_STATE_FILE = `${REMOTE_DIR}/state.json`;
export const REMOTE_LOG_FILE = `${REMOTE_DIR}/remote.log`;

/**
 * Is `pid` a live process? `kill(pid, 0)` sends no signal — it only probes.
 * ESRCH ⇒ no such process (dead). EPERM ⇒ the process exists but is owned by
 * another user (alive). Anything else ⇒ treat as dead, conservatively.
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

/** Write the running-server record. Creates `~/.dev3.0/remote/` if needed. */
export function writeRemoteState(state: RemoteServerState): void {
	mkdirSync(REMOTE_DIR, { recursive: true });
	writeFileSync(REMOTE_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Read the running-server record, or null if absent/corrupt/incomplete.
 * Validates the required numeric/string fields so a half-written file never
 * surfaces as a phantom server.
 */
export function readRemoteState(): RemoteServerState | null {
	try {
		const parsed = JSON.parse(readFileSync(REMOTE_STATE_FILE, "utf-8")) as Partial<RemoteServerState>;
		if (
			typeof parsed.pid !== "number" ||
			typeof parsed.port !== "number" ||
			typeof parsed.socketPath !== "string"
		) {
			return null;
		}
		return {
			pid: parsed.pid,
			port: parsed.port,
			socketPath: parsed.socketPath,
			tunnelRequested: Boolean(parsed.tunnelRequested),
			staticCode: typeof parsed.staticCode === "string" ? parsed.staticCode : null,
			logFile: typeof parsed.logFile === "string" ? parsed.logFile : null,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
			version: typeof parsed.version === "string" ? parsed.version : "",
		};
	} catch {
		// File missing, unreadable, or invalid JSON — no live server recorded.
		return null;
	}
}

/** Remove the state file unconditionally. Safe to call when none exists. */
export function clearRemoteState(): void {
	try {
		if (existsSync(REMOTE_STATE_FILE)) unlinkSync(REMOTE_STATE_FILE);
	} catch {
		// Best-effort cleanup — a leftover file is harmless (liveness is re-checked).
	}
}

/**
 * Remove the state file only if it still belongs to `pid`. Prevents a shutting-down
 * server from clobbering a record a newer server already wrote (PID reuse / quick
 * restart race).
 */
export function clearRemoteStateIfOwnedBy(pid: number): void {
	const current = readRemoteState();
	if (current && current.pid !== pid) return;
	clearRemoteState();
}
