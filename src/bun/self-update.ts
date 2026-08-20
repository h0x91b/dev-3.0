/**
 * Self-update for a headless `dev3 remote` box: the I/O half.
 *
 * Every DECISION is in `src/shared/self-update.ts` (pure, table-tested). This
 * file only does what a decision asks for: ask brew what it knows, stage a
 * download, swap the files, hand the live tunnel and the port to the successor,
 * and leave a supervisor behind that can undo it.
 *
 * THE SLOW WORK HAPPENS WHILE THE OLD SERVER IS STILL SERVING. Staging (brew
 * fetch, or download + extract) runs with the browser still connected; the apply
 * step is only the fast part — link or rename, then exit. That is what keeps the
 * unreachable window at a few seconds instead of minutes.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "./spawn";
import { createLogger } from "./logger";
import {
	BREW_PACKAGE,
	detectInstallMethod,
	describePlan,
	planUpdate,
	type InstallMethod,
	type UpdatePlan,
} from "../shared/self-update";
import type { UpdateChannel } from "../shared/update-channel";
import { REMOTE_LOG_FILE, REMOTE_ROLLBACK_DIR, readRemoteState, writeRemoteState } from "./remote-state";
import type { RemoteHandoff } from "../shared/types";

const log = createLogger("self-update");

/** Staging + rollback live INSIDE the install dir so every move is a same-filesystem rename. */
const STAGED_DIR_NAME = ".dev3-staged";
const STAGED_TARBALL_NAME = ".dev3-staged.tar.gz";
const PREV_DIR_NAME = ".dev3-prev";

/** The install dir (holds `dev3`, `dist/`, `artifact-template/`, maybe `tmux/`). */
export function installDir(): string {
	return dirname(resolvedExecPath());
}

function resolvedExecPath(): string {
	try {
		return realpathSync(process.execPath);
	} catch {
		return process.execPath;
	}
}

/** How this binary was installed, from the resolved path. */
export function resolveInstallMethod(): InstallMethod {
	return detectInstallMethod(resolvedExecPath(), process.platform);
}

/**
 * The version Homebrew recorded for the `dev3` cask, or null when brew has never
 * heard of it. Null is the honest answer for both "no brew on this box" and "this
 * .app was not installed by brew" — the planner refuses either way, so they do
 * not need telling apart.
 */
export function readBrewCaskVersion(): string | null {
	try {
		const r = spawnSync(["brew", "list", "--cask", "--versions", BREW_PACKAGE]);
		if (r.exitCode !== 0) return null;
		const out = r.stdout ? new TextDecoder().decode(r.stdout).trim() : "";
		// `dev3 1.45.2` — the version is everything after the name.
		const parts = out.split(/\s+/);
		return parts.length >= 2 ? parts[parts.length - 1] : null;
	} catch {
		return null;
	}
}

export interface PlanResult {
	install: InstallMethod;
	plan: UpdatePlan;
	runningVersion: string;
	/** Non-null when the update CHECK itself failed (network, bad manifest). */
	checkError?: string;
	summary: string;
}

/**
 * Check the feed for `channel` and turn the answer into a plan. The check itself
 * already works headless (it only fetches `update.json`), so nothing here needs
 * the Electrobun updater.
 */
export async function buildPlan(channel: UpdateChannel): Promise<PlanResult> {
	const install = resolveInstallMethod();
	const { checkForUpdateWithChannel } = await import("./updater");
	const check = await checkForUpdateWithChannel(channel);
	const runningVersion = check.version;

	if (check.error) {
		const plan: UpdatePlan = { kind: "refused", reason: `Update check failed: ${check.error}` };
		return { install, plan, runningVersion, checkError: check.error, summary: describePlan(plan, install) };
	}

	// A cross-channel offer is a different build, not a newer one, and installing it
	// from here would silently move the box between feeds. The channel setting is the
	// user's; changing it is not this command's job (spec: out of scope).
	if (check.switchTo) {
		const plan: UpdatePlan = {
			kind: "refused",
			reason:
				`The ${channel} feed offers ${check.version}, which is a different channel's build than this one. ` +
				"Self-update does not cross channels — change the channel in Settings and install that build once by hand.",
		};
		return { install, plan, runningVersion, summary: describePlan(plan, install) };
	}

	const plan = planUpdate({
		install,
		channel,
		platform: process.platform,
		arch: process.arch,
		runningVersion,
		brewCaskVersion: install === "app-bundle" ? readBrewCaskVersion() : null,
		offered: check.updateAvailable ? { version: check.version, sha: check.sha } : null,
	});
	return { install, plan, runningVersion, summary: describePlan(plan, install) };
}

