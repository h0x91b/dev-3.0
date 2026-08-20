/**
 * Self-update for a headless `dev3 remote` box: WHICH install method is running,
 * WHAT that method may do about an update, and WHEN a silent update is allowed.
 *
 * Everything contentious about the feature is a pure function here, so the whole
 * matrix is enumerable in a table test and the CLI, the RPC handler and the
 * background loop all read the same verdict. The I/O — brew, tarballs, the
 * cloudflared handoff, the relaunch helper — lives in `src/bun/self-update.ts`.
 *
 * THE DESKTOP UPDATER IS A DIFFERENT MECHANISM AND STAYS ONE. Electrobun's
 * bundle-swap `Updater` is not compiled into the CLI binary at all (it throws
 * "not available in headless mode"), so a headless box cannot swap a bundle; and
 * the GUI cannot run brew. Neither side is a fallback for the other.
 */

import { coreVersion, type UpdateChannel } from "./update-channel";

/** Where the running binary came from. Decides what an update is even allowed to do. */
export type InstallMethod =
	/** `brew install h0x91b/dev3/dev3` — the binary lives in a Cellar keg's libexec. */
	| "brew-formula"
	/** A macOS `.app` bundle (cask, DMG, or a hand-copied build). */
	| "app-bundle"
	/** The CLI tarball extracted anywhere (`~/.dev3`, a container image, …). */
	| "tarball"
	/** `bun run …` from a checkout — no installed artifact to replace. */
	| "source";

/** Bucket where every published CLI tarball lives, one directory per release. */
export const RELEASE_BASE_URL = "https://h0x91b-releases.s3.eu-west-1.amazonaws.com/dev-3.0";

/** Homebrew formula AND cask are both named `dev3` in the `h0x91b/dev3` tap. */
export const BREW_PACKAGE = "dev3";

/**
 * Classify an install from the RESOLVED binary path (symlinks followed) plus the
 * host platform. Pure so every layout in the matrix is a test row rather than a
 * machine someone has to own.
 *
 * `bun` is checked FIRST and by executable name, because a source checkout can
 * sit anywhere — including inside a directory that would otherwise look like a
 * tarball install.
 */
