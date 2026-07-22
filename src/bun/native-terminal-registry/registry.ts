/**
 * The persistent native-session REGISTRY manager (seq 1214).
 *
 * A parallel namespace of independent native terminal sessions, each addressed
 * by a stable session id. It can start, list, inspect, and stop sessions, and
 * survives launcher/client exit: a fresh process rediscovers every live session
 * purely from on-disk records + private tokens.
 *
 * Guarantees enforced here:
 *  • Start and stale cleanup of one id share a per-session file lock — a start
 *    loser observes the winner's live record instead of spawning another shell,
 *    and cleanup cannot erase a concurrent replacement.
 *  • Stale/dead records are detected passively (ownership.ts) and cleaned up
 *    ONLY when token-matched — never by attaching to or killing an unverified PID.
 *  • Stop tears down exactly one session through its own ownership boundary
 *    (POSIX signal re-verified against identity / Windows token-named Job Object)
 *    and touches no other native session, unrelated process, or tmux session.
 *
 * NOT wired into any production UI/CLI/RPC/tmux path (scope boundary). Effects
 * are injectable (RegistryDeps) so locking, stale detection, and cleanup are
 * deterministically unit-testable without real processes.
 */

import { spawn as spawnChild } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withFileLock } from "../file-lock";
import { NativeSessionClient } from "./client";
import { classifyOwnership, type OwnershipVerdict } from "./ownership";
import { isValidSessionId, logFile, recordFile, sessionDir, sessionsRootDir } from "./paths";
import { isProcessAlive } from "./process-identity";
import { readRecord, readToken, removeSessionState, type NativeSessionRecord } from "./record";
import type { StatusReply } from "./protocol";
import { forceTerminateWindowsJob } from "./windows-job";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const CLEANUP_LOCK_TIMEOUT_MS = 5000;
const CLEANUP_LOCK_STALE_THRESHOLD_MS = 60 * 60_000;

export interface HostSpawnOptions {
	cmd?: string[];
	cols?: number;
	rows?: number;
	cwd?: string;
	/** Opt-in live-parser proof stage (seq 1228); default off keeps the host lean. */
	liveParser?: boolean;
	/** Opt-in unbounded ground-truth stream tap — proof runs only. */
	stateTap?: boolean;
}

export interface StartOptions extends HostSpawnOptions {
	/** Host boot deadline. Default 15s. */
	timeoutMs?: number;
}

export type StartStatus = "started" | "already-running";

export interface StartResult {
	status: StartStatus;
	record: NativeSessionRecord;
}

export interface SessionListing {
	sessionId: string;
	record: NativeSessionRecord;
	state: "running" | "reused" | "dead";
}

export interface StatusResult {
	running: boolean;
	record?: NativeSessionRecord;
	verdict?: OwnershipVerdict;
	live?: StatusReply;
}

export interface CleanupResult {
	removed: string[];
	kept: SessionListing[];
}

/** A detached host launch the start loop polls to readiness. */
export interface HostLaunch {
	childPid: number;
	hasExited(): boolean;
	earlyError(): string | null;
}

export type HostLauncher = (sessionId: string, opts: HostSpawnOptions, logFd: number) => HostLaunch;

/** Injected effects — defaulted to the real implementations, faked in tests. */
export interface RegistryDeps {
	launchHost: HostLauncher;
	classify: (record: NativeSessionRecord, token: string | null) => Promise<OwnershipVerdict>;
}

function hostEntry(): string {
	return fileURLToPath(new URL("./cli.ts", import.meta.url));
}

function hostLogTail(sessionId: string, maxLength = 4000): string {
	try {
		return readFileSync(logFile(sessionId), "utf8").trim().slice(-maxLength);
	} catch {
		return "";
	}
}

