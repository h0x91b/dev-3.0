/**
 * Retention for staged native host images: old, not among the newest, and unused by
 * any live session. Deleting is self-healing (the next launch re-stages the image).
 */

import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isValidImageTag } from "./image-manifest";
import { packagedHostRuntimeCarrier } from "./packaged-image";
import { hostImagesRootDir } from "../paths";
import { isProcessAlive } from "../process-identity";
import { list as listSessions, type SessionListing } from "../registry";

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
	removeDir?: (path: string) => Promise<void>;
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
export async function removeImageDirectory(path: string): Promise<void> {
	for (const name of RUNTIME_CARRIER_NAMES) {
		try {
			await unlink(join(path, name));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	await rm(path, { recursive: true, force: true });
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

async function realDirectoryMtime(path: string): Promise<number | null> {
	try {
		const info = await lstat(path);
		return info.isDirectory() && !info.isSymbolicLink() ? info.mtimeMs : null;
	} catch {
		return null;
	}
}

/** Prune one staging root. Never throws; a failed delete is reported and skipped. */
export async function pruneHostImageRoot(input: PruneInput): Promise<PruneReport> {
	const report: PruneReport = { deleted: [], deletedStaging: [], failed: [], kept: 0 };
	const removeDir = input.removeDir ?? removeImageDirectory;
	let names: string[];
	try {
		names = await readdir(input.root);
	} catch {
		return report;
	}

	const images: { name: string; mtime: number }[] = [];
	const staging: { name: string; mtime: number }[] = [];
	for (const name of names) {
		const isImage = isPackagedImageTag(name);
		if (!isImage && !name.startsWith(STAGING_PREFIX)) continue;
		const mtime = await realDirectoryMtime(join(input.root, name));
		if (mtime === null) continue;
		(isImage ? images : staging).push({ name, mtime });
	}

	const remove = async (name: string, into: string[]): Promise<void> => {
		try {
			await removeDir(join(input.root, name));
			into.push(name);
		} catch (err) {
			report.failed.push({ name, error: String(err) });
		}
	};

	images.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
	const newest = new Set(images.slice(0, KEEP_NEWEST_IMAGES).map((image) => image.name));
	for (const image of images) {
		const dirForms = pathForms(join(input.root, image.name));
		const protectedImage =
			newest.has(image.name) ||
			image.mtime > input.now - KEEP_RECENT_MS ||
			input.liveExecutables.some((executable) => isInside(executable, dirForms));
		if (protectedImage) report.kept += 1;
		else await remove(image.name, report.deleted);
	}
	for (const scratch of staging) {
		if (scratch.mtime < input.now - STALE_STAGING_MS) await remove(scratch.name, report.deletedStaging);
		else report.kept += 1;
	}
	return report;
}

/**
 * Executables of sessions that may still run: owned or reused, and also "dead" ones whose
 * host pid is alive (a host can outlive its shell for a moment).
 */
export function liveHostExecutables(
	sessions: readonly SessionListing[],
	isAlive: (pid: number) => boolean = isProcessAlive,
): string[] {
	return sessions
		.filter((session) => session.state !== "dead" || isAlive(session.record.host.pid))
		.map((session) => session.record.host.executable);
}

export interface PruneHostImagesOptions {
	now?: number;
	root?: string;
	readSessions?: () => Promise<SessionListing[]>;
	isHostAlive?: (pid: number) => boolean;
}

let inFlight: Promise<PruneReport | null> | null = null;

/** Prune the staging root against the session registry; null if one is running or sessions are unreadable. */
export function pruneHostImages(options: PruneHostImagesOptions = {}): Promise<PruneReport | null> {
	if (inFlight) return Promise.resolve(null);
	const run = (async (): Promise<PruneReport | null> => {
		let sessions: SessionListing[];
		try {
			sessions = await (options.readSessions ?? (() => listSessions()))();
		} catch {
			return null;
		}
		return pruneHostImageRoot({
			root: options.root ?? hostImagesRootDir(),
			now: options.now ?? Date.now(),
			liveExecutables: liveHostExecutables(sessions, options.isHostAlive),
		});
	})();
	inFlight = run.finally(() => {
		inFlight = null;
	});
	return inFlight.catch(() => null);
}
