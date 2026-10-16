// ---- Folder picker ----

export interface FolderEntry {
	name: string;
	path: string;
	isDir: boolean;
}

/** Children listed per directory before `ExplorerListing.truncated` is set. */
export const EXPLORER_MAX_ENTRIES = 2000;

/** One child of a directory in the file explorer (`listExplorerDirectory`). */
export interface ExplorerEntry {
	name: string;
	/** Absolute path, so the renderer never joins paths with a platform separator. */
	path: string;
	/** Root-relative, `/`-separated, used as the tree key and for "copy relative path". */
	relPath: string;
	kind: "file" | "directory";
	/** Matched by the repo's ignore rules; the tree shows it dimmed. */
	ignored: boolean;
}

/**
 * One directory level of the file explorer. The root is the task worktree when a
 * task is given, otherwise the project's own checkout. `error` set ⇒ `entries` empty.
 */
export interface ExplorerListing {
	root: string;
	relPath: string;
	entries: ExplorerEntry[];
	/** More children than the cap; the listing holds the first ones after sorting. */
	truncated?: boolean;
	error?: "no-root" | "outside-root" | "not-found" | "unreadable";
}

export interface FolderListing {
	path: string;
	parent: string | null;
	home: string;
	entries: FolderEntry[];
	/**
	 * Filesystem roots to offer as shortcuts. Windows-only: `parent` is null at
	 * `C:\`, so without these a repo on another drive is unreachable. POSIX has
	 * the single `/` root and omits the field.
	 */
	roots?: string[];
	/** Present when the requested path could not be read. `entries` is empty then. */
	error?: string;
}