/** Real launcher: spawn a detached child that re-enters this CLI in host mode. */
export function defaultHostLauncher(sessionId: string, opts: HostSpawnOptions, logFd: number): HostLaunch {
	const child = spawnChild(process.execPath, [hostEntry(), "__host", sessionId], {
		stdio: ["ignore", logFd, logFd],
		detached: true,
		env: {
			...process.env,
			DEV3_NATIVE_SESSION_ID: sessionId,
			...(opts.cmd ? { DEV3_NATIVE_SESSION_CMD: JSON.stringify(opts.cmd) } : {}),
			...(opts.cols ? { DEV3_NATIVE_SESSION_COLS: String(opts.cols) } : {}),
			...(opts.rows ? { DEV3_NATIVE_SESSION_ROWS: String(opts.rows) } : {}),
			...(opts.cwd ? { DEV3_NATIVE_SESSION_CWD: opts.cwd } : {}),
			...(opts.liveParser ? { DEV3_NATIVE_SESSION_LIVE_PARSER: "1" } : {}),
			...(opts.stateTap ? { DEV3_NATIVE_SESSION_STATE_TAP: "1" } : {}),
		},
	});
	let exited = false;
	let earlyError: string | null = null;
	child.on("error", (err) => {
		exited = true;
		earlyError = err.message;
	});
	child.on("exit", () => {
		exited = true;
	});
	child.unref();
	return {
		childPid: child.pid ?? -1,
		hasExited: () => exited,
		earlyError: () => earlyError,
	};
}

export const defaultDeps: RegistryDeps = {
	launchHost: defaultHostLauncher,
	classify: classifyOwnership,
};

/**
 * Start (or discover) the session `sessionId`. Serialised per id: exactly one
 * concurrent caller spawns a host; the rest see the live record and get
 * `already-running` without ever launching a second shell.
 */
export async function start(
	sessionId: string,
	opts: StartOptions = {},
	deps: RegistryDeps = defaultDeps,
): Promise<StartResult> {
	const bootTimeout = opts.timeoutMs ?? 15_000;
	if (!isValidSessionId(sessionId)) {
		// Fail fast before touching the lock path, mirroring assertValidSessionId.
		throw new Error(`invalid native session id ${JSON.stringify(sessionId)}`);
	}
	mkdirSync(sessionDir(sessionId), { recursive: true, mode: 0o700 });

	return withFileLock(
		recordFile(sessionId),
		async () => {
			const existing = readRecord(sessionId);
			if (existing) {
				const token = readToken(sessionId);
				if ((await deps.classify(existing, token)) === "owned") {
					return { status: "already-running", record: existing };
				}
				// Not ours anymore (dead/reused) — drop only our token-matched state.
				if (!removeSessionState(sessionId, token)) {
					throw new Error(`cannot safely replace stale native session ${sessionId}: cleanup token is missing or changed`);
				}
				mkdirSync(sessionDir(sessionId), { recursive: true, mode: 0o700 });
			}

			const logFd = openSync(logFile(sessionId), "a");
			const launch = deps.launchHost(
				sessionId,
				{
					cmd: opts.cmd,
					cols: opts.cols,
					rows: opts.rows,
					cwd: opts.cwd,
					liveParser: opts.liveParser,
					stateTap: opts.stateTap,
				},
				logFd,
			);
			try {
				const deadline = Date.now() + bootTimeout;
				while (Date.now() < deadline) {
					if (launch.hasExited()) {
						const details = [launch.earlyError(), hostLogTail(sessionId)].filter(Boolean).join("\n");
						throw new Error(`native session host exited during startup${details ? `:\n${details}` : ""}`);
					}
					const rec = readRecord(sessionId);
					if (rec && rec.host.pid === launch.childPid && rec.shell.pid > 0 && isProcessAlive(rec.shell.pid)) {
						return { status: "started", record: rec };
					}
					await delay(100);
				}
				throw new Error(`native session ${sessionId} host did not report readiness in time`);
			} finally {
				try {
					closeSync(logFd);
				} catch {
					// already closed
				}
			}
		},
		{ timeout: bootTimeout + 5000, staleThreshold: bootTimeout + 10_000 },
	);
}