// ── Staging ─────────────────────────────────────────────────────────────────

export interface StagedUpdate {
	plan: UpdatePlan;
	/** Only for a tarball plan: the extracted tree waiting to be moved into place. */
	stagedDir?: string;
}

/**
 * Do the slow part while the server is still serving. Brew paths pre-fetch the
 * bottle; the tarball path downloads and extracts into the install dir so the
 * apply step is renames only.
 */
export async function stageUpdate(plan: UpdatePlan): Promise<{ ok: true; staged: StagedUpdate } | { ok: false; error: string }> {
	if (plan.kind === "brew") {
		// `brew update` refreshes the tap (without it the new formula is invisible);
		// `brew fetch` downloads the bottle so `brew upgrade` is a local operation.
		const updated = run(["brew", "update"]);
		if (!updated.ok) log.warn("brew update failed; continuing with the tap as-is", { error: updated.error });
		const fetchArgs = plan.cask ? ["brew", "fetch", "--cask", BREW_PACKAGE] : ["brew", "fetch", BREW_PACKAGE];
		const fetched = run(fetchArgs);
		if (!fetched.ok) return { ok: false, error: `brew fetch failed: ${fetched.error}` };
		return { ok: true, staged: { plan } };
	}
	if (plan.kind === "tarball") {
		const dir = installDir();
		if (!isWritable(dir)) {
			return { ok: false, error: `Install directory is not writable: ${dir}` };
		}
		const tarPath = join(dir, STAGED_TARBALL_NAME);
		const stagedDir = join(dir, STAGED_DIR_NAME);
		rmSync(tarPath, { force: true });
		rmSync(stagedDir, { recursive: true, force: true });
		try {
			const resp = await fetch(plan.url);
			if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} downloading ${plan.url}` };
			await Bun.write(tarPath, resp);
			mkdirSync(stagedDir, { recursive: true });
			const extracted = run(["tar", "-xzf", tarPath, "-C", stagedDir]);
			if (!extracted.ok) return { ok: false, error: `tar extract failed: ${extracted.error}` };
			if (!existsSync(join(stagedDir, "dev3"))) {
				return { ok: false, error: "The extracted tarball has no `dev3` binary — refusing to install it" };
			}
			chmodSync(join(stagedDir, "dev3"), 0o755);
			log.info("Staged tarball update", { url: plan.url, stagedDir });
			return { ok: true, staged: { plan, stagedDir } };
		} catch (err) {
			return { ok: false, error: `Download failed: ${err instanceof Error ? err.message : String(err)}` };
		} finally {
			rmSync(tarPath, { force: true });
		}
	}
	return { ok: false, error: `Nothing to stage for a "${plan.kind}" plan` };
}

// ── Applying ────────────────────────────────────────────────────────────────

export interface AppliedUpdate {
	/** A binary that still runs the OLD build, for the supervisor and for rollback. */
	fallbackBin: string | null;
	/** Views dir that matches `fallbackBin`, when the old tree is still intact. */
	fallbackViews: string | null;
	/** Set for a tarball apply: the directory holding the replaced files. */
	prevDir: string | null;
}

/**
 * Replace the installed build. Fast by construction — everything slow already
 * happened in {@link stageUpdate}.
 *
 * A tarball apply MOVES the files it replaces into `.dev3-prev/` rather than
 * deleting them, which is what gives the supervisor a working binary AND a
 * matching `dist/` to roll back to. A brew apply cannot do that (brew owns the
 * Cellar and may prune the old keg), so it copies just the binary aside first and
 * says so if a rollback ever has to use it.
 */
export function applyUpdate(staged: StagedUpdate): { ok: true; applied: AppliedUpdate } | { ok: false; error: string } {
	const dir = installDir();

	if (staged.plan.kind === "brew") {
		const fallbackBin = copyBinaryAside();
		const fallbackViews = existsSync(join(dir, "dist")) ? join(dir, "dist") : null;
		const r = run(staged.plan.command);
		if (!r.ok) return { ok: false, error: `${staged.plan.command.join(" ")} failed: ${r.error}` };
		return { ok: true, applied: { fallbackBin, fallbackViews, prevDir: null } };
	}

	if (staged.plan.kind === "tarball") {
		const stagedDir = staged.stagedDir;
		if (!stagedDir || !existsSync(stagedDir)) return { ok: false, error: "Staged tree is missing" };
		const prevDir = join(dir, PREV_DIR_NAME);
		rmSync(prevDir, { recursive: true, force: true });
		mkdirSync(prevDir, { recursive: true });
		const entries = readdirSync(stagedDir);
		try {
			for (const entry of entries) {
				const current = join(dir, entry);
				if (existsSync(current)) renameSync(current, join(prevDir, entry));
				renameSync(join(stagedDir, entry), current);
			}
		} catch (err) {
			// A rename failed halfway. Put back whatever we moved so the box keeps a
			// working install, then report — the supervisor is not spawned on failure.
			for (const entry of readdirSync(prevDir)) {
				try {
					rmSync(join(dir, entry), { recursive: true, force: true });
					renameSync(join(prevDir, entry), join(dir, entry));
				} catch { /* best effort — already reporting a failure */ }
			}
			return { ok: false, error: `Swapping files failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		rmSync(stagedDir, { recursive: true, force: true });
		const fallbackBin = existsSync(join(prevDir, "dev3")) ? join(prevDir, "dev3") : null;
		const fallbackViews = existsSync(join(prevDir, "dist")) ? join(prevDir, "dist") : null;
		log.info("Applied tarball update", { dir, replaced: entries });
		return { ok: true, applied: { fallbackBin, fallbackViews, prevDir } };
	}

	return { ok: false, error: `Nothing to apply for a "${staged.plan.kind}" plan` };
}

