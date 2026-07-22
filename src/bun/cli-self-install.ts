import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger";

const log = createLogger("cli-self-install");

export type Dev3CliSymlinkResult = "unchanged" | "linked" | "skipped";

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
 */
export function ensureDev3CliSymlink(dev3Home: string, execPath: string): Dev3CliSymlinkResult {
	const binDir = join(dev3Home, "bin");
	const dest = join(binDir, "dev3");

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
		symlinkSync(source, dest);
		log.info("dev3 CLI symlink ensured", { from: source, to: dest });
		return "linked";
	} catch (err) {
		log.warn("Failed to ensure dev3 CLI symlink (non-fatal)", { error: String(err) });
		return "skipped";
	}
}
