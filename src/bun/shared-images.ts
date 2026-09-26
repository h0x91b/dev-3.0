import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { SharedImage } from "../shared/types";
import { MAX_SHARED_IMAGE_BYTES, MAX_SHARED_VIDEO_BYTES, SHARED_IMAGE_EXTS, SHARED_VIDEO_EXTS } from "../shared/types";
import { DEV3_HOME } from "./paths";
import { projectStorageKey } from "../shared/project-storage-key";
import { isFullyQualifiedPath } from "../shared/absolute-path";

const SUPPORTED_EXTS = new Set(SHARED_IMAGE_EXTS);
const SUPPORTED_VIDEO_EXTS = new Set(SHARED_VIDEO_EXTS);

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	mp4: "video/mp4",
	webm: "video/webm",
};

function projectSlug(projectPath: string): string {
	return projectStorageKey(projectPath);
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
 * on any validation failure so the caller can report it verbatim. An optional
 * per-image `caption` is the agent's note about what to look at in this shot.
 */
export function saveSharedImage(projectPath: string, sourcePath: string, caption?: string): SharedImage {
	const { ext, size } = checkSource(sourcePath);
	if (!SUPPORTED_EXTS.has(ext)) {
		throw new SharedImageError(`Unsupported image type "${ext || "(none)"}" (use png/jpg/gif/webp/bmp): ${sourcePath}`);
	}
	if (size > MAX_SHARED_IMAGE_BYTES) {
		throw new SharedImageError(`Image too large (${Math.round(size / 1024 / 1024)} MB, max 25 MB): ${sourcePath}`);
	}
	return copyIntoShared(projectPath, sourcePath, ext, size, caption);
}

/**
 * The video twin of {@link saveSharedImage} for `dev3 show-video`: same store,
 * same record, told apart by its `video/*` mime. Also sniffs the container
 * signature, so a renamed file fails here instead of as a blank player.
 */
export function saveSharedVideo(projectPath: string, sourcePath: string, caption?: string): SharedImage {
	const { ext, size } = checkSource(sourcePath);
	if (!SUPPORTED_VIDEO_EXTS.has(ext)) {
		throw new SharedImageError(`Unsupported video type "${ext || "(none)"}" (use ${SHARED_VIDEO_EXTS.join("/")}): ${sourcePath}`);
	}
	if (size > MAX_SHARED_VIDEO_BYTES) {
		throw new SharedImageError(
			`Video too large (${Math.round(size / 1024 / 1024)} MB, max ${MAX_SHARED_VIDEO_BYTES / 1024 / 1024} MB): ${sourcePath}. Trim or re-encode it smaller.`,
		);
	}
	if (!hasVideoSignature(sourcePath, ext)) {
		throw new SharedImageError(`Not a real ${ext.toUpperCase()} file (container signature missing): ${sourcePath}`);
	}
	return copyIntoShared(projectPath, sourcePath, ext, size, caption);
}

/** MP4 carries an `ftyp` box at byte 4; WebM opens with the EBML magic 1A 45 DF A3. */
export function hasVideoSignature(path: string, ext: string): boolean {
	const head = Buffer.alloc(12);
	const fd = openSync(path, "r");
	let read = 0;
	try {
		read = readSync(fd, head, 0, head.length, 0);
	} finally {
		closeSync(fd);
	}
	if (ext === "mp4") return read >= 8 && head.toString("latin1", 4, 8) === "ftyp";
	if (ext === "webm") return read >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
	return false;
}

function checkSource(sourcePath: string): { ext: string; size: number } {
	if (!isFullyQualifiedPath(sourcePath, process.platform)) {
		throw new SharedImageError(`Path must be absolute and free of "..": ${sourcePath}`);
	}
	if (!existsSync(sourcePath)) {
		throw new SharedImageError(`File not found: ${sourcePath}`);
	}
	const stat = statSync(sourcePath);
	if (!stat.isFile()) {
		throw new SharedImageError(`Not a file: ${sourcePath}`);
	}
	return { ext: imageExt(sourcePath), size: stat.size };
}

function copyIntoShared(projectPath: string, sourcePath: string, ext: string, size: number, caption?: string): SharedImage {
	const dir = sharedImagesDir(projectPath);
	mkdirSync(dir, { recursive: true });
	const name = sanitizeName(basename(sourcePath));
	const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
	const storedPath = `${dir}/shared-${Date.now()}-${hex}.${ext}`;
	copyFileSync(sourcePath, storedPath);

	const trimmedCaption = caption?.trim();
	return {
		id: crypto.randomUUID(),
		isUnread: true,
		storedPath,
		originalPath: sourcePath,
		name: name || `${SUPPORTED_VIDEO_EXTS.has(ext) ? "video" : "image"}.${ext}`,
		mime: MIME_BY_EXT[ext] ?? "application/octet-stream",
		bytes: size,
		createdAt: Date.now(),
		...(trimmedCaption ? { caption: trimmedCaption } : {}),
	};
}