function listSessionIds(): string[] {
	try {
		return readdirSync(sessionsRootDir(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && isValidSessionId(entry.name))
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** All discoverable sessions with their liveness verdict. Never exposes tokens. */
export async function list(deps: RegistryDeps = defaultDeps): Promise<SessionListing[]> {
	const out: SessionListing[] = [];
	for (const sessionId of listSessionIds()) {
		const record = readRecord(sessionId);
		if (!record) continue; // corrupt / unknown-schema — not ours to interpret
		const verdict = await deps.classify(record, readToken(sessionId));
		out.push({ sessionId, record, state: verdict === "owned" ? "running" : verdict });
	}
	return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** Inspect one session; attaches for live status only after ownership is verified. */
export async function status(sessionId: string, deps: RegistryDeps = defaultDeps): Promise<StatusResult> {
	if (!isValidSessionId(sessionId)) return { running: false };
	const record = readRecord(sessionId);
	if (!record) return { running: false };
	const token = readToken(sessionId);
	const verdict = await deps.classify(record, token);
	if (verdict !== "owned" || !token) return { running: false, record, verdict };
	try {
		const client = new NativeSessionClient();
		await client.connect(record, token, { timeoutMs: 2000 });
		const live = await client.status({ timeoutMs: 2000 });
		client.close();
		return { running: true, record, verdict, live };
	} catch {
		return { running: true, record, verdict };
	}
}

/**
 * Stop exactly one session. Prefers a graceful in-band stop; falls back to the
 * session's own ownership boundary (POSIX: signal the host only after
 * re-verifying identity; Windows: terminate the token-named Job Object). Never
 * touches another session, an unrelated process, or any tmux session.
 */
export async function stop(
	sessionId: string,
	opts: { timeoutMs?: number } = {},
	deps: RegistryDeps = defaultDeps,
): Promise<boolean> {
	if (!isValidSessionId(sessionId)) return true;
	const record = readRecord(sessionId);
	if (!record) return true;
	const token = readToken(sessionId);
	const verdict = await deps.classify(record, token);

	// Not (or no longer) ours: never signal the PID — just drop token-matched state.
	if (verdict !== "owned") {
		return removeSessionState(sessionId, token);
	}

	const forceOwnedTree = async (hard = false): Promise<void> => {
		if (process.platform === "win32") {
			if (token) {
				try {
					await forceTerminateWindowsJob(token);
				} catch {
					// job already gone
				}
			}
			return;
		}
		// Re-verify identity immediately before signalling so a reused PID is never hit.
		if ((await deps.classify(record, token)) === "owned" && isProcessAlive(record.host.pid)) {
			try {
				process.kill(record.host.pid, hard ? "SIGKILL" : "SIGTERM");
			} catch {
				// already gone
			}
		}
	};

	try {
		const client = new NativeSessionClient();
		await client.connect(record, token as string, { timeoutMs: 3000 });
		await client.requestStop({ timeoutMs: 3000 });
		client.close();
	} catch {
		await forceOwnedTree(false);
	}

	const stateGone = (): boolean => readRecord(sessionId) === null || readToken(sessionId) !== token;
	const deadline = Date.now() + (opts.timeoutMs ?? 8000);
	while (Date.now() < deadline) {
		if (stateGone() && !isProcessAlive(record.host.pid) && !isProcessAlive(record.shell.pid)) return true;
		await delay(100);
	}

	await forceOwnedTree(true);
	const forceDeadline = Date.now() + 1500;
	while (Date.now() < forceDeadline) {
		if (!isProcessAlive(record.host.pid) && !isProcessAlive(record.shell.pid)) break;
		await delay(50);
	}
	const dead = !isProcessAlive(record.host.pid) && !isProcessAlive(record.shell.pid);
	if (dead) removeSessionState(sessionId, token);
	return dead;
}

/**
 * Remove dead/stale records, ONLY when token-matched, without ever attaching to
 * or killing a PID. A record with an unknown schema or a live-but-not-owned PID
 * is left in place (its process, if any, is never signalled).
 */
export async function cleanupStale(deps: RegistryDeps = defaultDeps): Promise<CleanupResult> {
	const removed: string[] = [];
	const kept: SessionListing[] = [];
	for (const sessionId of listSessionIds()) {
		if (!readRecord(sessionId)) continue; // avoid locking unreadable or foreign state
		let removedState = false;
		await withFileLock(
			recordFile(sessionId),
			async () => {
				const record = readRecord(sessionId);
				if (!record) return; // corrupt / unknown-schema — never delete another version's state
				const token = readToken(sessionId);
				const verdict = await deps.classify(record, token);
				if (verdict === "owned") {
					kept.push({ sessionId, record, state: "running" });
					return;
				}
				if (removeSessionState(sessionId, token)) {
					removed.push(sessionId);
					removedState = true;
				} else kept.push({ sessionId, record, state: verdict });
			},
			{
				timeout: CLEANUP_LOCK_TIMEOUT_MS,
				// Fail closed instead of breaking a plausible long-running start lock.
				staleThreshold: CLEANUP_LOCK_STALE_THRESHOLD_MS,
			},
		);
		if (removedState) {
			try {
				rmdirSync(sessionDir(sessionId));
			} catch {
				// A concurrent start or an unknown sibling now owns the directory.
			}
		}
	}
	return { removed, kept };
}