export function detectInstallMethod(resolvedExecPath: string, platform: NodeJS.Platform): InstallMethod {
	const path = resolvedExecPath.replaceAll("\\", "/");
	if (/\/bun(\.exe)?$/i.test(path)) return "source";
	// Homebrew's own prefix varies (/usr/local, /opt/homebrew, /home/linuxbrew/…),
	// so the keg directory is the stable marker, not the prefix.
	if (path.includes(`/Cellar/${BREW_PACKAGE}/`)) return "brew-formula";
	if (platform === "darwin" && /\.app\//.test(path)) return "app-bundle";
	return "tarball";
}

/** What an update would actually do. Every refusal carries the sentence the UI shows. */
export type UpdatePlan =
	| { kind: "up-to-date"; version: string }
	/** Hand the whole job to Homebrew: `brew upgrade [--cask] dev3`. */
	| { kind: "brew"; version: string; cask: boolean; command: string[] }
	/** Download a CLI tarball and extract it over the directory holding the binary. */
	| { kind: "tarball"; version: string; url: string }
	| { kind: "refused"; reason: string };

export interface UpdatePlanInput {
	install: InstallMethod;
	/** The channel the user selected, not the one baked into the build. */
	channel: UpdateChannel;
	platform: NodeJS.Platform;
	/** `process.arch`. */
	arch: string;
	/** Version this process is running. */
	runningVersion: string;
	/** Version brew's Caskroom recorded, or null when brew does not know this bundle. */
	brewCaskVersion: string | null;
	/** The offered build, or null when the check found nothing newer. */
	offered: { version: string; sha?: string } | null;
}

/**
 * Decide what to run, and say why when the answer is "nothing".
 *
 * Three rules carry the whole thing, and they are deliberately in this order:
 *
 *  1. **A build we cannot replace is refused, not attempted.** A source checkout
 *     and a Windows box have no artifact to swap; a `.app` the CLI does not own
 *     would be corrupted by extracting a CLI tarball into it.
 *  2. **The selected channel beats the package manager.** The brew tap only ever
 *     carries stable, so a canary user on a brew install is served the tarball —
 *     which knowingly writes into the Cellar behind brew's back. Serving them a
 *     stable build instead would silently move them off the channel they chose.
 *  3. **The cask is only touched when brew's record matches reality.** The GUI
 *     updater bumps the bundle itself, so most cask installs drift ahead of the
 *     version brew recorded (that is exactly why the cask sets `auto_updates`).
 *     Upgrading in that state can rip the bundle out from under a running server
 *     or die mid-move, so drift is a refusal with the reason spelled out.
 */
export function planUpdate(input: UpdatePlanInput): UpdatePlan {
	if (input.install === "source") {
		return {
			kind: "refused",
			reason:
				"This dev3 is running from source (`bun run …`), which has no installed artifact to replace. " +
				"Pull and rebuild the checkout instead.",
		};
	}
	if (input.platform === "win32") {
		return {
			kind: "refused",
			reason:
				"Self-update is not available on Windows yet — there is no Windows CLI tarball to install. " +
				"Download the current build from the releases page.",
		};
	}
	if (!input.offered) return { kind: "up-to-date", version: input.runningVersion };

	const offered = input.offered;

	if (input.install === "app-bundle") {
		if (input.channel === "canary") {
			return {
				kind: "refused",
				reason:
					"This binary lives inside a macOS app bundle, and the CLI cannot swap a bundle — only the " +
					"desktop app's own updater can. Open the desktop app to take the canary build.",
			};
		}
		if (input.brewCaskVersion === null) {
			return {
				kind: "refused",
				reason:
					"This binary lives inside a macOS app bundle that Homebrew does not manage (a DMG or hand-copied " +
					"install), and the CLI cannot swap a bundle. Update it from the desktop app, or reinstall with " +
					`\`brew install --cask ${BREW_PACKAGE}\` to make self-update available here.`,
			};
		}
		if (coreVersion(input.brewCaskVersion) !== coreVersion(input.runningVersion)) {
			return {
				kind: "refused",
				reason:
					`Homebrew recorded ${input.brewCaskVersion} for the cask but this server is running ` +
					`${input.runningVersion} — the app updated itself past brew's record. A cask upgrade from here can ` +
					"rip the bundle out from under the running server, so it is refused. Run " +
					`\`brew upgrade --cask ${BREW_PACKAGE}\` by hand when nothing is running, or update from the desktop app.`,
			};
		}
		return {
			kind: "brew",
			version: offered.version,
			cask: true,
			command: ["brew", "upgrade", "--cask", BREW_PACKAGE],
		};
	}

	if (input.install === "brew-formula" && input.channel === "stable") {
		return { kind: "brew", version: offered.version, cask: false, command: ["brew", "upgrade", BREW_PACKAGE] };
	}

	// Tarball install, or a brew formula on canary (rule 2 above).
	const url = tarballUrl({
		channel: input.channel,
		platform: input.platform,
		arch: input.arch,
		version: offered.version,
		sha: offered.sha,
	});
	if (!url) {
		return {
			kind: "refused",
			reason:
				"The canary manifest carries no commit sha, so the CLI tarball for this build cannot be located. " +
				"This is a publishing bug — report it rather than working around it.",
		};
	}
	return { kind: "tarball", version: offered.version, url };
}

/**
 * Where the CLI tarball for one published build lives.
 *
 * THE TWO CHANNELS PUBLISH UNDER DIFFERENT DIRECTORY NAMES and neither is
 * derivable from the other: a stable release syncs its artifacts to the TAG
 * (`v1.44.0`), while canary has no tag and syncs to the full COMMIT SHA. The
 * manifest's `sha` is that same full sha, which is what makes the canary path
 * resolvable at all. Returns null when a canary manifest predates the `sha`
 * field, because a guessed directory is a 404 at 3 a.m.
 */
export function tarballUrl(opts: {
	channel: UpdateChannel;
	platform: NodeJS.Platform;
	arch: string;
	version: string;
	sha?: string;
}): string | null {
	const os = opts.platform === "darwin" ? "macos" : "linux";
	const arch = opts.arch === "arm64" ? "arm64" : "x64";
	const dir = opts.channel === "canary" ? opts.sha : `v${coreVersion(opts.version)}`;
	if (!dir) return null;
	return `${RELEASE_BASE_URL}/${dir}/dev3-cli-${os}-${arch}.tar.gz`;
}

/** One-line summary of a plan, shared by `dev3 update --dry-run` and the logs. */
export function describePlan(plan: UpdatePlan, install: InstallMethod): string {
	switch (plan.kind) {
		case "up-to-date":
			return `Already on the current build (${plan.version}); nothing to do.`;
		case "brew":
			return `Detected ${install}; would run \`${plan.command.join(" ")}\` to install ${plan.version}.`;
		case "tarball":
			return `Detected ${install}; would download and extract ${plan.url} to install ${plan.version}.`;
		case "refused":
			return `Detected ${install}; refusing: ${plan.reason}`;
	}
}

// ── The quiet window ────────────────────────────────────────────────────────

/** All three conditions must hold together this long before a silent update fires. */
export const QUIET_HOLD_MS = 10 * 60 * 1000;
/** Past this, politeness stops: only "no task in progress" is still required. */
export const QUIET_CEILING_MS = 72 * 60 * 60 * 1000;
/** A terminal quieter than this counts as "not producing output". */
export const PTY_QUIET_MS = 60 * 1000;

export interface QuietWindowInput {
	/** Tasks currently in the `in-progress` column, across every project. */
	tasksInProgress: number;
	/**
	 * Milliseconds since the freshest terminal output anywhere, or null when the
	 * backend cannot say. NULL IS TREATED AS BUSY, not as quiet: silence from a
	 * probe is not evidence of silence on the box. The ceiling is what keeps that
	 * from pinning a box on an old build forever.
	 */
	ptyIdleMs: number | null;
	/** Browser tabs holding an RPC websocket right now. */
	browserClients: number;
	/** When all conditions last STARTED holding, or null if they are not. */
	quietSinceMs: number | null;
	/** When this update was first seen. Drives the 72-hour ceiling. */
	pendingSinceMs: number;
	now: number;
}

export interface QuietWindowVerdict {
	decision: "apply" | "wait";
	/** Human-readable, logged verbatim so a skipped night is explainable. */
	reason: string;
	/** Feed straight back into the next call — this function owns the hold clock. */
	quietSinceMs: number | null;
}

/**
 * Should a silent update fire right now? A reducer, not a predicate: it owns the
 * "how long has it been quiet" clock so the caller only stores what it returns.
 *
 * If an update has been waiting longer than {@link QUIET_CEILING_MS}, the
 * condition set collapses to "no task in progress" alone — otherwise a browser
 * tab left open on a phone would keep a box on an old build indefinitely, which
 * is the exact failure this whole feature exists to fix.
 */
export function evaluateQuietWindow(input: QuietWindowInput): QuietWindowVerdict {
	const overdue = input.now - input.pendingSinceMs >= QUIET_CEILING_MS;

	if (input.tasksInProgress > 0) {
		return {
			decision: "wait",
			reason: `${input.tasksInProgress} task(s) in progress`,
			quietSinceMs: null,
		};
	}
	if (overdue) {
		return {
			decision: "apply",
			reason: "update has waited past the 72h ceiling and no task is in progress",
			quietSinceMs: input.quietSinceMs,
		};
	}

	if (input.browserClients > 0) {
		return { decision: "wait", reason: `${input.browserClients} browser client(s) connected`, quietSinceMs: null };
	}
	if (input.ptyIdleMs === null) {
		return { decision: "wait", reason: "terminal activity could not be read", quietSinceMs: null };
	}
	if (input.ptyIdleMs < PTY_QUIET_MS) {
		return { decision: "wait", reason: "a terminal is still producing output", quietSinceMs: null };
	}

	const since = input.quietSinceMs ?? input.now;
	const heldMs = input.now - since;
	if (heldMs < QUIET_HOLD_MS) {
		return {
			decision: "wait",
			reason: `quiet for ${Math.floor(heldMs / 1000)}s, need ${QUIET_HOLD_MS / 1000}s`,
			quietSinceMs: since,
		};
	}
	return { decision: "apply", reason: `quiet for ${Math.floor(heldMs / 1000)}s`, quietSinceMs: since };
}
