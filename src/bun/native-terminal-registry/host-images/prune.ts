/**
 * Retention for staged native host images: old, not among the newest, and unused by
 * any live session. Deleting is self-healing (the next launch re-stages the image).
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isValidImageTag } from "./image-manifest";
import { packagedHostRuntimeCarrier } from "./packaged-image";
import { PACKAGED_HOST_IMAGE_MANIFEST_FILE } from "./packaged-image-manifest";
import { classifyOwnership, type OwnershipVerdict } from "../ownership";
import { hostImagesRootDir, isValidSessionId, sessionsRootDir } from "../paths";
import { isProcessAlive } from "../process-identity";
import { inspectRecordFile, readToken, type NativeSessionRecord } from "../record";

export const KEEP_NEWEST_IMAGES = 2;
export const KEEP_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
export const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

const STAGING_PREFIX = ".staging-";
// `<bun>-p<protocol>-<digest12>`: isValidImageTag alone also admits `foo` or `notes`.
const PACKAGED_TAG_SUFFIX = /-p\d+-[0-9a-f]{12}$/;

function isPackagedImageTag(name: string): boolean {
	return isValidImageTag(name) && PACKAGED_TAG_SUFFIX.test(name);
}

export interface PruneInput {
	root: string;
	now: number;
	/** `host.executable` of every session whose host may still be running. */
	liveExecutables: readonly string[];
	removeDir?: (path: string) => void;
}

export interface PruneReport {
	deleted: string[];
	deletedStaging: string[];
	failed: { name: string; error: string }[];
	kept: number;
}

const RUNTIME_CARRIER_NAMES = [packagedHostRuntimeCarrier("darwin"), packagedHostRuntimeCarrier("win32")];

/**
 * Unlink the runtime carrier first: a locked executable (Windows) then fails the delete
 * with the image still whole, instead of leaving one that staging refuses forever.
 */
export function removeImageDirectory(path: string): void {
	for (const name of RUNTIME_CARRIER_NAMES) {
		try {
			unlinkSync(join(path, name));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	rmSync(path, { recursive: true, force: true });
}

function pathForms(path: string): string[] {
	const forms = [resolve(path)];
	try {
		forms.push(realpathSync(path));
	} catch {
		// A missing path has only its lexical form.
	}
	return forms.map((form) => (process.platform === "win32" ? form.toLowerCase() : form));
}

function isInside(file: string, dirForms: readonly string[]): boolean {
	return pathForms(file).some((candidate) => dirForms.some((dir) => candidate.startsWith(dir + sep)));
}

function directoryMtime(path: string): number | null {
	try {
		const info = lstatSync(path);
		return info.isDirectory() ? info.mtimeMs : null;
	} catch {
		return null;
	}
}

/** Cheap existence checks only: the manifest parses and both files it names are present. */
function isIncompleteImage(imageDir: string): boolean {
	try {
		const manifest = JSON.parse(readFileSync(join(imageDir, PACKAGED_HOST_IMAGE_MANIFEST_FILE), "utf8")) as {
			runtimeCarrier?: unknown;
			artifact?: { entrypoint?: unknown };
		};
		const names = [manifest.runtimeCarrier, manifest.artifact?.entrypoint];
		return !names.every((name) => typeof name === "string" && name !== "" && existsSync(join(imageDir, name)));
	} catch {
		return true;
	}
}

interface ImageState {
	name: string;
	mtime: number;
	incomplete: boolean;
}

/** Prune one staging root. Never throws; a failed delete is reported and skipped. */
export function pruneHostImageRoot(input: PruneInput): PruneReport {
	const report: PruneReport = { deleted: [], deletedStaging: [], failed: [], kept: 0 };
	const removeDir = input.removeDir ?? removeImageDirectory;
	let names: string[];
	try {
		names = readdirSync(input.root);
	} catch {
		return report;
	}

	const imageNames = names.filter(isPackagedImageTag);
	const read = (): ImageState[] =>
		imageNames.flatMap((name) => {
			const dir = join(input.root, name);
			const mtime = directoryMtime(dir);
			return mtime === null ? [] : [{ name, mtime, incomplete: isIncompleteImage(dir) }];
		});
	const order = read().sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));

	const attempt = (name: string, into: string[]): void => {
		try {
			removeDir(join(input.root, name));
			into.push(name);
		} catch (err) {
			report.failed.push({ name, error: String(err) });
		}
	};

	for (const candidate of order) {
		// Re-read everything and delete in one synchronous block: a launch in this process
		// cannot refresh an mtime between the decision and the delete.
		const fresh = read();
		const image = fresh.find((entry) => entry.name === candidate.name);
		if (!image) continue;
		const live = input.liveExecutables.some((executable) => isInside(executable, pathForms(join(input.root, image.name))));
		const newest = fresh
			.filter((entry) => !entry.incomplete)
			.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
			.slice(0, KEEP_NEWEST_IMAGES)
			.some((entry) => entry.name === image.name);
		const protectedImage = live || (!image.incomplete && (newest || image.mtime > input.now - KEEP_RECENT_MS));
		if (protectedImage) report.kept += 1;
		else attempt(image.name, report.deleted);
	}

	for (const name of names) {
		if (!name.startsWith(STAGING_PREFIX)) continue;
		const mtime = directoryMtime(join(input.root, name));
		if (mtime === null) continue;
		if (mtime < input.now - STALE_STAGING_MS) attempt(name, report.deletedStaging);
		else report.kept += 1;
	}
	return report;
}

export interface PruneHostImagesOptions {
	now?: number;
	root?: string;
	isHostAlive?: (pid: number) => boolean;
	classify?: (record: NativeSessionRecord, token: string | null) => Promise<OwnershipVerdict>;
}

/**
 * Executables of sessions that may still run (owned, reused, or "dead" with a live host
 * pid). Null when any session cannot be read: nothing can then be proven unused.
 */
async function readLiveExecutables(options: PruneHostImagesOptions): Promise<string[] | null> {
	const isHostAlive = options.isHostAlive ?? isProcessAlive;
	const classify = options.classify ?? classifyOwnership;
	let entries;
	try {
		entries = readdirSync(sessionsRootDir(), { withFileTypes: true });
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
	}
	const executables: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
		const inspection = inspectRecordFile(entry.name);
		if (!inspection.ok) {
			if (inspection.problem.kind === "absent" || inspection.problem.kind === "missing") continue;
			return null;
		}
		try {
			const verdict = await classify(inspection.record, readToken(entry.name));
			if (verdict !== "dead" || isHostAlive(inspection.record.host.pid)) {
				executables.push(inspection.record.host.executable);
			}
		} catch {
			return null;
		}
	}
	return executables;
}

let inFlight: Promise<PruneReport | null> | null = null;

/** Prune the staging root; null if one is already running or the sessions cannot be read in full. */
export function pruneHostImages(options: PruneHostImagesOptions = {}): Promise<PruneReport | null> {
	if (inFlight) return Promise.resolve(null);
	const run = (async (): Promise<PruneReport | null> => {
		const liveExecutables = await readLiveExecutables(options);
		if (!liveExecutables) return null;
		return pruneHostImageRoot({
			root: options.root ?? hostImagesRootDir(),
			now: options.now ?? Date.now(),
			liveExecutables,
		});
	})();
	inFlight = run.finally(() => {
		inFlight = null;
	});
	return inFlight.catch(() => null);
}
