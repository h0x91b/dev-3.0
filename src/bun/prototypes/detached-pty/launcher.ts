/**
 * Detached-PTY prototype LAUNCHER (spike — see ./README.md).
 *
 * Reuses the proven `dev3 remote --detach` lifecycle: spawn a detached child
 * that re-runs THIS binary in host mode, unref it, then poll the metadata file
 * until the host records its readiness — after which the launcher exits WITHOUT
 * terminating the host. `stop()`/`status()` are separate-process operations that
 * rediscover the host purely from the metadata file.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clearState, isProcessAlive, logFile, readState, stateDir, type PtyProtoState } from "./state";
import { PtyProtoClient } from "./client";
import type { StatusReply } from "./protocol";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Absolute path to the prototype CLI entry, resolved relative to this module. */
function hostEntry(): string {
	return fileURLToPath(new URL("./cli.ts", import.meta.url));
}

/**
 * Start a detached host and wait for it to report readiness. Returns the
 * recorded metadata. Throws if a live host already exists or startup times out.
 */
export async function start(opts: { timeoutMs?: number } = {}): Promise<PtyProtoState> {
	const existing = readState();
	if (existing && isProcessAlive(existing.hostPid)) {
		throw new Error(`a detached-pty host is already running (pid ${existing.hostPid}, port ${existing.port})`);
	}
	if (existing) clearState(); // stale record from a dead host

	mkdirSync(stateDir(), { recursive: true });
	const logFd = openSync(logFile(), "a");

	// process.execPath is `bun` under `bun run` — re-invoke the prototype CLI in
	// host mode. (The prototype is dev-only; it is never part of the compiled
	// `dev3` binary, so the compiled-argv reshaping remote.ts needs is N/A here.)
	const child = spawn(process.execPath, [hostEntry(), "__host"], {
		stdio: ["ignore", logFd, logFd],
		env: { ...process.env },
		detached: true,
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

	const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
	let recorded: PtyProtoState | null = null;
	while (Date.now() < deadline) {
		if (exited) {
			try {
				closeSync(logFd);
			} catch {
				// already closed
			}
			throw new Error(`host exited during startup${earlyError ? `: ${earlyError}` : ""}`);
		}
		const s = readState();
		if (s && s.hostPid === child.pid && s.port > 0 && s.shellPid > 0) {
			recorded = s;
			break;
		}
		await delay(100);
	}
	try {
		closeSync(logFd);
	} catch {
		// already closed
	}
	if (!recorded) throw new Error("host did not report readiness in time");
	return recorded;
}

export interface StatusResult {
	running: boolean;
	state?: PtyProtoState;
	live?: StatusReply;
}

/** Rediscover a host from metadata and, if reachable, fetch live status. */
export async function status(): Promise<StatusResult> {
	const state = readState();
	if (!state) return { running: false };
	if (!isProcessAlive(state.hostPid)) {
		clearState();
		return { running: false };
	}
	try {
		const client = new PtyProtoClient();
		await client.connect(state);
		const live = await client.status();
		client.close();
		return { running: true, state, live };
	} catch {
		return { running: true, state };
	}
}

/**
 * Stop the host and its shell tree. Prefers a graceful in-band stop; falls back
 * to signalling the host PID. Resolves once metadata is gone and both the host
 * and shell PIDs are dead.
 */
export async function stop(opts: { timeoutMs?: number } = {}): Promise<boolean> {
	const state = readState();
	if (!state) return false;

	try {
		const client = new PtyProtoClient();
		await client.connect(state);
		await client.requestStop();
		client.close();
	} catch {
		try {
			if (isProcessAlive(state.hostPid)) process.kill(state.hostPid, "SIGTERM");
		} catch {
			// already gone
		}
	}

	const deadline = Date.now() + (opts.timeoutMs ?? 6000);
	while (Date.now() < deadline) {
		if (!readState() && !isProcessAlive(state.hostPid) && !isProcessAlive(state.shellPid)) {
			return true;
		}
		await delay(100);
	}

	// Last resort: hard-kill the host and clear metadata ourselves.
	try {
		if (isProcessAlive(state.hostPid)) process.kill(state.hostPid, "SIGKILL");
	} catch {
		// already gone
	}
	clearState();
	return !isProcessAlive(state.hostPid) && !isProcessAlive(state.shellPid);
}