/** Copy the running binary to `~/.dev3.0/remote/rollback/dev3`. Returns its path, or null. */
function copyBinaryAside(): string | null {
	try {
		mkdirSync(REMOTE_ROLLBACK_DIR, { recursive: true });
		const dest = join(REMOTE_ROLLBACK_DIR, "dev3");
		rmSync(dest, { force: true });
		cpSync(resolvedExecPath(), dest);
		chmodSync(dest, 0o755);
		return dest;
	} catch (err) {
		log.warn("Could not copy the current binary aside — a rollback will have nothing to start", {
			error: String(err),
		});
		return null;
	}
}

// ── Restart ─────────────────────────────────────────────────────────────────

/**
 * Who brings the server back after it exits, and it is NOT one answer.
 *
 *  - `supervisor-exit`: something already owns this process — a systemd unit
 *    (`INVOCATION_ID`), a container, or a human watching a foreground run. Apply,
 *    then exit NON-ZERO so `Restart=on-failure` (or the orchestrator) relaunches
 *    us. No helper: under systemd's default `KillMode=control-group`, every
 *    process left in the unit's cgroup is killed when the unit stops, so a helper
 *    we spawned would die exactly when it is needed. Letting systemd do the
 *    relaunch also keeps `dev3 remote stop` authoritative — a clean stop still
 *    exits 0 and stays stopped.
 *  - `helper`: the background server started by `dev3 remote` (marked by
 *    `DEV3_REMOTE_LOG_FILE`). Nothing supervises it, so it spawns a detached
 *    helper that waits for us to die, starts the new build, and rolls back if the
 *    new build never reports in.
 */
export type RestartStrategy = "helper" | "supervisor-exit";

export function chooseRestartStrategy(env: NodeJS.ProcessEnv): RestartStrategy {
	if (env.INVOCATION_ID) return "supervisor-exit";
	if (env.DEV3_REMOTE_LOG_FILE) return "helper";
	return "supervisor-exit";
}

/** Exit code a self-updated server leaves behind so its supervisor restarts it. */
export const UPDATE_RESTART_EXIT_CODE = 75;

/** Env var carrying the whole supervise job as JSON — one variable, one contract. */
export const SUPERVISE_ENV = "DEV3_UPDATE_SUPERVISE";

export interface SuperviseJob {
	/** PID to wait for before starting anything. */
	waitPid: number;
	/** Binary to start (the NEW build). */
	startBin: string;
	/** Env the new server needs (DEV3_REMOTE_* only). */
	startEnv: Record<string, string>;
	/** Old binary to fall back to, when the new one never reports in. */
	fallbackBin: string | null;
	fallbackViews: string | null;
	/** Move `.dev3-prev/*` back over the install dir before falling back. */
	prevDir: string | null;
	installDir: string;
	logFile: string;
	fromVersion: string;
	toVersion: string;
}

