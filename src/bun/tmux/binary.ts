/**
 * tmux binary selection + PATH-shim management, moved VERBATIM from
 * pty-server.ts. This code already killed terminals for updater users once
 * (v1.29.1 ELOOP incident, decision 105) — move it, do not refactor it.
 *
 * Internal to the tmux module: TmuxClient is the only consumer; outside
 * callers go through the client's typed surface (`tmux.selectBinary`,
 * `tmux.probeVersion`, `tmux.dereferenceShim`, `tmux.binaryPath`).
 */
import { existsSync, lstatSync, readlinkSync, realpathSync, unlinkSync, symlinkSync, mkdirSync } from "node:fs";
import { createLogger } from "../logger";
import { DEV3_HOME } from "../paths";
import { spawn } from "../spawn";
import { isExecutableFile } from "../executable";
import { DEFAULT_TMUX_SOCKET } from "./constants";

// Must be initialized before any module-load code below — sanitizeTmuxShim()
// runs at module evaluation and logs when it finds a broken shim. Declaring
// this after that call crashed app startup on poisoned installs (v1.29.2).
const log = createLogger("tmux");

// Resolved tmux binary path. Defaults to "tmux" (relies on PATH).
// Updated by setTmuxBinary() after requirements check finds a custom or fallback path.
let tmuxBinary = "tmux";

export function setTmuxBinary(path: string) {
	tmuxBinary = path;
}

export function getTmuxBinary(): string {
	return tmuxBinary;
}

type TmuxServerProbe = {
	status: "compatible" | "no-server" | "mismatch";
	serverVersion?: string;
};

export interface TmuxServerVersionMismatch {
	clientVersion: string;
	serverVersion: string;
}

let serverVersionMismatch: TmuxServerVersionMismatch | null = null;

export function getTmuxServerVersionMismatch(): TmuxServerVersionMismatch | null {
	return serverVersionMismatch;
}

function normalizeTmuxVersion(version: string): string {
	return version.trim().replace(/^tmux\s+/, "");
}

/**
 * Check whether `binary` matches a server already running on `socket`.
 * Non-interactive commands may succeed across version skew while attached
 * clients lose their terminal fd (tmux/tmux#4356), so compare the running
 * server's `#{version}` with this binary instead of trusting list-sessions.
 */
async function probeTmuxServer(binary: string, binaryVersion: string, socket: string): Promise<TmuxServerProbe> {
	try {
		const proc = spawn([binary, "-L", socket, "display-message", "-p", "#{version}"], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode === 0) {
			const serverVersion = normalizeTmuxVersion(stdout);
			return {
				status: serverVersion === normalizeTmuxVersion(binaryVersion) ? "compatible" : "mismatch",
				...(serverVersion ? { serverVersion } : {}),
			};
		}
		if (stderr.includes("no server running") || stderr.includes("error connecting")) {
			return { status: "no-server" };
		}
		return { status: "mismatch" };
	} catch {
		return { status: "mismatch" };
	}
}

export async function probeTmuxVersion(binary: string): Promise<string | undefined> {
	try {
		const proc = spawn([binary, "-V"], { stdout: "pipe", stderr: "pipe" });
		const stdout = (await new Response(proc.stdout).text()).trim();
		const exitCode = await proc.exited;
		return exitCode === 0 && /^tmux \d/.test(stdout) ? stdout : undefined;
	} catch {
		return undefined;
	}
}

/** PATH shim kept in sync with the app-selected tmux binary (see updateTmuxShim). */
export const TMUX_SHIM_PATH = `${DEV3_HOME}/bin/tmux`;

/**
 * Resolve a candidate tmux path that may be the PATH shim itself.
 * `~/.dev3.0/bin` sits first in PATH (it hosts the dev3 CLI), so whichSync
 * happily returns our own shim. Committing THAT as the tmux binary and then
 * repointing the shim at "itself" created a self-referential symlink — every
 * subsequent tmux spawn died with ELOOP. Always dereference the shim to its
 * real target; a broken/cyclic shim is deleted so it stops poisoning both
 * resolution and bare `tmux` PATH lookups.
 */
