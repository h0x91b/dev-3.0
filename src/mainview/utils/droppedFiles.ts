import { api } from "../rpc";
import { FileTooLargeError, MAX_UPLOAD_FILE_SIZE, uploadDroppedFile } from "./uploadDroppedFile";
import { isRemote, isWindows } from "./platform";

export type ShellDialect = "posix" | "powershell";

/** The shell a task pane runs on this host: PowerShell on Windows, a POSIX shell elsewhere. */
export function paneShellDialect(): ShellDialect {
	return isWindows() ? "powershell" : "posix";
}

/**
 * Quotes a path so it survives as one argument. POSIX uses single quotes, where
 * nothing expands (not even interactive `!` history), and spells `'` as `'\''`.
 * PowerShell uses double quotes with backtick escapes, including the typographic
 * quotes it treats as `"`.
 */
export function quotePath(path: string, dialect: ShellDialect): string {
	if (dialect === "posix") return `'${path.replace(/'/g, "'\\''")}'`;
	return `"${path.replace(/[`"$\u201c\u201d\u201e]/g, "`$&")}"`;
}

/** A path typed into a pty must not carry keys that edit the line (see drag-file-paths.ts). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export type DropEntry =
	| { kind: "uploaded"; path: string }
	/** Too large to upload; this is the file's own path on the app host. */
	| { kind: "host"; path: string; name: string }
	| { kind: "tooLarge"; name: string; remote: boolean }
	| { kind: "failed"; name: string; error: string };

/**
 * Uploads each dropped file, in drop order. A file over the upload limit is not
 * uploaded: on the desktop the host is asked for its original path (proven by
 * name, size and mtime against the drag pasteboard). A browser viewer's files are
 * on its own device, so remote mode never asks.
 */
export async function placeDroppedFiles(projectId: string, files: File[]): Promise<DropEntry[]> {
	const oversized = files.filter((f) => f.size > MAX_UPLOAD_FILE_SIZE);
	const remote = isRemote();
	let hostPaths: (string | null)[] = oversized.map(() => null);
	if (oversized.length > 0 && !remote) {
		try {
			hostPaths = await api.request.resolveDroppedFilePaths({
				files: oversized.map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified || 0 })),
			});
		} catch (err) {
			console.error("[droppedFiles] resolving oversized drop paths failed:", err);
		}
	}

	return Promise.all(files.map(async (file): Promise<DropEntry | null> => {
		const oversizedIndex = oversized.indexOf(file);
		if (oversizedIndex >= 0) {
			const path = hostPaths[oversizedIndex];
			return path && !CONTROL_CHARS.test(path) ? { kind: "host", path, name: file.name } : { kind: "tooLarge", name: file.name, remote };
		}
		try {
			const path = await uploadDroppedFile(projectId, file);
			return path ? { kind: "uploaded", path } : null;
		} catch (err) {
			if (err instanceof FileTooLargeError) return { kind: "tooLarge", name: file.name, remote };
			return { kind: "failed", name: file.name, error: String(err instanceof Error ? err.message : err) };
		}
	})).then((entries) => entries.filter((e): e is DropEntry => e !== null));
}

/**
 * The text a terminal drop types: uploaded copies keep today's backslash-escaped
 * spaces, an oversized file's original path goes in quoted, all space-separated.
 */
export function dropEntriesToTerminalText(entries: DropEntry[], dialect: ShellDialect): string {
	return entries
		.map((entry) => {
			if (entry.kind === "uploaded") return entry.path.replace(/ /g, "\\ ");
			return entry.kind === "host" ? quotePath(entry.path, dialect) : null;
		})
		.filter((text): text is string => text !== null)
		.join(" ");
}

type Translate = (key: "fileDrop.tooLargePathInserted" | "fileDrop.tooLargeRemote" | "fileDrop.tooLargeNoPath" | "fileDrop.uploadFailed", vars: Record<string, string>) => string;

/** The error toast for an entry that was not uploaded, or null for a successful upload. */
export function dropEntryError(entry: DropEntry, t: Translate): string | null {
	switch (entry.kind) {
		case "uploaded": return null;
		case "host": return t("fileDrop.tooLargePathInserted", { name: entry.name });
		case "tooLarge": return t(entry.remote ? "fileDrop.tooLargeRemote" : "fileDrop.tooLargeNoPath", { name: entry.name });
		case "failed": return t("fileDrop.uploadFailed", { error: entry.error });
	}
}
