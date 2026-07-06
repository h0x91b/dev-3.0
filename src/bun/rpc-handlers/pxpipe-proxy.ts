import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PXPIPE_PROXY_BASE_URL, PXPIPE_PROXY_PORT, type PxpipeProxyStatus } from "../../shared/types";
import { createLogger } from "../logger";
import { DEV3_HOME } from "../paths";
import { findPortHolders, getDescendantPids, waitForPortsFree } from "../port-scanner";
import { loadSettings } from "../settings";
import { spawn } from "../spawn";

const log = createLogger("pxpipe-proxy");

/** Pidfile for our managed proxy instance. Additive file under ~/.dev3.0 — an
 *  older app version never reads it, so it does not violate the on-disk layout
 *  invariants (AGENTS.md). */
const PIDFILE = `${DEV3_HOME}/pxpipe-proxy.pid`;

/** Run a command async and return trimmed stdout, or "" on any failure.
 *  On-demand only (user-triggered RPC), never from a poller — so a single
 *  async spawn per call is fine (see the spawnSync warning in port-scanner). */
async function runText(cmd: string[]): Promise<string> {
	try {
		const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (exitCode !== 0) return "";
		return stdout.trim();
	} catch {
		return "";
	}
}

/** Resolve `npx` on PATH. Returns the absolute path, or null when absent. */
async function findNpx(): Promise<string | null> {
	const path = await runText(["which", "npx"]);
	return path || null;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPidfile(): number | null {
	try {
		if (!existsSync(PIDFILE)) return null;
		const pid = parseInt(readFileSync(PIDFILE, "utf-8").trim(), 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function clearPidfile(): void {
	try {
		rmSync(PIDFILE, { force: true });
	} catch {
		/* best-effort */
	}
}

/**
 * Compute the current proxy status. Pure of side effects except that it clears
 * a stale pidfile (managed pid dead and nothing holding the port).
 */
export async function getPxpipeProxyStatus(): Promise<PxpipeProxyStatus> {
	const settings = await loadSettings();
	const enabled = settings.pxpipeProxyEnabled === true;

	const npxPath = await findNpx();
	const holders = await findPortHolders([PXPIPE_PROXY_PORT]);
	const holder = holders[0];
	const portInUse = !!holder;

	const managedPid = readPidfile();
	const managedAlive = managedPid != null && isAlive(managedPid);

	let running = false;
	if (portInUse && managedAlive && managedPid != null) {
		if (holder.pid === managedPid) {
			running = true;
		} else {
			const descendants = await getDescendantPids(managedPid);
			if (descendants.includes(holder.pid)) running = true;
		}
	}

	// Stale pidfile: we recorded a pid that is dead and holds nothing. Clean up
	// so a later Start does not think an instance is already coming up.
	if (managedPid != null && !managedAlive && !portInUse) {
		clearPidfile();
	}

	const starting = managedAlive && !portInUse && !running;
	const foreignConflict = portInUse && !running;

	return {
		enabled,
		npxAvailable: npxPath != null,
		npxPath: npxPath ?? undefined,
		port: PXPIPE_PROXY_PORT,
		portInUse,
		running,
		starting,
		foreignConflict,
		holderPid: holder?.pid,
		holderName: holder?.processName,
		dashboardUrl: `${PXPIPE_PROXY_BASE_URL}/`,
	};
}

/**
 * Spawn the proxy if it is not already running. Non-blocking: it returns as soon
 * as the process is spawned (first run pulls the package via `npx`, which can
 * take a while) — the renderer polls `pxpipeProxyStatus` to observe `starting`
 * flip to `running` once the port comes up.
 */
export async function startPxpipeProxy(): Promise<PxpipeProxyStatus> {
	const current = await getPxpipeProxyStatus();
	if (current.running || current.starting) return current;
	if (!current.npxAvailable) {
		throw new Error("npx not found on PATH — install Node.js to use the token-saving proxy");
	}
	if (current.foreignConflict) {
		throw new Error(
			`Port ${PXPIPE_PROXY_PORT} is already in use by ${current.holderName ?? "another process"} (pid ${current.holderPid ?? "?"})`,
		);
	}

	const proc = spawn(["npx", "-y", "pxpipe-proxy"], {
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	// Do not keep the event loop alive on this child.
	(proc as { unref?: () => void }).unref?.();

	try {
		mkdirSync(DEV3_HOME, { recursive: true });
		writeFileSync(PIDFILE, String(proc.pid));
	} catch (err) {
		log.warn("Failed to write pxpipe pidfile", { error: String(err) });
	}
	log.info("pxpipe proxy spawned", { pid: proc.pid, port: PXPIPE_PROXY_PORT });

	return getPxpipeProxyStatus();
}

/** Stop our managed proxy: SIGTERM the pid tree, drop the pidfile, wait for the
 *  port to free up. Never touches a foreign holder of the port. */
export async function stopPxpipeProxy(): Promise<PxpipeProxyStatus> {
	const managedPid = readPidfile();
	if (managedPid != null) {
		const pids = [managedPid, ...(await getDescendantPids(managedPid))];
		// Kill children first, then the parent.
		for (const pid of pids.reverse()) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* already gone */
			}
		}
	}
	clearPidfile();
	await waitForPortsFree([PXPIPE_PROXY_PORT], 5000);
	log.info("pxpipe proxy stopped", { managedPid });
	return getPxpipeProxyStatus();
}

export const pxpipeProxyHandlers = {
	pxpipeProxyStatus: () => getPxpipeProxyStatus(),
	pxpipeProxyStart: () => startPxpipeProxy(),
	pxpipeProxyStop: () => stopPxpipeProxy(),
};