export function dereferenceTmuxShim(binaryPath: string): string | undefined {
	if (binaryPath !== TMUX_SHIM_PATH) {
		return !binaryPath.startsWith("/") || isExecutableFile(binaryPath) ? binaryPath : undefined;
	}
	// A regular file here is not ours — the app only ever creates a symlink.
	// Treat it as the user's own tmux binary: use it as-is, never delete it
	// (updateTmuxShim likewise leaves non-symlinks alone).
	if (!isSymlink(binaryPath)) return isExecutableFile(binaryPath) ? binaryPath : undefined;
	try {
		const target = realpathSync(binaryPath); // throws on ELOOP cycles and dangling targets
		if (!isExecutableFile(target)) throw new Error("tmux shim target is not an executable file");
		return target;
	} catch {
		log.warn("tmux shim is broken — removing it", { shim: binaryPath });
		try {
			unlinkSync(binaryPath);
		} catch {
			log.debug("could not remove broken tmux shim (already gone?)");
		}
		return undefined;
	}
}

/**
 * Delete `~/.dev3.0/bin/tmux` if it is a broken or self-referential symlink.
 * Runs at module load, before anything spawns tmux: a poisoned shim sits
 * first in PATH, so even bare `tmux` spawns fail with ELOOP until it's gone.
 */
export function sanitizeTmuxShim(): void {
	if (!isSymlink(TMUX_SHIM_PATH)) return;
	try {
		const target = realpathSync(TMUX_SHIM_PATH);
		if (!isExecutableFile(target)) throw new Error("tmux shim target is not an executable file");
	} catch {
		log.warn("removing broken tmux shim", { shim: TMUX_SHIM_PATH });
		try {
			unlinkSync(TMUX_SHIM_PATH);
		} catch {
			log.debug("could not remove broken tmux shim (already gone?)");
		}
	}
}

sanitizeTmuxShim();

/**
 * Keep `~/.dev3.0/bin/tmux` symlinked to the binary the app selected.
 * That directory is prepended to PATH in every dev3 pane, so agents running
 * bare `tmux -L dev3 ...` always hit the same binary as the app — mixing
 * client versions against one server breaks every command.
 */
