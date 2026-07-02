import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { SharedImage } from "../shared/types";
import { MAX_SHARED_IMAGE_BYTES, SHARED_IMAGE_EXTS } from "../shared/types";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("shared-images");

const SUPPORTED_EXTS = new Set(SHARED_IMAGE_EXTS);

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

/** Frozen slug algorithm (mirrors git.ts / app-handlers). Do not change. */
function projectSlug(projectPath: string): string {
	return projectPath.replace(/^\//, "").replaceAll("/", "-");
}

export function sharedImagesDir(projectPath: string): string {
	// Sibling of the per-project `uploads/` dir (decision 036), kept in the
	// worktree tree so it shares the worktree's lifecycle, per the storage choice.
	return `${DEV3_HOME}/worktrees/${projectSlug(projectPath)}/shared-images`;
}

/** Lowercase extension without the dot, or "" if none. */
export function imageExt(path: string): string {
	return extname(path).replace(/^\./, "").toLowerCase();
}

export function isSupportedImage(path: string): boolean {
	return SUPPORTED_EXTS.has(imageExt(path));
}

function sanitizeName(name: string): string {
	const base = name.split(/[/\\]/).pop()?.trim() ?? "";
	const cleaned = base.replace(/[\0-\x1f\x7f]/g, "");
	return cleaned.slice(0, 120);
}

/** Validation failure that should surface to the CLI as a usage error. */
export class SharedImageError extends Error {}

/**
 * Copy one image into the project's worktree `shared-images/` dir and return the
 * {@link SharedImage} record. Validates the source path (absolute, no `..`,
 * exists, supported type, within the size cap). Throws {@link SharedImageError}
 * on any validation failure so the caller can report it verbatim.
 */
export function saveSharedImage(projectPath: string, sourcePath: string): SharedImage {
	if (!sourcePath.startsWith("/") || sourcePath.includes("..")) {
		throw new SharedImageError(`Path must be absolute and free of "..": ${sourcePath}`);
	}
	if (!existsSync(sourcePath)) {
		throw new SharedImageError(`File not found: ${sourcePath}`);
	}
	const stat = statSync(sourcePath);
	if (!stat.isFile()) {
		throw new SharedImageError(`Not a file: ${sourcePath}`);
	}
	const ext = imageExt(sourcePath);
	if (!SUPPORTED_EXTS.has(ext)) {
		throw new SharedImageError(`Unsupported image type "${ext || "(none)"}" (use png/jpg/gif/webp/bmp): ${sourcePath}`);
	}
	if (stat.size > MAX_SHARED_IMAGE_BYTES) {
		throw new SharedImageError(`Image too large (${Math.round(stat.size / 1024 / 1024)} MB, max 25 MB): ${sourcePath}`);
	}

	const dir = sharedImagesDir(projectPath);
	mkdirSync(dir, { recursive: true });
	const name = sanitizeName(basename(sourcePath));
	const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
	const storedPath = `${dir}/shared-${Date.now()}-${hex}.${ext}`;
	copyFileSync(sourcePath, storedPath);

	return {
		id: crypto.randomUUID(),
		storedPath,
		originalPath: sourcePath,
		name: name || `image.${ext}`,
		mime: MIME_BY_EXT[ext] ?? "application/octet-stream",
		bytes: stat.size,
		createdAt: Date.now(),
	};
}

/**
 * Merge new images onto the existing history and enforce the per-task cap by
 * dropping the oldest. Returns the kept list plus the dropped records (whose
 * files the caller should delete). Pure — no I/O.
 */
export function pruneSharedImages(
	existing: SharedImage[] | undefined,
	incoming: SharedImage[],
	cap: number,
): { kept: SharedImage[]; dropped: SharedImage[] } {
	const all = [...(existing ?? []), ...incoming];
	if (all.length <= cap) return { kept: all, dropped: [] };
	const dropped = all.slice(0, all.length - cap);
	const kept = all.slice(all.length - cap);
	return { kept, dropped };
}

/** Best-effort delete of pruned image files. Never throws. */
export function deleteSharedImageFiles(images: SharedImage[]): void {
	for (const img of images) {
		try {
			rmSync(img.storedPath, { force: true });
		} catch (err) {
			log.debug("Failed to delete pruned shared image", { path: img.storedPath, error: String(err) });
		}
	}
}
