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

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { RemoteHandoff, RemoteServerState, RemoteUpdateAttempts, RemoteUpdateRecord } from "../shared/types";
import { DEV3_HOME } from "./paths";

export const REMOTE_DIR = `${DEV3_HOME}/remote`;
export const REMOTE_STATE_FILE = `${REMOTE_DIR}/state.json`;
export const REMOTE_LOG_FILE = `${REMOTE_DIR}/remote.log`;
export const REMOTE_START_LOCK_FILE = `${REMOTE_DIR}/start.lock`;
/** Where a self-update parks the binary it is replacing, so a rollback has one. */
export const REMOTE_ROLLBACK_DIR = `${REMOTE_DIR}/rollback`;

/** A start lock older than this is treated as abandoned (launcher crashed). */
const START_LOCK_STALE_MS = 30_000;

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
			// Present only when the file actually carries them, so an ordinary record
			// keeps exactly the shape every previous version wrote and read.
			...maybe("handoff", sanitizeHandoff(parsed.handoff)),
			...maybe("lastUpdate", sanitizeUpdateRecord(parsed.lastUpdate)),
			...maybe("updateAttempts", sanitizeUpdateAttempts(parsed.updateAttempts)),
		};
	} catch {
		// File missing, unreadable, or invalid JSON — no live server recorded.
		return null;
	}
}

/** `{ key: value }` when value is set, `{}` otherwise. Keeps absent keys absent. */
function maybe<K extends string, V>(key: K, value: V | null): Record<K, V> | Record<string, never> {
	return value === null ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Validate a handoff block field by field, and REJECT a tunnel whose recorded
 * process is gone.
 *
 * A stale handoff is not a harmless leftover: adopting a dead cloudflared pid
 * would publish a hostname that resolves nowhere, and the browser caches that
 * miss. A record whose `fromPid` is still alive is equally wrong — the previous
 * server never exited, so this is not our handoff to take.
 */
function sanitizeHandoff(raw: unknown): RemoteHandoff | null {
	if (!raw || typeof raw !== "object") return null;
	const h = raw as Partial<RemoteHandoff>;
	if (typeof h.port !== "number" || h.port <= 0 || h.port > 65535) return null;
	if (typeof h.fromPid !== "number" || h.fromPid <= 0) return null;
	if (isProcessAlive(h.fromPid)) return null;
	let tunnel: RemoteHandoff["tunnel"] = null;
	const t = h.tunnel;
	if (t && typeof t === "object" && typeof t.pid === "number" && typeof t.url === "string" && t.url) {
		if (isProcessAlive(t.pid)) {
			tunnel = {
				pid: t.pid,
				url: t.url,
				metricsReadyUrl: typeof t.metricsReadyUrl === "string" ? t.metricsReadyUrl : null,
			};
		}
	}
	return { port: h.port, fromPid: h.fromPid, tunnel };
}

function sanitizeUpdateRecord(raw: unknown): RemoteUpdateRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Partial<RemoteUpdateRecord>;
	if (typeof r.fromVersion !== "string" || typeof r.toVersion !== "string") return null;
	return {
		fromVersion: r.fromVersion,
		toVersion: r.toVersion,
		startedAt: typeof r.startedAt === "string" ? r.startedAt : "",
	};
}

function sanitizeUpdateAttempts(raw: unknown): RemoteUpdateAttempts | null {
	if (!raw || typeof raw !== "object") return null;
	const a = raw as Partial<RemoteUpdateAttempts>;
	if (typeof a.version !== "string" || !a.version) return null;
	if (typeof a.failures !== "number" || !Number.isFinite(a.failures) || a.failures < 0) return null;
	return {
		version: a.version,
		failures: Math.floor(a.failures),
		lastFailureMs: typeof a.lastFailureMs === "number" && Number.isFinite(a.lastFailureMs) ? a.lastFailureMs : 0,
		...(typeof a.lastError === "string" ? { lastError: a.lastError } : {}),
	};
}

/**
 * Record one more failed attempt at `version`, surviving into the next process.
 *
 * READ-MODIFY-WRITE OF THE WHOLE RECORD, on purpose: the supervisor calls this
 * from a different process than the one that started the update, so it cannot
 * hold the state in memory. A different version resets the count — whatever broke
 * may well be fixed in the next build.
 */
export function recordUpdateFailure(version: string, error: string, now: number = Date.now()): void {
	const current = readRemoteState();
	if (!current) return; // no server record to annotate; the in-memory counter still applies
	const prior = current.updateAttempts;
	const failures = prior && prior.version === version ? prior.failures + 1 : 1;
	try {
		writeRemoteState({
			...current,
			updateAttempts: { version, failures, lastFailureMs: now, lastError: error.slice(0, 500) },
		});
	} catch {
		// Best-effort: losing the counter degrades to the old in-memory behaviour.
	}
}

/**
 * Read a handoff left by a server that has already exited, or null.
 *
 * The freshness checks live in {@link sanitizeHandoff}, so a caller cannot
 * accidentally trust a record whose writer is still running or whose tunnel died.
 */
export function readRemoteHandoff(): RemoteHandoff | null {
	return readRemoteState()?.handoff ?? null;
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

/**
 * Acquire an exclusive "a `--detach` launch is in progress" lock so two
 * simultaneous `dev3 remote --detach` invocations can't both pass the
 * "is one already running?" check and orphan each other's server (the state
 * file is a singleton — the second writer clobbers the first).
 *
 * Uses `O_EXCL` ("wx") — an atomic create-or-fail on POSIX. Returns the open fd
 * on success, or `null` if another live launch already holds it. A lock older
 * than {@link START_LOCK_STALE_MS} is treated as abandoned (its launcher crashed
 * mid-startup) and reclaimed, so a crash never wedges the feature permanently.
 */
export function acquireStartLock(): number | null {
	mkdirSync(REMOTE_DIR, { recursive: true });
	try {
		return openSync(REMOTE_START_LOCK_FILE, "wx");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		try {
			const age = Date.now() - statSync(REMOTE_START_LOCK_FILE).mtimeMs;
			if (age > START_LOCK_STALE_MS) {
				unlinkSync(REMOTE_START_LOCK_FILE);
				return openSync(REMOTE_START_LOCK_FILE, "wx");
			}
		} catch {
			// Lost the reclaim race, or the file vanished — treat as held.
		}
		return null;
	}
}

/** Release the start lock: close the fd and remove the file. Best-effort. */
export function releaseStartLock(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// Already closed — harmless.
	}
	try {
		if (existsSync(REMOTE_START_LOCK_FILE)) unlinkSync(REMOTE_START_LOCK_FILE);
	} catch {
		// Best-effort — a leftover lock self-heals via the stale-reclaim path.
	}
}
