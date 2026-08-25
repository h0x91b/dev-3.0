/**
 * Folder picker bridge.
 *
 * The custom folder picker replaces the native `Utils.openFileDialog` call,
 * which cannot work in headless/browser mode. Callers invoke
 * `openFolderPicker()` from anywhere in the renderer and await a path (or null
 * if the user cancels).
 *
 * A single `<FolderPickerHost>` mounted at the App root subscribes via
 * `subscribeFolderPicker` and displays the modal when a request arrives.
 */

export interface FolderPickerOptions {
	initialPath?: string | null;
	title?: string;
	/**
	 * Show a "New Folder" button inside the tree. Used by the "New Project"
	 * flow so the user can materialise a fresh folder without leaving dev-3.0.
	 * Default: false (existing call sites are for picking existing folders).
	 */
	allowCreateFolder?: boolean;
	/**
	 * What the caller wants back. In `"file"` mode folders are still walkable
	 * but only a file can be selected — that is how a CLI binary gets picked.
	 */
	mode?: "folder" | "file";
	/** Start with dotfiles visible. File mode defaults to true: most CLI binaries live under ~/.local/bin, ~/.bun/bin and friends. */
	showHidden?: boolean;
	/**
	 * Lock the picker inside this folder and hand the caller paths RELATIVE to
	 * it. For fields that store a repo-relative path (clone paths, sparse
	 * checkout) an absolute path is not a worse answer — it is a broken one.
	 */
	confineTo?: string | null;
	/** Sidebar label for the confinement root. Defaults to its folder name. */
	confineLabel?: string;
	/** Enable multi-selection (Cmd/Shift+click). */
	multi: boolean;
}

export interface FolderPickerRequest {
	options: FolderPickerOptions;
	resolve: (result: string[] | null) => void;
}

type Listener = (req: FolderPickerRequest) => void;

let listener: Listener | null = null;
const pendingQueue: FolderPickerRequest[] = [];

function enqueue(request: FolderPickerRequest): void {
	if (listener) {
		listener(request);
	} else {
		pendingQueue.push(request);
	}
}

/** Normalise separators and drop a trailing slash so prefix maths is safe on Windows too. */
function normalizeSeparators(p: string): string {
	return p.replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * Rebase an absolute path onto `root`. The picker's confinement is what keeps
 * a path inside the root, so an outsider here means a bug upstream — returning
 * it unchanged is louder than silently emitting `../..`.
 */
export function relativeToRoot(root: string, full: string): string {
	const r = normalizeSeparators(root);
	const f = normalizeSeparators(full);
	if (f === r) return "";
	return f.startsWith(r + "/") ? f.slice(r.length + 1) : full;
}

function resolveResult(options: FolderPickerOptions, result: string[] | null): string[] | null {
	if (!result || !options.confineTo) return result;
	const root = options.confineTo;
	return result.map((p) => relativeToRoot(root, p)).filter((p) => p !== "");
}

export function openFolderPicker(options: Omit<FolderPickerOptions, "multi"> = {}): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		const opts: FolderPickerOptions = { ...options, multi: false };
		enqueue({ options: opts, resolve: (result) => resolve(resolveResult(opts, result)?.[0] ?? null) });
	});
}

/** Pick a single existing file (e.g. a CLI binary). Folders are walkable, not selectable. */
export function openFilePicker(options: Omit<FolderPickerOptions, "multi" | "mode" | "allowCreateFolder"> = {}): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		enqueue({
			options: { showHidden: true, ...options, mode: "file", multi: false },
			resolve: (result) => resolve(result?.[0] ?? null),
		});
	});
}

export function openFolderPickerMulti(options: Omit<FolderPickerOptions, "multi"> = {}): Promise<string[] | null> {
	return new Promise<string[] | null>((resolve) => {
		const opts: FolderPickerOptions = { ...options, multi: true };
		enqueue({ options: opts, resolve: (result) => resolve(resolveResult(opts, result)) });
	});
}

export function subscribeFolderPicker(fn: Listener): () => void {
	listener = fn;
	// Flush anything queued before the host mounted.
	while (pendingQueue.length > 0) {
		const next = pendingQueue.shift();
		if (next) fn(next);
	}
	return () => {
		if (listener === fn) listener = null;
	};
}
