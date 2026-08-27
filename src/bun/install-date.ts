/**
 * When dev-3.0 was first installed on this machine, as one epoch-ms number.
 *
 * SEEDED FROM THE DATA DIRECTORY'S BIRTH TIME, NOT FROM "NOW". `~/.dev3.0` is
 * created on the very first launch, so its birth time is the install date — and
 * reading it means the install-age analytics work retroactively for everyone who
 * already runs dev3, instead of declaring the entire existing user base
 * brand-new the day this shipped.
 *
 * It is then written down once, because birth time is not universally available:
 * several Linux filesystems and some Windows configurations report 0 or fall back
 * to the modification time, and `~/.dev3.0` is modified constantly — an install
 * from February would keep looking like it happened this morning. After the first
 * write the recorded value is the only thing anyone reads.
 *
 * Its own file rather than a field in `settings.json`: the file is additive, so
 * every other installed version of the app carries on reading a settings file it
 * fully understands (see the on-disk invariants in AGENTS.md).
 */

import { readFileSync, statSync } from "node:fs";
import { DEV3_HOME } from "./paths";
import { atomicWriteFile } from "./atomic-write";
import { createLogger } from "./logger";

const log = createLogger("install-date");

const INSTALL_DATE_FILE = `${DEV3_HOME}/install-date.json`;

/** Sanity floor: dev-3.0 did not exist before 2025. Anything older is a broken stat. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2025, 0, 1);

function readRecorded(): number | null {
	try {
		const parsed = JSON.parse(readFileSync(INSTALL_DATE_FILE, "utf-8")) as { installedAt?: unknown };
		const value = parsed.installedAt;
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

/** Birth time of the data directory, or null when the filesystem will not say. */
function birthTimeOfDataDir(nowMs: number): number | null {
	try {
		// Floored: birthtimeMs carries sub-millisecond precision, and an unfloored
		// value is "in the future" against a Date.now() taken in the same millisecond.
		const ms = Math.floor(statSync(DEV3_HOME).birthtimeMs);
		if (!Number.isFinite(ms) || ms < EARLIEST_PLAUSIBLE_MS || ms > nowMs) return null;
		return ms;
	} catch {
		return null;
	}
}

/** The install date, recorded on first call so later calls never re-guess it. */
export async function resolveInstallDate(nowMs: number = Date.now()): Promise<number> {
	const recorded = readRecorded();
	if (recorded !== null) return recorded;

	// No record yet: this is either a genuinely fresh install (birth time is a few
	// seconds ago) or an existing one meeting this code for the first time (birth
	// time is however old it really is). Both are the same read.
	const installedAt = birthTimeOfDataDir(nowMs) ?? nowMs;
	try {
		await atomicWriteFile(INSTALL_DATE_FILE, JSON.stringify({ installedAt }, null, 2));
	} catch (err) {
		log.warn("could not record the install date", { error: String(err) });
	}
	return installedAt;
}