export function updateTmuxShim(binaryPath: string): void {
	if (!binaryPath.startsWith("/")) return; // bare "tmux" — nothing concrete to pin
	if (binaryPath === TMUX_SHIM_PATH) {
		// Guard against the ELOOP disaster: never point the shim at itself.
		log.warn("refusing to point the tmux shim at itself", { shim: binaryPath });
		return;
	}
	if (!isExecutableFile(binaryPath)) {
		log.warn("refusing to point the tmux shim at a non-executable path", { binaryPath });
		return;
	}
	try {
		const shimDir = `${DEV3_HOME}/bin`;
		mkdirSync(shimDir, { recursive: true });
		const shim = `${shimDir}/tmux`;
		if (existsSync(shim) || isSymlink(shim)) {
			if (!isSymlink(shim)) {
				log.warn("~/.dev3.0/bin/tmux exists and is not a symlink — leaving it alone", { shim });
				return;
			}
			if (readlinkSync(shim) === binaryPath) return;
			unlinkSync(shim);
		}
		symlinkSync(binaryPath, shim);
		log.info("tmux shim updated", { shim, target: binaryPath });
	} catch (err) {
		log.warn("failed to update tmux shim", { binaryPath, error: String(err) });
	}
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Commit to a tmux binary for this app session: verify it against any
 * already-running dev3 server first (upgrading the preferred binary while
 * sessions are alive must not kill every terminal), fall back to a candidate
 * the live server understands, then pin the choice via setTmuxBinary and the
 * PATH shim. The preferred binary wins again after the next kill-server or
 * reboot, when no incompatible server is left running.
 */
export async function selectTmuxBinary(preferred: string, fallbackCandidates: string[] = []): Promise<string | undefined> {
	serverVersionMismatch = null;
	// Never commit the PATH shim itself — dereference it to its real target
	// (whichSync returns the shim because ~/.dev3.0/bin is first in PATH).
	const preferredReal = dereferenceTmuxShim(preferred);
	const candidates = Array.from(new Set([
		preferredReal,
		...fallbackCandidates.filter((candidate) => candidate !== TMUX_SHIM_PATH),
	].filter((candidate): candidate is string => Boolean(candidate))));
	const validCandidates: Array<{ path: string; version: string }> = [];
	for (const candidate of candidates) {
		if (candidate.startsWith("/") && !isExecutableFile(candidate)) continue;
		const version = await probeTmuxVersion(candidate);
		if (version) validCandidates.push({ path: candidate, version });
	}
	if (preferred === TMUX_SHIM_PATH && preferredReal && !validCandidates.some((candidate) => candidate.path === preferredReal) && isSymlink(TMUX_SHIM_PATH)) {
		log.warn("tmux shim points to an executable that is not tmux — removing it", { shim: TMUX_SHIM_PATH, target: preferredReal });
		try {
			unlinkSync(TMUX_SHIM_PATH);
		} catch {
			log.debug("could not remove invalid tmux shim (already gone?)");
		}
	}
	let chosen = validCandidates[0];
	if (!chosen) {
		log.error("no executable tmux binary found", { preferred, fallbacks: fallbackCandidates });
		return undefined;
	}
	const preferredProbe = await probeTmuxServer(chosen.path, chosen.version, DEFAULT_TMUX_SOCKET);
	if (preferredProbe.status === "mismatch") {
		for (const candidate of validCandidates) {
			if (candidate.path === chosen.path) continue;
			const candidateProbe = await probeTmuxServer(candidate.path, candidate.version, DEFAULT_TMUX_SOCKET);
			if (candidateProbe.status === "compatible") {
				log.warn("preferred tmux binary can't talk to the running dev3 server — falling back until the server restarts", {
					preferred: chosen.path,
					preferredVersion: normalizeTmuxVersion(chosen.version),
					serverVersion: preferredProbe.serverVersion,
					fallback: candidate.path,
					fallbackVersion: normalizeTmuxVersion(candidate.version),
				});
				chosen = candidate;
				break;
			}
		}
		if (chosen.path === validCandidates[0].path && preferredProbe.serverVersion) {
			serverVersionMismatch = {
				clientVersion: normalizeTmuxVersion(chosen.version),
				serverVersion: preferredProbe.serverVersion,
			};
			log.warn("running dev3 tmux server is incompatible with every known tmux binary — a one-time `tmux -L dev3 kill-server` is required", {
				preferred: chosen.path,
				clientVersion: serverVersionMismatch.clientVersion,
				serverVersion: serverVersionMismatch.serverVersion,
			});
		}
	}
	setTmuxBinary(chosen.path);
	updateTmuxShim(chosen.path);
	await warnIfKnownBadTmux(chosen.path);
	return chosen.path;
}

// tmux 3.7 clients busy-spin on a congested server socket (10-35s UI freezes
// when several dev3 instances run at once). Regular single-instance users are
// unaffected, so this is a log-only warning, not a hard failure.
const KNOWN_BAD_TMUX_VERSION = /^tmux 3\.7/;
let badTmuxWarned = false;

async function warnIfKnownBadTmux(binary: string): Promise<void> {
	if (badTmuxWarned) return;
	try {
		const proc = spawn([binary, "-V"], { stdout: "pipe", stderr: "ignore" });
		const version = (await new Response(proc.stdout).text()).trim();
		await proc.exited;
		if (KNOWN_BAD_TMUX_VERSION.test(version)) {
			badTmuxWarned = true;
			log.warn(
				"tmux 3.7 detected — it has a client busy-spin regression when several dev3 instances share a machine. Install the pinned keg: brew trust h0x91b/dev3 && brew install h0x91b/dev3/tmux@3.6",
				{ binary, version },
			);
		}
	} catch {
		log.debug("tmux version probe failed", { binary });
	}
}
