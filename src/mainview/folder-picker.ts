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
}

export interface FolderPickerRequest {
	options: FolderPickerOptions;
	resolve: (path: string | null) => void;
}

type Listener = (req: FolderPickerRequest) => void;

let listener: Listener | null = null;
const pendingQueue: FolderPickerRequest[] = [];

export function openFolderPicker(options: FolderPickerOptions = {}): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		const request: FolderPickerRequest = { options, resolve };
		if (listener) {
			listener(request);
		} else {
			pendingQueue.push(request);
		}
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
