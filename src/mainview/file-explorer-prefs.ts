import { useSyncExternalStore } from "react";

/**
 * Presentation of the file explorer panel, one preference for the whole app:
 * the board and every task share it, so the panel never jumps between modes
 * as the user moves around.
 *
 * - `pinned`: a docked column that takes width from the content beside it.
 * - `autohide`: a thin rail; the tree slides OVER the content when revealed, so
 *   a terminal behind it is never resized (a resize rewraps the whole TUI).
 * - `hidden`: nothing on screen.
 */
export type FileExplorerMode = "pinned" | "autohide" | "hidden";

export interface FileExplorerPrefs {
	mode: FileExplorerMode;
	/** The visible mode to return to when the explorer is shown again. */
	lastVisibleMode: Exclude<FileExplorerMode, "hidden">;
	width: number;
}

export const FILE_EXPLORER_MIN_WIDTH = 180;
export const FILE_EXPLORER_MAX_WIDTH = 560;
export const FILE_EXPLORER_DEFAULT_WIDTH = 260;
const STORAGE_KEY = "dev3-file-explorer";
const DEFAULTS: FileExplorerPrefs = { mode: "hidden", lastVisibleMode: "pinned", width: FILE_EXPLORER_DEFAULT_WIDTH };

export function clampExplorerWidth(width: number): number {
	return Math.min(FILE_EXPLORER_MAX_WIDTH, Math.max(FILE_EXPLORER_MIN_WIDTH, Math.round(width)));
}

function load(): FileExplorerPrefs {
	try {
		const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<FileExplorerPrefs> | null;
		if (!raw) return DEFAULTS;
		const mode = raw.mode === "pinned" || raw.mode === "autohide" || raw.mode === "hidden" ? raw.mode : DEFAULTS.mode;
		const lastVisibleMode = raw.lastVisibleMode === "autohide" ? "autohide" : "pinned";
		const width = typeof raw.width === "number" && Number.isFinite(raw.width) ? clampExplorerWidth(raw.width) : DEFAULTS.width;
		return { mode, lastVisibleMode, width };
	} catch {
		return DEFAULTS;
	}
}

let prefs: FileExplorerPrefs = load();
const listeners = new Set<() => void>();

function update(next: Partial<FileExplorerPrefs>): void {
	prefs = { ...prefs, ...next };
	if (prefs.mode !== "hidden") prefs.lastVisibleMode = prefs.mode;
	try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
	for (const listener of listeners) listener();
}

export function getFileExplorerPrefs(): FileExplorerPrefs {
	return prefs;
}

export function setFileExplorerMode(mode: FileExplorerMode): void {
	update({ mode });
}

export function setFileExplorerWidth(width: number): void {
	update({ width: clampExplorerWidth(width) });
}

/** Fired when an auto-hidden explorer should slide its tree in or out. */
export const REVEAL_FILE_EXPLORER_EVENT = "dev3:toggleFileExplorerReveal";

/**
 * The one toggle behind the inspector Files button, the shortcut, the menu and
 * the palette. Hidden → shown in the last visible mode; pinned → hidden;
 * auto-hide → the rail stays and the tree slides in or out.
 */
export function toggleFileExplorer(): void {
	if (prefs.mode === "hidden") update({ mode: prefs.lastVisibleMode });
	else if (prefs.mode === "pinned") update({ mode: "hidden" });
	else window.dispatchEvent(new CustomEvent(REVEAL_FILE_EXPLORER_EVENT));
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function useFileExplorerPrefs(): FileExplorerPrefs {
	return useSyncExternalStore(subscribe, getFileExplorerPrefs, getFileExplorerPrefs);
}

/** Test-only: re-read storage and drop listeners. */
export function _resetFileExplorerPrefs(): void {
	prefs = load();
	listeners.clear();
}