// ── The whole sequence, for the running server ──────────────────────────────

export interface SelfUpdateOutcome {
	ok: boolean;
	/** True when the process is about to exit and be replaced. */
	restarting: boolean;
	message: string;
	version?: string;
}

/**
 * Stage → apply → hand off → exit. Returns instead of exiting when there is
 * nothing to do or something refused, so both the CLI and the RPC handler can
 * report the same sentence.
 *
 * The order matters and is not the obvious one: the tunnel is released and the
 * handoff written only AFTER the apply succeeded. An apply that fails leaves a
 * fully working server with its tunnel still attached and nothing to clean up.
 */
export async function runSelfUpdate(opts: {
	channel: UpdateChannel;
	/** False for `dev3 update` on a box with no server running: install, don't restart. */
	restart: boolean;
	onProgress?: (message: string) => void;
}): Promise<SelfUpdateOutcome> {
	const progress = opts.onProgress ?? ((m: string) => log.info(m));
	const { install, plan, runningVersion, summary } = await buildPlan(opts.channel);
	log.info("Self-update plan", { install, kind: plan.kind, summary });

	if (plan.kind === "up-to-date") return { ok: true, restarting: false, message: summary, version: runningVersion };
	if (plan.kind === "refused") return { ok: false, restarting: false, message: plan.reason };

	progress(`Staging ${plan.version}…`);
	const stagedResult = await stageUpdate(plan);
	if (!stagedResult.ok) return { ok: false, restarting: false, message: stagedResult.error };

	progress(`Installing ${plan.version}…`);
	const appliedResult = applyUpdate(stagedResult.staged);
	if (!appliedResult.ok) return { ok: false, restarting: false, message: appliedResult.error };

	const record = { fromVersion: runningVersion, toVersion: plan.version, startedAt: new Date().toISOString() };

	if (!opts.restart) {
		return {
			ok: true,
			restarting: false,
			message: `Installed ${plan.version}. Nothing was running, so nothing had to restart.`,
			version: plan.version,
		};
	}

	// Only the MAIN tunnel is handed over. Per-port tunnels (`--expose-ports`, the
	// GUI Expose button) each own a cloudflared pointed at a dev-server port, and
	// their URLs are already ephemeral — carrying them across would mean tracking
	// several inherited pids for no gain, so they are stopped here rather than left
	// as orphans for the successor to never claim.
	const { cleanupAllTunnels } = await import("./port-tunnels");
	cleanupAllTunnels();

	const strategy = chooseRestartStrategy(process.env);
	const handoff = await prepareHandoff(strategy);
	persistHandoff(handoff, record);

	if (strategy === "helper") {
		spawnSupervisor({
			waitPid: process.pid,
			startBin: join(installDir(), "dev3"),
			startEnv: collectServerEnv(),
			fallbackBin: appliedResult.applied.fallbackBin,
			fallbackViews: appliedResult.applied.fallbackViews,
			prevDir: appliedResult.applied.prevDir,
			installDir: installDir(),
			logFile: process.env.DEV3_REMOTE_LOG_FILE || REMOTE_LOG_FILE,
			fromVersion: runningVersion,
			toVersion: plan.version,
		});
	}

	log.info("Self-update applied; exiting to be replaced", { strategy, ...record });
	// Give the caller's response a moment to reach the browser / CLI socket before
	// the process disappears under it.
	setTimeout(() => {
		process.exit(strategy === "supervisor-exit" ? UPDATE_RESTART_EXIT_CODE : 0);
	}, 750);

	return {
		ok: true,
		restarting: true,
		message: `Installed ${plan.version}; restarting now.`,
		version: plan.version,
	};
}

/**
 * Collect what the successor needs, and release the tunnel to it.
 *
 * The tunnel is handed over ONLY on the helper path. Under a supervisor the unit's
 * cgroup is torn down when the unit stops, taking `cloudflared` with it no matter
 * what we do here, so the successor starts a fresh tunnel and the public URL
 * changes. That is a real limitation of running under systemd, named rather than
 * papered over.
 */
async function prepareHandoff(strategy: RestartStrategy): Promise<RemoteHandoff> {
	const { getServerPort } = await import("./remote-access-server");
	const port = getServerPort();
	if (strategy !== "helper") {
		log.info("Supervised restart: the tunnel dies with the unit, so the public URL will change");
		return { port, fromPid: process.pid, tunnel: null };
	}
	const { releaseMainTunnelForHandoff } = await import("./cloudflare-tunnel");
	const tunnel = releaseMainTunnelForHandoff();
	return { port, fromPid: process.pid, tunnel };
}

