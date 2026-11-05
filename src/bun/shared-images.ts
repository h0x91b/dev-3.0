import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { copyFile, rename, stat, unlink } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { SharedImage } from "../shared/types";
import { MAX_SHARED_IMAGE_BYTES, MAX_SHARED_MEDIA_BYTES, SHARED_AUDIO_EXTS, SHARED_IMAGE_EXTS, SHARED_MEDIA_EXTS, mediaTooLargeDetail } from "../shared/types";
import { DEV3_HOME } from "./paths";
import { projectStorageKey } from "../shared/project-storage-key";
import { isFullyQualifiedPath } from "../shared/absolute-path";

const SUPPORTED_EXTS = new Set(SHARED_IMAGE_EXTS);
const SUPPORTED_CLIP_EXTS = new Set(SHARED_MEDIA_EXTS);
const AUDIO_EXTS = new Set(SHARED_AUDIO_EXTS);

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	mp4: "video/mp4",
	webm: "video/webm",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	ogg: "audio/ogg",
};

/** The `Content-Type` a stored shared file is served and recorded with. */
export function sharedMediaMime(ext: string): string {
	return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

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
		throw new SharedImageError(`Image too large (${mediaTooLargeDetail(size, MAX_SHARED_IMAGE_BYTES)}): ${sourcePath}`);
	}
	const storedPath = newStoredPath(projectPath, ext);
	copyFileSync(sourcePath, storedPath);
	return sharedRecord(sourcePath, storedPath, ext, size, caption);
}

/**
 * The clip twin of {@link saveSharedImage} for `dev3 show-media`: same store,
 * same record, told apart by its `video/*` or `audio/*` mime. Also sniffs the
 * container signature, so a renamed file fails here instead of as a blank player.
 */
export function checkSharedClip(sourcePath: string): { ext: string; size: number } {
	const { ext, size } = checkSource(sourcePath);
	if (!SUPPORTED_CLIP_EXTS.has(ext)) {
		throw new SharedImageError(`Unsupported media type "${ext || "(none)"}" (use ${SHARED_MEDIA_EXTS.join("/")}): ${sourcePath}`);
	}
	if (size > MAX_SHARED_MEDIA_BYTES) {
		throw new SharedImageError(`Media file too large (${mediaTooLargeDetail(size, MAX_SHARED_MEDIA_BYTES)}): ${sourcePath}. Trim or re-encode it smaller.`);
	}
	if (!hasClipSignature(sourcePath, ext)) {
		throw new SharedImageError(`Not a real ${ext.toUpperCase()} file (container signature missing): ${sourcePath}`);
	}
	return { ext, size };
}

/**
 * Async because a clip can be hundreds of MB: a sync copy would stall the main
 * process. Copies to a `.partial` sibling and renames only once the byte count
 * matches, so a failed or short copy never lands under a real name.
 */
export async function saveSharedClip(projectPath: string, sourcePath: string, caption?: string): Promise<SharedImage> {
	const { ext, size } = checkSharedClip(sourcePath);
	const storedPath = newStoredPath(projectPath, ext);
	const partialPath = `${storedPath}.partial`;
	try {
		await copyFile(sourcePath, partialPath);
		const copied = (await stat(partialPath)).size;
		if (copied !== size) throw new Error(`copied ${copied} of ${size} bytes`);
		await rename(partialPath, storedPath);
	} catch (err) {
		await unlink(partialPath).catch(() => {});
		throw err;
	}
	return sharedRecord(sourcePath, storedPath, ext, size, caption);
}

/** Validates every clip before copying any, and removes the earlier copies if a later one fails. */
export async function saveSharedClips(projectPath: string, items: { path: string; caption?: string }[]): Promise<SharedImage[]> {
	for (const it of items) checkSharedClip(it.path);
	const saved: SharedImage[] = [];
	try {
		for (const it of items) saved.push(await saveSharedClip(projectPath, it.path, it.caption));
	} catch (err) {
		await Promise.all(saved.map((rec) => unlink(rec.storedPath).catch(() => {})));
		throw err;
	}
	return saved;
}

/**
 * The container's magic bytes: MP4/M4A carry an `ftyp` box at byte 4, WebM opens
 * with EBML 1A 45 DF A3, WAV with `RIFF`…`WAVE`, OGG with `OggS`, and MP3 with an
 * ID3 tag or a bare MPEG frame sync. Proves the container only, never the codec.
 */
export function hasClipSignature(path: string, ext: string): boolean {
	const head = Buffer.alloc(12);
	const fd = openSync(path, "r");
	let read = 0;
	try {
		read = readSync(fd, head, 0, head.length, 0);
	} finally {
		closeSync(fd);
	}
	const ascii = (from: number, to: number) => (read >= to ? head.toString("latin1", from, to) : "");
	switch (ext) {
		case "mp4":
		case "m4a":
			return ascii(4, 8) === "ftyp";
		case "webm":
			return read >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
		case "wav":
			return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
		case "ogg":
			return ascii(0, 4) === "OggS";
		case "mp3":
			return ascii(0, 3) === "ID3" || (read >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
		default:
			return false;
	}
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

function newStoredPath(projectPath: string, ext: string): string {
	const dir = sharedImagesDir(projectPath);
	mkdirSync(dir, { recursive: true });
	const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
	return `${dir}/shared-${Date.now()}-${hex}.${ext}`;
}

function sharedRecord(sourcePath: string, storedPath: string, ext: string, size: number, caption?: string): SharedImage {
	const name = sanitizeName(basename(sourcePath));
	const trimmedCaption = caption?.trim();
	return {
		id: crypto.randomUUID(),
		isUnread: true,
		storedPath,
		originalPath: sourcePath,
		name: name || `${AUDIO_EXTS.has(ext) ? "audio" : SUPPORTED_CLIP_EXTS.has(ext) ? "video" : "image"}.${ext}`,
		mime: sharedMediaMime(ext),
		bytes: size,
		createdAt: Date.now(),
		...(trimmedCaption ? { caption: trimmedCaption } : {}),
	};
}
