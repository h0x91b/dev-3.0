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
import { spawn } from "./spawn";
import { createLogger } from "./logger";
import {
	BREW_PACKAGE,
	brewLinkedBin,
	detectInstallMethod,
	describePlan,
	planUpdate,
	type InstallMethod,
	type UpdatePlan,
} from "../shared/self-update";
import type { UpdateChannel } from "../shared/update-channel";
import { DEV3_HOME } from "./paths";
import { REMOTE_LOG_FILE, REMOTE_ROLLBACK_DIR, readRemoteState, writeRemoteState } from "./remote-state";
import type { RemoteHandoff } from "../shared/types";

const log = createLogger("self-update");

/** Staging + rollback live INSIDE the install dir so every move is a same-filesystem rename. */
const STAGED_DIR_NAME = ".dev3-staged";
const STAGED_TARBALL_NAME = ".dev3-staged.tar.gz";
const PREV_DIR_NAME = ".dev3-prev";

/**
 * Set alongside `DEV3_VIEWS_DIR` when `headless-entry` resolved that path ITSELF
 * (rather than being handed one), so a restart can tell an inherited guess from an
 * operator's deliberate override. See {@link spawnDetached}.
 */
export const VIEWS_DIR_AUTO_ENV = "DEV3_VIEWS_DIR_AUTO";

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
	return detectInstallMethod(resolvedExecPath(), process.platform, DEV3_HOME);
}

/**
 * The version Homebrew recorded for the `dev3` cask, or null when brew has never
 * heard of it. Null is the honest answer for both "no brew on this box" and "this
 * .app was not installed by brew" — the planner refuses either way, so they do
 * not need telling apart.
 */