function persistHandoff(handoff: RemoteHandoff, record: { fromVersion: string; toVersion: string; startedAt: string }): void {
	const current = readRemoteState();
	if (!current) {
		log.warn("No remote state on disk to write the handoff into — the successor will start fresh");
		return;
	}
	try {
		writeRemoteState({ ...current, handoff, lastUpdate: record });
	} catch (err) {
		log.warn("Failed to persist the handoff (the successor will just start fresh)", { error: String(err) });
	}
}

/** The DEV3_REMOTE_* shape of this run, so the successor is the same server. */
function collectServerEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("DEV3_REMOTE_")) {
			const value = process.env[key];
			if (value !== undefined) out[key] = value;
		}
	}
	return out;
}

function spawnSupervisor(job: SuperviseJob): void {
	// The supervisor runs the OLD binary on purpose: it is the thing that has to
	// still work when the NEW binary does not. On a tarball apply that is the copy
	// sitting in `.dev3-prev/`; on a brew apply it is the copy taken aside before
	// the upgrade. With neither, there is nothing trustworthy to supervise from.
	const bin = job.fallbackBin;
	if (!bin || !existsSync(bin)) {
		log.warn("No old binary to supervise from — restarting without rollback cover");
		spawnDetached(job.startBin, ["remote", "start", "--no-detach"], job.startEnv, job.logFile);
		return;
	}
	try {
		const proc = spawn([bin, "update", "--supervise"], {
			env: { ...process.env, [SUPERVISE_ENV]: JSON.stringify(job) },
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		proc.unref?.();
		log.info("Spawned update supervisor", { bin, pid: proc.pid });
	} catch (err) {
		log.error("Could not spawn the update supervisor — restarting unsupervised", { error: String(err) });
		spawnDetached(job.startBin, ["remote", "start", "--no-detach"], job.startEnv, job.logFile);
	}
}

/** Start a headless server detached, with its output appended to `logFile`. */
export function spawnDetached(bin: string, args: string[], env: Record<string, string>, logFile: string): number | undefined {
	let logFd: number | "ignore" = "ignore";
	try {
		mkdirSync(dirname(logFile), { recursive: true });
		logFd = openSync(logFile, "a");
	} catch {
		// Unwritable log path — start the server anyway, blind. A running box beats
		// a refusal because its log file could not be opened.
	}
	const proc = spawn([bin, ...args], {
		env: { ...process.env, ...env, DEV3_REMOTE_LOG_FILE: logFile },
		stdout: logFd as never,
		stderr: logFd as never,
		stdin: "ignore",
	});
	proc.unref?.();
	return proc.pid;
}

// ── The supervisor (runs as `dev3 update --supervise`, from the OLD binary) ──

/** How long the new server gets to write its lifecycle state before we roll back. */
export const SUPERVISE_READY_TIMEOUT_MS = 60_000;

/**
 * Wait for the old server to exit, start the new build, and undo the update if the
 * new build never reports in.
 *
 * "Reported in" means it wrote `~/.dev3.0/remote/state.json` with its own pid —
 * which happens only after its remote-access server is bound and listening, so it
 * is a real readiness signal and needs no HTTP probe. A binary that segfaults on
 * start, or dies on a missing dependency, never gets there.
 */
export async function runSupervisor(job: SuperviseJob): Promise<{ ok: boolean; message: string }> {
	const { isProcessAlive } = await import("./remote-state");

	// The old server exits a fraction of a second after spawning us; cap the wait so
	// a wedged process cannot leave the box with no server at all.
	const exitDeadline = Date.now() + 30_000;
	while (isProcessAlive(job.waitPid) && Date.now() < exitDeadline) {
		await delay(200);
	}
	if (isProcessAlive(job.waitPid)) {
		return { ok: false, message: `pid ${job.waitPid} never exited — leaving it alone` };
	}

	const started = spawnDetached(job.startBin, ["remote", "start", "--no-detach"], job.startEnv, job.logFile);
	log.info("Supervisor started the new build", { bin: job.startBin, pid: started, version: job.toVersion });
	if (await waitForServer(started, SUPERVISE_READY_TIMEOUT_MS)) {
		return { ok: true, message: `${job.toVersion} is up (pid ${started})` };
	}

	log.error("The new build never reported in — rolling back", {
		toVersion: job.toVersion,
		fromVersion: job.fromVersion,
	});
	return rollback(job, started);
}

async function rollback(job: SuperviseJob, deadPid: number | undefined): Promise<{ ok: boolean; message: string }> {
	if (deadPid && (await import("./remote-state")).isProcessAlive(deadPid)) {
		try { process.kill(deadPid, "SIGKILL"); } catch { /* already gone */ }
	}

	// Put the replaced tree back, when there is one. This is the only rollback that
	// restores a matching binary AND its `dist/`.
	if (job.prevDir && existsSync(job.prevDir)) {
		for (const entry of readdirSync(job.prevDir)) {
			try {
				rmSync(join(job.installDir, entry), { recursive: true, force: true });
				renameSync(join(job.prevDir, entry), join(job.installDir, entry));
			} catch (err) {
				log.error("Rollback could not restore an entry", { entry, error: String(err) });
			}
		}
		const restarted = spawnDetached(join(job.installDir, "dev3"), ["remote", "start", "--no-detach"], job.startEnv, job.logFile);
		const up = await waitForServer(restarted, SUPERVISE_READY_TIMEOUT_MS);
		return {
			ok: up,
			message: up
				? `rolled back to ${job.fromVersion} (pid ${restarted})`
				: `rolled back to ${job.fromVersion} but it did not come up either`,
		};
	}

	// Brew apply: brew owns the install dir and may have pruned the old keg, so all
	// we have is the copy taken aside. Starting it keeps the box reachable, but the
	// `dev3` on PATH now points at a build that does not boot — say so loudly.
	if (job.fallbackBin && existsSync(job.fallbackBin)) {
		const env = { ...job.startEnv, ...(job.fallbackViews ? { DEV3_VIEWS_DIR: job.fallbackViews } : {}) };
		const restarted = spawnDetached(job.fallbackBin, ["remote", "start", "--no-detach"], env, job.logFile);
		const up = await waitForServer(restarted, SUPERVISE_READY_TIMEOUT_MS);
		log.error("Started the previous build from a copy — the INSTALLED dev3 is broken and needs attention", {
			fallbackBin: job.fallbackBin,
			toVersion: job.toVersion,
		});
		return {
			ok: up,
			message: up
				? `started ${job.fromVersion} from ${job.fallbackBin}; the installed ${job.toVersion} does not boot and needs a manual fix`
				: `neither ${job.toVersion} nor the saved ${job.fromVersion} would start`,
		};
	}

	return { ok: false, message: "nothing to roll back to — the box has no running server" };
}

/** Poll the lifecycle state file until `pid` records itself, or time out. */
async function waitForServer(pid: number | undefined, timeoutMs: number): Promise<boolean> {
	if (!pid) return false;
	const { readRemoteState: read, isProcessAlive } = await import("./remote-state");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = read();
		if (state && state.pid === pid && state.port > 0) return true;
		if (!isProcessAlive(pid)) return false; // died during startup — no point waiting
		await delay(500);
	}
	return false;
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Parse the supervise job out of the env, or null when it is absent/corrupt. */
export function readSuperviseJob(env: NodeJS.ProcessEnv): SuperviseJob | null {
	const raw = env[SUPERVISE_ENV];
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<SuperviseJob>;
		if (typeof parsed.waitPid !== "number" || typeof parsed.startBin !== "string") return null;
		return {
			waitPid: parsed.waitPid,
			startBin: parsed.startBin,
			startEnv: parsed.startEnv ?? {},
			fallbackBin: parsed.fallbackBin ?? null,
			fallbackViews: parsed.fallbackViews ?? null,
			prevDir: parsed.prevDir ?? null,
			installDir: parsed.installDir ?? "",
			logFile: parsed.logFile ?? REMOTE_LOG_FILE,
			fromVersion: parsed.fromVersion ?? "",
			toVersion: parsed.toVersion ?? "",
		};
	} catch {
		return null;
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd: string[]): { ok: boolean; error: string } {
	try {
		const r = spawnSync(cmd);
		if (r.exitCode === 0) return { ok: true, error: "" };
		const stderr = r.stderr ? new TextDecoder().decode(r.stderr).trim() : "";
		return { ok: false, error: stderr || `exit code ${r.exitCode}` };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

function isWritable(dir: string): boolean {
	try {
		const probe = join(dir, `.dev3-write-probe-${process.pid}`);
		mkdirSync(probe);
		rmSync(probe, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}
