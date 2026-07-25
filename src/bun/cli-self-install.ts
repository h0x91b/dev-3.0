import { copyFileSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINDOWS_DEV3_CLI_BASENAME } from "../shared/dev3-cli-path";
import { createLogger } from "./logger";

const log = createLogger("cli-self-install");

export type Dev3CliSymlinkResult = "unchanged" | "linked" | "copied" | "shimmed" | "skipped";

/**
 * Ensure `<dev3Home>/bin/dev3` is a working symlink to the running binary.
 *
 * Agent hooks, the injected dev3 skill, and lifecycle onExit commands all invoke
 * the CLI by that absolute path (see `DEV3_CLI` in `src/shared/agent-hooks.ts`).
 * The GUI app (`index.ts`) copies the binary there on every launch and the
 * Settings toggle symlinks it, but a headless `dev3 remote` box does neither — so
 * a stale/dangling entry there makes every hook fail with
 * `/bin/sh: …/.dev3.0/bin/dev3: not found` even though `ls` shows the name.
 *
 * `execPath` is resolved with `realpathSync` first, which (a) follows brew's
 * `bin/dev3 → …/libexec/dev3` indirection to a concrete binary and (b) guarantees
 * the source is never the `<bin>/dev3` symlink itself, so we can't create a
 * self-referential link (the ELOOP class of bug, decision 105). Best-effort:
 * every failure is logged and swallowed so it never blocks server startup.
 *
 * On Windows the destination is `dev3.exe`, where a symlink needs elevation or
 * Developer Mode — so the link attempt degrades to a copy, and then to a `.cmd`
 * shim beside it (typical when the copy is refused because the exe is running).
 */
export function ensureDev3CliSymlink(
	dev3Home: string,
	execPath: string,
	platform: NodeJS.Platform = process.platform,
): Dev3CliSymlinkResult {
	const windows = platform === "win32";
	const binDir = join(dev3Home, "bin");
	const dest = join(binDir, windows ? WINDOWS_DEV3_CLI_BASENAME : "dev3");

	let source: string;
	try {
		source = realpathSync(execPath);
	} catch (err) {
		log.warn("Could not resolve the running binary — skipping dev3 CLI symlink", { execPath, error: String(err) });
		return "skipped";
	}

	// Never link a concrete file onto itself (would need dest === the real binary,
	// which only happens if someone dropped the binary there directly — leave it).
	if (source === dest) return "unchanged";

	try {
		if (realpathSync(dest) === source) return "unchanged"; // already points at us
	} catch {
		// dest is missing or dangling — (re)create it below.
	}

	try {
		mkdirSync(binDir, { recursive: true });
		try { unlinkSync(dest); } catch { /* nothing to replace */ }
		if (windows) symlinkSync(source, dest, "file");
		else symlinkSync(source, dest);
		log.info("dev3 CLI symlink ensured", { from: source, to: dest });
		return "linked";
	} catch (err) {
		if (!windows) {
			log.warn("Failed to ensure dev3 CLI symlink (non-fatal)", { error: String(err) });
			return "skipped";
		}
		log.info("Windows symlink unavailable (needs elevation or Developer Mode) — falling back", {
			error: String(err),
		});
	}

	try {
		copyFileSync(source, dest);
		log.info("dev3 CLI copied", { from: source, to: dest });
		return "copied";
	} catch (err) {
		log.info("Could not copy the dev3 CLI — writing a .cmd shim instead", { error: String(err) });
	}

	const shim = join(binDir, "dev3.cmd");
	try {
		writeFileSync(shim, `@echo off\r\n"${source}" %*\r\n`, "utf-8");
		log.info("dev3 CLI shim written", { shim, target: source });
		return "shimmed";
	} catch (err) {
		log.warn("Failed to install the dev3 CLI on this machine (non-fatal)", { error: String(err) });
		return "skipped";
	}
}
