// Host paths for files dropped into the webview, read back from the macOS drag
// pasteboard (src/native/macos/dev3-drag-paths.m). Used only for drops too large
// to upload: the renderer pastes the original path instead of a copy.
// See decisions/2026/11/28/oversized-drop-path-from-drag-pasteboard.md.

import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { PATHS } from "./electrobun-platform";
import { createLogger } from "./logger";

const log = createLogger("drag-file-paths");

/** What the renderer knows about a dropped `File`. */
export interface DroppedFileDescriptor {
	name: string;
	size: number;
	/** `File.lastModified` in ms; 0 when the webview did not report one. */
	lastModified: number;
}

export interface FileFacts {
	isFile: boolean;
	size: number;
	mtimeMs: number;
}

/** mtime is compared at second granularity: webviews round `lastModified` differently. */
const MTIME_TOLERANCE_MS = 1000;

/**
 * Pairs each dropped file with the one pasteboard path that has the same name,
 * byte size and mtime. Zero or several candidates give null: a guessed path is
 * worse than none, because the agent would act on the wrong file.
 */
export function matchDroppedFiles(
	files: DroppedFileDescriptor[],
	candidates: string[],
	stat: (path: string) => FileFacts | null,
): (string | null)[] {
	const facts = new Map<string, FileFacts | null>();
	const factsFor = (path: string) => {
		if (!facts.has(path)) facts.set(path, stat(path));
		return facts.get(path) ?? null;
	};
	return files.map((file) => {
		const name = file.name.normalize("NFC");
		const matches = candidates.filter((path) => {
			if (basename(path).normalize("NFC") !== name) return false;
			const f = factsFor(path);
			if (!f || !f.isFile || f.size !== file.size) return false;
			return file.lastModified <= 0 || Math.abs(f.mtimeMs - file.lastModified) < MTIME_TOLERANCE_MS;
		});
		return matches.length === 1 ? matches[0] : null;
	});
}

/** Splits the shim's NUL-separated UTF-8 buffer into paths. */
export function decodePathList(bytes: Uint8Array): string[] {
	return new TextDecoder().decode(bytes).split("\0").filter(Boolean);
}

type ReadDragPaths = () => string[];

function statFacts(path: string): FileFacts | null {
	try {
		const s = statSync(path);
		return { isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
	} catch {
		return null;
	}
}

function loadReader(): ReadDragPaths | null {
	if (process.platform !== "darwin" || process.env.DEV3_HEADLESS === "1") return null;
	const dylib = join(PATHS.VIEWS_FOLDER, "..", "native", "dev3-drag-paths.dylib");
	if (!existsSync(dylib)) {
		log.info("drag-paths shim dylib not found — oversized drops keep the plain error", { dylib });
		return null;
	}
	try {
		const lib = dlopen(dylib, {
			dev3_drag_file_paths: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		});
		return () => {
			let buffer = new Uint8Array(64 * 1024);
			let written = lib.symbols.dev3_drag_file_paths(ptr(buffer), buffer.length);
			if (written < 0) {
				buffer = new Uint8Array(-written);
				written = lib.symbols.dev3_drag_file_paths(ptr(buffer), buffer.length);
			}
			return written > 0 ? decodePathList(buffer.subarray(0, written)) : [];
		};
	} catch (err) {
		log.warn("drag-paths shim failed to load", { error: String(err) });
		return null;
	}
}

let reader: ReadDragPaths | null | undefined;

/** Host paths for dropped files, in order; null where none could be proven. Always null off macOS. */
export function resolveDroppedFilePaths(files: DroppedFileDescriptor[]): (string | null)[] {
	if (reader === undefined) reader = loadReader();
	if (!reader || files.length === 0) return files.map(() => null);
	try {
		return matchDroppedFiles(files, reader(), statFacts);
	} catch (err) {
		log.warn("reading the drag pasteboard failed", { error: String(err) });
		return files.map(() => null);
	}
}
