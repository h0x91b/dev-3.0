/**
 * Who is allowed to write the machine-wide `~/.dev3.0/bin/dev3`.
 *
 * That path is FROZEN and SHARED: agent hooks, the injected dev3 skill and
 * lifecycle onExit commands all invoke the CLI through it (`DEV3_CLI` in
 * `src/shared/agent-hooks.ts`), and every installed version of the app on the
 * machine reads the same `~/.dev3.0` (see the on-disk invariants in AGENTS.md).
 * There is exactly one entry, so whoever writes last owns every agent's CLI.
 *
 * A build that is NOT the installed app must therefore not touch it. Running
 * `bun run dev` in a worktree is a normal, hourly thing on this machine — it
 * must not swap the CLI every other agent and the user are running. Two shapes
 * of that were observed in one night, from two different write paths:
 *   - the headless entry pointed the name at the `bun` binary (every `dev3`
 *     command then died with `Script not found "tasks"`), and
 *   - the GUI entry copied an unmerged branch's 76 MB build over it, which
 *     "works" and is worse, because nobody notices.
 * See `decisions/2026/08/27/dev-builds-never-write-the-managed-cli.md`.
 *
 * The opt-in exists because a developer may genuinely want their branch's CLI
 * on PATH. It is explicit (`DEV3_INSTALL_MANAGED_CLI=1`), never the default, and
 * the way back is the one `dev3 doctor` already prints: relaunch the installed
 * app, which rewrites the name from its own bundle.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { detectInstallMethod } from "../shared/self-update";
import { createLogger } from "./logger";

const log = createLogger("managed-cli-guard");

/** Set to `1` to let a non-installed build write the shared CLI anyway. */
export const MANAGED_CLI_OPT_IN_ENV = "DEV3_INSTALL_MANAGED_CLI";

/** Channel Electrobun bakes into a locally built (`bun run dev`) bundle. */
export const DEV_BUILD_CHANNEL = "dev";

export interface ManagedCliWriteInput {
	/** Channel of the running bundle; `null` when there is none to read. */
	buildChannel: string | null;
	/** `process.execPath` — the binary actually running, not what it would install. */
	execPath: string;
	dev3Home: string;
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
}

export interface ManagedCliWriteVerdict {
	write: boolean;
	/** One sentence, logged verbatim — a skipped write must never be silent. */
	why: string;
}

/**
 * Decide whether this build may write `<dev3Home>/bin/dev3`.
 *
 * Pure, and the rule order is the whole design:
 *
 *  1. A `dev` channel is a positive identification of a local build — and the
 *     ONLY place the opt-in means anything, because a dev build is the only
 *     non-install that has a real CLI binary to hand over.
 *  2. ANY OTHER CHANNEL IS AN INSTALL, and that answer must come BEFORE the
 *     source check — the desktop app's own main process runs a `bun` binary
 *     from inside its bundle, so the source check alone would refuse the
 *     installed app and break the very thing it protects.
 *  3. A bare `bun` (`bun run …`) has no CLI to install at all, so the opt-in
 *     deliberately does NOT reach here: honouring it would aim the shared name
 *     at the bun runtime, which is the exact `Script not found "tasks"` failure
 *     this guard exists to stop.
 *  4. Anything left is a brew keg / tarball / bundle we could not read a channel
 *     from. Fail OPEN — a real install whose layout is unfamiliar keeps working.
 */
export function mayWriteManagedCli(input: ManagedCliWriteInput): ManagedCliWriteVerdict {
	if (input.buildChannel === DEV_BUILD_CHANNEL) {
		if (input.env[MANAGED_CLI_OPT_IN_ENV] === "1") {
			return { write: true, why: `${MANAGED_CLI_OPT_IN_ENV}=1 — this dev build was explicitly allowed` };
		}
		return {
			write: false,
			why: `this is a ${DEV_BUILD_CHANNEL}-channel build, not an install — it must not own the shared CLI`,
		};
	}
	if (input.buildChannel) return { write: true, why: `installed build on the ${input.buildChannel} channel` };
	if (detectInstallMethod(input.execPath, input.platform, input.dev3Home) === "source") {
		return { write: false, why: "this is running from source (`bun run …`), which has no CLI to install" };
	}
	return { write: true, why: "installed build" };
}

/**
 * Read the channel Electrobun baked into the bundle holding `fromPath`.
 *
 * `version.json` always sits in a directory literally named `Resources`, on
 * every platform (`resourcesDir` in electrobun's `Updater.ts`), so walking up
 * for that name is the one lookup that works for the GUI (from the views
 * folder) and for the CLI binary (from `Resources/app/cli/dev3`) alike.
 * Returns null rather than guessing — the caller fails open.
 */
export function resolveBuildChannel(fromPath: string): string | null {
	let dir = fromPath;
	for (let depth = 0; depth < 8; depth++) {
		if (basename(dir) === "Resources") {
			const file = join(dir, "version.json");
			if (existsSync(file)) {
				try {
					const parsed = JSON.parse(readFileSync(file, "utf-8")) as { channel?: unknown };
					if (typeof parsed.channel === "string" && parsed.channel) return parsed.channel;
				} catch {
					return null;
				}
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * The one call every entry point makes before touching `<dev3Home>/bin/dev3`.
 *
 * `bundlePath` is whatever sits inside the running bundle (the views folder for
 * the GUI, the binary itself for a headless server); the channel is read by
 * walking up from it. Logs the verdict either way, so a skipped install is
 * visible in the log rather than looking like the write silently failed.
 */
export function managedCliWriteAllowed(bundlePath: string, dev3Home: string): boolean {
	const verdict = mayWriteManagedCli({
		buildChannel: resolveBuildChannel(bundlePath),
		execPath: process.execPath,
		dev3Home,
		platform: process.platform,
		env: process.env,
	});
	if (verdict.write) log.info("Installing the managed dev3 CLI", { bundlePath, why: verdict.why });
	else log.info("Leaving the managed dev3 CLI alone", { bundlePath, why: verdict.why });
	return verdict.write;
}
