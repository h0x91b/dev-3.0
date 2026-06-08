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

export function openFolderPicker(options: Omit<FolderPickerOptions, "multi"> = {}): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		enqueue({ options: { ...options, multi: false }, resolve: (result) => resolve(result?.[0] ?? null) });
	});
}

export function openFolderPickerMulti(options: Omit<FolderPickerOptions, "multi"> = {}): Promise<string[] | null> {
	return new Promise<string[] | null>((resolve) => {
		enqueue({ options: { ...options, multi: true }, resolve });
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