export async function readBrewCaskVersion(): Promise<string | null> {
	try {
		const r = await runCapture(["brew", "list", "--cask", "--versions", BREW_PACKAGE]);
		if (!r.ok) return null;
		// `dev3 1.45.2` — the version is everything after the name.
		const parts = r.stdout.trim().split(/\s+/);
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
	const { checkForUpdateWithChannel, getLocalVersion } = await import("./updater");
	const check = await checkForUpdateWithChannel(channel);
	// THE RUNNING VERSION IS READ LOCALLY, NOT TAKEN OFF THE CHECK. `check.version`
	// is the OFFERED build whenever the fetch succeeded, and only falls back to the
	// local one on an error path. Feeding that in made the cask drift comparison
	// always mismatch (so every cask box was permanently refused), and made
	// `lastUpdate` record "X to X".
	const runningVersion = (await getLocalVersion()).version;

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
		brewCaskVersion: install === "app-bundle" ? await readBrewCaskVersion() : null,
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
 * What the last successful {@link stageUpdate} produced, so the release is fetched
 * once per offer rather than once per attempt.
 *
 * THE WATCH PRE-STAGES; THE BUTTON MUST NOT DOWNLOAD. The renderer abandons an
 * RPC call after 120 s, which a ~76 MB download or a `brew fetch` routinely
 * exceeds — so without a warm tree the Restart button toasts a failure for an
 * update that then succeeds and restarts the box underneath the user. Keyed by the
 * plan so a newer offer never reuses an older tree, and re-validated against the
 * disk before reuse.
 */
let lastStaged: { key: string; staged: StagedUpdate } | null = null;

function planKey(plan: UpdatePlan): string {
	return plan.kind === "tarball"
		? `tarball:${plan.url}`
		: plan.kind === "brew"
			? `brew:${plan.cask ? "cask" : "formula"}:${plan.version}`
			: plan.kind;
}

function reusableStaged(plan: UpdatePlan): StagedUpdate | null {
	if (!lastStaged || lastStaged.key !== planKey(plan)) return null;
	const staged = lastStaged.staged;
	if (plan.kind === "tarball") {
		// The tree has to still be there, binary included — an apply that half-ran, or
		// a manual cleanup, must fall through to a fresh download rather than "succeed".
		if (!staged.stagedDir || !existsSync(join(staged.stagedDir, "dev3"))) return null;
	}
	return staged;
}

/** The stage currently running, so a second caller waits instead of racing it. */
let staging: { key: string; promise: Promise<StageResult> } | null = null;

/** Drop the staging memo — only for tests. */
export function _resetStagingMemo(): void {
	lastStaged = null;
	staging = null;
}

type StageResult = { ok: true; staged: StagedUpdate } | { ok: false; error: string };

/**
 * Do the slow part while the server is still serving. Brew paths pre-fetch the
 * bottle; the tarball path downloads and extracts into the install dir so the
 * apply step is renames only.
 *
 * EVERY CHILD PROCESS HERE IS ASYNC ON PURPOSE. `brew update` is routinely tens of
 * seconds and `brew fetch` of a bottle can be minutes; a synchronous spawn blocks
 * the event loop for its full duration (`src/bun/spawn.ts` says so and logs
 * anything over 250 ms), which would take the HTTP server, the RPC websocket, the
 * CLI socket and all tmux forwarding down for that whole span — killing the very
 * browser session the handoff exists to preserve.
 */
export async function stageUpdate(plan: UpdatePlan): Promise<StageResult> {
	const reused = reusableStaged(plan);
	if (reused) {
		log.info("Reusing the already-staged update", { kind: plan.kind });
		return { ok: true, staged: reused };
	}

	// ONE STAGE AT A TIME, because the paths are FIXED. `.dev3-staged.tar.gz` and
	// `.dev3-staged/` are the same two paths for every plan, and the memo is only set
	// after success — so the watch's pre-stage and a Restart press (or a shell
	// `dev3 update`) both miss the reuse check and run concurrently. One caller's
	// `rmSync` then truncates the other's extract, and the only guard before the
	// apply is "is there a `dev3` in there" — which a half-extracted tree passes.
	if (staging) {
		const inFlight = staging;
		const result = await inFlight.promise.catch((err) => ({ ok: false as const, error: String(err) }));
		if (inFlight.key === planKey(plan)) return result;
		return await stageUpdate(plan); // a different offer: retry now the paths are free
	}
	const started: { key: string; promise: Promise<StageResult> } = { key: planKey(plan), promise: undefined as never };
	// The memo is cleared INSIDE the chain, so anyone awaiting `started.promise`
	// already sees a free slot and cannot spin waiting on a settled promise.
	started.promise = stageOnce(plan).finally(() => {
		if (staging === started) staging = null;
	});
	staging = started;
	return await started.promise;
}

async function stageOnce(plan: UpdatePlan): Promise<StageResult> {
	if (plan.kind === "brew") {
		// `brew update` refreshes the tap (without it the new formula is invisible);
		// `brew fetch` downloads the bottle so `brew upgrade` is a local operation.
		const updated = await run(["brew", "update"]);
		if (!updated.ok) log.warn("brew update failed; continuing with the tap as-is", { error: updated.error });
		const fetchArgs = plan.cask ? ["brew", "fetch", "--cask", BREW_PACKAGE] : ["brew", "fetch", BREW_PACKAGE];
		const fetched = await run(fetchArgs);
		if (!fetched.ok) return { ok: false, error: `brew fetch failed: ${fetched.error}` };
		const staged: StagedUpdate = { plan };
		lastStaged = { key: planKey(plan), staged };
		return { ok: true, staged };
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
			const extracted = await run(["tar", "-xzf", tarPath, "-C", stagedDir]);
			if (!extracted.ok) return { ok: false, error: `tar extract failed: ${extracted.error}` };
			if (!existsSync(join(stagedDir, "dev3"))) {
				return { ok: false, error: "The extracted tarball has no `dev3` binary — refusing to install it" };
			}
			chmodSync(join(stagedDir, "dev3"), 0o755);
			log.info("Staged tarball update", { url: plan.url, stagedDir });
			const staged: StagedUpdate = { plan, stagedDir };
			lastStaged = { key: planKey(plan), staged };
			return { ok: true, staged };
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
	/**
	 * Views dir that PROVABLY matches `fallbackBin`. Only the tarball path has one
	 * (its old `dist/` was moved aside, not overwritten); a brew apply leaves null
	 * rather than a path brew has since replaced with the new bundle.
	 */
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
export async function applyUpdate(
	staged: StagedUpdate,
	/** Where the files live. A parameter so a test can point it at a temp tree. */
	dir: string = installDir(),
): Promise<{ ok: true; applied: AppliedUpdate } | { ok: false; error: string }> {

	if (staged.plan.kind === "brew") {
		// THE BUNDLE IS COPIED, NOT POINTED AT. `<installDir>/dist` is a path, not a
		// snapshot: brew replaces the whole keg (or the whole `.app`), so by rollback time
		// it holds the NEW renderer bundle. Leaving `fallbackViews` null instead was
		// worse, not safer — the rollback copy sits in `~/.dev3.0/remote/rollback/`, where
		// none of the successor's probe candidates resolve, so the box came back reachable
		// and served an EMPTY page. A few megabytes of Vite output, taken aside once per
		// brew update, buys a rollback that serves the UI its own server was built with.
		const { bin: fallbackBin, views: fallbackViews } = copyBuildAside();
		const r = await run(staged.plan.command);
		if (!r.ok) return { ok: false, error: `${staged.plan.command.join(" ")} failed: ${r.error}` };
		lastStaged = null; // the staged bottle is spent
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
			//
			// THE STAGED TREE IS NOW PARTIAL AND MUST NOT BE REUSED. The entries that made
			// it across were MOVED out of `.dev3-staged`, and `reusableStaged` only checks
			// that a `dev3` is still in there — so a failure on an entry ordered after
			// `dev3` left a tree that passes the check and would install the new binary
			// against the OLD `dist` on the next attempt.
			lastStaged = null;
			rmSync(stagedDir, { recursive: true, force: true });
			for (const entry of readdirSync(prevDir)) {
				try {
					rmSync(join(dir, entry), { recursive: true, force: true });
					renameSync(join(prevDir, entry), join(dir, entry));
				} catch { /* best effort — already reporting a failure */ }
			}
			return { ok: false, error: `Swapping files failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		rmSync(stagedDir, { recursive: true, force: true });
		lastStaged = null; // the staged tree has been moved into place
		const fallbackBin = existsSync(join(prevDir, "dev3")) ? join(prevDir, "dev3") : null;
		const fallbackViews = existsSync(join(prevDir, "dist")) ? join(prevDir, "dist") : null;
		log.info("Applied tarball update", { dir, replaced: entries });
		return { ok: true, applied: { fallbackBin, fallbackViews, prevDir } };
	}

	return { ok: false, error: `Nothing to apply for a "${staged.plan.kind}" plan` };
}

/**
 * Copy the running build into `~/.dev3.0/remote/rollback/` — the binary, and the
 * renderer bundle beside it when there is one.
 *
 * Only the brew paths need this: brew owns the Cellar (or the whole `.app`) and may
 * prune what it replaces, so a rollback has nothing to go back to unless a copy was
 * taken first. The tarball path moves its predecessor into `.dev3-prev/` instead,
 * which is a rename and needs no copy at all.
 *
 * A missing bundle is not fatal and does not cost the binary: the server still comes
 * back, it just serves nothing until the install is fixed by hand.
 */
function copyBuildAside(): { bin: string | null; views: string | null } {
	let bin: string | null = null;
	try {
		mkdirSync(REMOTE_ROLLBACK_DIR, { recursive: true });
		const dest = join(REMOTE_ROLLBACK_DIR, "dev3");
		rmSync(dest, { force: true });
		cpSync(resolvedExecPath(), dest);
		chmodSync(dest, 0o755);
		bin = dest;
	} catch (err) {
		log.warn("Could not copy the current binary aside — a rollback will have nothing to start", {
			error: String(err),
		});
		return { bin: null, views: null };
	}
	const source = process.env.DEV3_VIEWS_DIR || join(installDir(), "dist");
	if (!existsSync(join(source, "index.html"))) {
		log.warn("No renderer bundle found beside the running build — a rollback would serve nothing", { source });
		return { bin, views: null };
	}
	try {
		const dest = join(REMOTE_ROLLBACK_DIR, "dist");
		rmSync(dest, { recursive: true, force: true });
		cpSync(source, dest, { recursive: true });
		return { bin, views: dest };
	} catch (err) {
		log.warn("Could not copy the renderer bundle aside — a rollback would serve nothing", {
			source,
			error: String(err),
		});
		return { bin, views: null };
	}
}

// ── Restart ─────────────────────────────────────────────────────────────────

/**
 * Who brings the server back after it exits, and it is NOT one answer.
 *
 *  - `supervisor-exit`: something already owns this process and is PROVEN to —
 *    a systemd unit (`INVOCATION_ID`) or a container runtime. Apply, then exit
 *    NON-ZERO so `Restart=on-failure` (or the orchestrator) relaunches us. No
 *    helper: under systemd's default `KillMode=control-group`, every process left
 *    in the unit's cgroup is killed when the unit stops, so a helper we spawned
 *    would die exactly when it is needed — and a container's helper dies with the
 *    container. Letting the supervisor do the relaunch also keeps `dev3 remote
 *    stop` authoritative: a clean stop still exits 0 and stays stopped.
 *  - `helper`: the background server started by `dev3 remote` (marked by
 *    `DEV3_REMOTE_LOG_FILE`), and every OTHER non-interactive run. Nothing
 *    supervises those, so a detached helper waits for us to die, starts the new
 *    build, and rolls back if the new build never reports in.
 *  - `none`: an INTERACTIVE `dev3 remote --no-detach` — a human watching a
 *    terminal is not a supervisor. Exiting there leaves the box dark until
 *    somebody notices, which is exactly what this feature exists to prevent, so
 *    the update is installed and the restart is left to the operator.
 *
 * SUPERVISOR-EXIT NEEDS POSITIVE EVIDENCE, and "no TTY" is not evidence.
 * `nohup dev3 remote start --no-detach >log 2>&1 &`, a CI runner, and any launcher
 * that redirects stdout all have no TTY, no `INVOCATION_ID` and nothing that
 * restarts them — exiting 75 there leaves the box permanently unreachable. An
 * unnecessary helper, by contrast, costs one short-lived process.
 */
export type RestartStrategy = "helper" | "supervisor-exit" | "none";

/** Is this process inside a container runtime, by the markers runtimes leave on disk? */
export function inContainer(): boolean {
	return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

export function chooseRestartStrategy(
	env: NodeJS.ProcessEnv,
	isTTY: boolean = Boolean(process.stdout.isTTY),
	containerized: boolean = inContainer(),
): RestartStrategy {
	if (env.INVOCATION_ID) return "supervisor-exit";
	if (env.container) return "supervisor-exit"; // podman / systemd-nspawn set this
	if (containerized) return "supervisor-exit";
	if (env.DEV3_REMOTE_LOG_FILE) return "helper";
	return isTTY ? "none" : "helper";
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
	/**
	 * True when NOTHING WAS TOUCHED because this install may not be updated from
	 * here. Distinct from a plain `ok: false`, which means an update was attempted
	 * and failed — the CLI's documented exit codes turn on exactly this difference,
	 * and automation that treats "unsupported install" as "skip" must not swallow a
	 * failed download.
	 */
	refused?: boolean;
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
	/**
	 * True for the background watch. Nobody asked, so anything that cannot finish
	 * cleanly is declined rather than half-done — a human pressing the button gets
	 * told instead.
	 */
	silent?: boolean;
	onProgress?: (message: string) => void;
}): Promise<SelfUpdateOutcome> {
	const progress = opts.onProgress ?? ((m: string) => log.info(m));
	const { install, plan, runningVersion, summary } = await buildPlan(opts.channel);
	log.info("Self-update plan", { install, kind: plan.kind, summary });

	if (plan.kind === "up-to-date") return { ok: true, restarting: false, message: summary, version: runningVersion };
	if (plan.kind === "refused") return { ok: false, refused: true, restarting: false, message: plan.reason };

	// NOTHING IS DOWNLOADED WHEN THE RESTART CANNOT HAPPEN. An interactive
	// `--no-detach` run has no supervisor, so a silent update would install a build
	// this process cannot become — and, because the running version never changes,
	// re-download it every quiet window forever.
	const strategy = opts.restart ? chooseRestartStrategy(process.env) : "none";
	if (opts.silent && strategy === "none") {
		return {
			ok: false,
			refused: true,
			restarting: false,
			message:
				`${plan.version} is available, but this server runs in the foreground with nothing to relaunch it, ` +
				"so it will not update itself. Press Update, or run `dev3 update` and restart it.",
		};
	}

	progress(`Staging ${plan.version}…`);
	const stagedResult = await stageUpdate(plan);
	if (!stagedResult.ok) return { ok: false, restarting: false, message: stagedResult.error };

	progress(`Installing ${plan.version}…`);
	const appliedResult = await applyUpdate(stagedResult.staged);
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

	if (strategy === "none") {
		// Installed, but exiting would take the box down for good: nothing out here
		// relaunches an interactive foreground run. Keep serving the old build in
		// memory and hand the restart back to the person watching the terminal.
		log.warn("Update installed but this run has no supervisor — leaving the restart to the operator", {
			toVersion: plan.version,
		});
		return {
			ok: true,
			restarting: false,
			message: `Installed ${plan.version}. This server runs in the foreground, so restart it yourself to pick it up.`,
			version: plan.version,
		};
	}

	const handoff = await prepareHandoff(strategy);
	persistHandoff(handoff, record);

	if (strategy === "helper") {
		const spawned = spawnSupervisor({
			waitPid: process.pid,
			startBin: newBuildBin(plan),
			startEnv: collectServerEnv(),
			fallbackBin: appliedResult.applied.fallbackBin,
			fallbackViews: appliedResult.applied.fallbackViews,
			prevDir: appliedResult.applied.prevDir,
			installDir: installDir(),
			logFile: process.env.DEV3_REMOTE_LOG_FILE || REMOTE_LOG_FILE,
			fromVersion: runningVersion,
			toVersion: plan.version,
		});
		if (!spawned) {
			// Exiting now would leave no server at all. The files are already swapped,
			// so staying up on the old build in memory is the least-bad state — and the
			// operator has something to read instead of a dark box.
			log.error("No relaunch helper could be started — staying up on the old build", { toVersion: plan.version });
			await clearHandoff(handoff);
			return {
				ok: false,
				restarting: false,
				message: `Installed ${plan.version} but could not start the relaunch helper, so nothing restarted. Restart the server by hand.`,
			};
		}
	}

	// ONLY NOW ARE THE PER-PORT TUNNELS GIVEN UP. `--expose-ports` and the GUI Expose
	// button each own a cloudflared pointed at a dev-server port; their URLs are
	// ephemeral, so they are stopped rather than left as orphans the successor never
	// claims. Stopping them BEFORE the supervisor was confirmed meant an abandoned
	// restart left a live server whose every exposed link was dead, with nothing to
	// restore them — the main tunnel is re-adopted on that path, these were not.
	const { cleanupAllTunnels } = await import("./port-tunnels");
	cleanupAllTunnels();

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
 * Which binary IS the new build, once the plan has been applied.
 *
 * A tarball apply replaces the files in place, so the path this process was
 * started from is already the new build. A brew FORMULA upgrade does not: the new
 * build lands in a new version-pinned keg and only `<prefix>/bin/dev3` moves, so
 * restarting `installDir()/dev3` would relaunch the OLD keg — coming back on the
 * old version, reporting in as a success, and offering the same update every 30
 * minutes forever (or finding nothing at all, if brew pruned the keg).
 *
 * A cask replaces `/Applications/dev-3.0.app` in place, so it needs no
 * substitution either — only the formula does.
 */
function newBuildBin(plan: UpdatePlan): string {
	const inPlace = join(installDir(), "dev3");
	if (plan.kind !== "brew" || plan.cask) return inPlace;
	const linked = brewLinkedBin(resolvedExecPath());
	if (!linked) {
		log.warn("Brew formula upgrade but the keg prefix could not be derived — restarting the path we were started from", {
			execPath: resolvedExecPath(),
		});
		return inPlace;
	}
	return linked;
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
	const { releaseMainTunnelForHandoff, stopTunnel } = await import("./cloudflare-tunnel");
	const tunnel = releaseMainTunnelForHandoff();
	if (!tunnel) {
		// NOTHING TO HAND OVER IS NOT NOTHING TO DO. The release only succeeds on a
		// `connected` entry, so an update landing during the tunnel's start window (the
		// URL wait alone is up to 30 s, and a health-triggered restart re-enters it) gets
		// null — while that cloudflared is still OUR child, and `process.exit` does not
		// kill children. Left alone it outlives us as an orphan nobody tracks, and the
		// successor starts a second one.
		log.info("No live main tunnel to hand over — stopping it rather than leaking it");
		stopTunnel();
	}
	return { port, fromPid: process.pid, tunnel };
}

/**
 * Undo a handoff we are not going to use, because no successor is coming.
 *
 * Two things have to be taken back, or the still-running box is quietly broken:
 * the record on disk (a later start would try to adopt a tunnel long dead by
 * then), and the tunnel itself — `releaseMainTunnelForHandoff` dropped it from
 * the map without signalling it, so re-adopting is what puts it back under the
 * health monitor and under `stopTunnel` at shutdown.
 *
 * THE HANDOFF IS PASSED IN, NEVER RE-READ. `readRemoteState()` sanitizes a handoff
 * away whenever its `fromPid` is still alive (that check is what stops a successor
 * from stealing a live server's tunnel) — and here `fromPid` is our own pid, so a
 * re-read always returns null and this whole function would silently do nothing.
 */
async function clearHandoff(handoff: RemoteHandoff): Promise<void> {
	const current = readRemoteState();
	if (current) {
		try {
			writeRemoteState({ ...current, handoff: null });
		} catch (err) {
			log.warn("Could not clear the unused handoff record", { error: String(err) });
		}
	}
	const tunnel = handoff.tunnel;
	if (!tunnel) return;
	try {
		const { adoptMainTunnel } = await import("./cloudflare-tunnel");
		const { getServerPort } = await import("./remote-access-server");
		adoptMainTunnel({ ...tunnel, targetPort: getServerPort() });
		log.info("Took our own tunnel back after the restart was abandoned", { pid: tunnel.pid });
	} catch (err) {
		log.warn("Could not re-adopt the released tunnel — it is still running but unmanaged", {
			error: String(err),
		});
	}
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

/**
 * Start the relaunch helper, and return whether one is actually coming.
 *
 * NOTHING HERE MAY START A SERVER DIRECTLY. This process still holds the port for
 * another ~750 ms, so a direct `spawnDetached` races its own predecessor: the
 * successor's `EADDRINUSE` kills it, the handoff is rejected because our pid is
 * still alive (leaving the deliberately-leaked cloudflared orphaned *and*
 * unadopted), and both servers briefly write the same state file. Every helper
 * therefore goes through `dev3 update --supervise`, which waits for our pid first.
 *
 * Preferring the OLD binary is the point: it is the thing that has to still work
 * when the new one does not. With no old binary the NEW one supervises itself —
 * worse cover, but it still waits — and if even that cannot be spawned we say so
 * and stay alive rather than exit into an empty box.
 */
function spawnSupervisor(job: SuperviseJob): boolean {
	const candidates = [job.fallbackBin, job.startBin].filter(
		(bin): bin is string => Boolean(bin) && existsSync(bin as string),
	);
	if (!job.fallbackBin || !existsSync(job.fallbackBin)) {
		log.warn("No old binary to supervise from — the new build will supervise itself, with no rollback cover");
	}
	for (const bin of candidates) {
		try {
			const proc = spawn([bin, "update", "--supervise"], {
				env: { ...process.env, [SUPERVISE_ENV]: JSON.stringify(job) },
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			});
			proc.unref?.();
			log.info("Spawned update supervisor", { bin, pid: proc.pid });
			return true;
		} catch (err) {
			log.error("Could not spawn the update supervisor from this binary", { bin, error: String(err) });
		}
	}
	return false;
}

/**
 * Start a headless server detached, with its output appended to `logFile`.
 *
 * A VIEWS DIR WE RESOLVED FOR OURSELVES MUST NOT TRAVEL TO THE SUCCESSOR.
 * `headless-entry` probes `dist/` at startup and writes the answer into
 * `DEV3_VIEWS_DIR` (marking it with {@link VIEWS_DIR_AUTO_ENV}), and every child
 * inherits the whole environment twice over — so the new build would serve the
 * PREDECESSOR's bundle. Harmless for a tarball apply (same path, replaced in
 * place), wrong for a brew formula upgrade whose new build lives in a new keg, and
 * it also silently undoes `applyUpdate`'s deliberate `fallbackViews: null`: the
 * rolled-back OLD binary would inherit a path that now holds the NEW bundle.
 *
 * Blanked rather than deleted, because `src/bun/spawn.ts` re-merges `process.env`
 * over whatever we pass; an empty value is what both readers treat as unset. An
 * explicit `DEV3_VIEWS_DIR` in `env` (the rollback path) still wins.
 */
export function spawnDetached(bin: string, args: string[], env: Record<string, string>, logFile: string): number | undefined {
	let logFd: number | "ignore" = "ignore";
	try {
		mkdirSync(dirname(logFile), { recursive: true });
		logFd = openSync(logFile, "a");
	} catch {
		// Unwritable log path — start the server anyway, blind. A running box beats
		// a refusal because its log file could not be opened.
	}
	const inherited: Record<string, string> = {};
	if (process.env[VIEWS_DIR_AUTO_ENV] && !env.DEV3_VIEWS_DIR) inherited.DEV3_VIEWS_DIR = "";
	const proc = spawn([bin, ...args], {
		env: { ...process.env, ...inherited, ...env, [VIEWS_DIR_AUTO_ENV]: "", DEV3_REMOTE_LOG_FILE: logFile },
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
	const result = await rollback(job, started);
	// THE ROLLBACK IS THE FAILURE NOBODY WAS COUNTING. `runSelfUpdate` already
	// returned "ok, restarting" and that process is gone, so the only place this can
	// be recorded is on disk — and it has to be recorded, or the restored build's
	// watch starts from zero and re-downloads the same broken release every quiet
	// window. Written AFTER the restore, so the restored server's state file is the
	// one that carries it.
	const { recordUpdateFailure } = await import("./remote-state");
	recordUpdateFailure(job.toVersion, `${job.toVersion} did not boot; rolled back (${result.message})`);
	return result;
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

/**
 * Run a child to completion WITHOUT blocking the event loop.
 *
 * Deliberately not `spawnSync`: every command here (`brew update`, `brew fetch`,
 * `brew upgrade`, `tar -xzf` of a ~76 MB binary) takes seconds to minutes, and a
 * synchronous spawn would freeze the server's single event loop for all of it —
 * no HTTP, no websocket, no CLI socket, no tmux output — which is the opposite of
 * "the slow work happens while the old server is still serving".
 */
async function run(cmd: string[]): Promise<{ ok: boolean; error: string }> {
	const r = await runCapture(cmd);
	return { ok: r.ok, error: r.ok ? "" : r.error };
}

async function runCapture(cmd: string[]): Promise<{ ok: boolean; stdout: string; error: string }> {
	try {
		const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout as unknown as ReadableStream).text(),
			new Response(proc.stderr as unknown as ReadableStream).text(),
			proc.exited,
		]);
		if (exitCode === 0) return { ok: true, stdout, error: "" };
		return { ok: false, stdout, error: stderr.trim() || `exit code ${exitCode}` };
	} catch (err) {
		return { ok: false, stdout: "", error: err instanceof Error ? err.message : String(err) };
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
