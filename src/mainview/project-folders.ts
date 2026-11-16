import { useCallback, useSyncExternalStore } from "react";
import type { ProjectFolder } from "../shared/types";
import { api } from "./rpc";

/**
 * Renderer side of a project's extra folders: the list itself, which ones the
 * file explorer hides, which dashboard rows are expanded, and a one-shot
 * request to reveal a folder in the explorer.
 */

const HIDDEN_KEY = "dev3-explorer-hidden-folders";
const OPEN_KEY = "dev3-dashboard-folders-open";

function readJson<T>(key: string, fallback: T): T {
	try {
		return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? fallback;
	} catch {
		return fallback;
	}
}

function writeJson(key: string, value: unknown): void {
	try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

function createStore<T>(initial: T, persist: (value: T) => void) {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		set(next: T) {
			value = next;
			persist(value);
			for (const listener of listeners) listener();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

const hiddenStore = createStore<Record<string, string[]>>(readJson(HIDDEN_KEY, {}), (v) => writeJson(HIDDEN_KEY, v));
const openStore = createStore<string[]>(readJson(OPEN_KEY, []), (v) => writeJson(OPEN_KEY, v));
const revealStore = createStore<{ projectId: string; path: string } | null>(null, () => {});

const EMPTY: string[] = [];

export function useHiddenFolders(projectId: string): string[] {
	return useSyncExternalStore(hiddenStore.subscribe, () => hiddenStore.get()[projectId] ?? EMPTY);
}

export function setFolderHidden(projectId: string, path: string, hidden: boolean): void {
	const current = hiddenStore.get()[projectId] ?? [];
	const next = hidden ? [...new Set([...current, path])] : current.filter((p) => p !== path);
	hiddenStore.set({ ...hiddenStore.get(), [projectId]: next });
}

export function showAllFolders(projectId: string): void {
	const { [projectId]: _dropped, ...rest } = hiddenStore.get();
	hiddenStore.set(rest);
}

export function useDashboardFoldersOpen(projectId: string): [boolean, () => void] {
	const open = useSyncExternalStore(openStore.subscribe, () => openStore.get().includes(projectId));
	const toggle = useCallback(() => {
		const ids = openStore.get();
		openStore.set(ids.includes(projectId) ? ids.filter((id) => id !== projectId) : [...ids, projectId]);
	}, [projectId]);
	return [open, toggle];
}

/** Ask the next file explorer of `projectId` to show and open `path`. */
export function requestRevealFolder(projectId: string, path: string): void {
	setFolderHidden(projectId, path, false);
	revealStore.set({ projectId, path });
}

export function useRevealRequest(projectId: string): string | null {
	const request = useSyncExternalStore(revealStore.subscribe, revealStore.get);
	return request?.projectId === projectId ? request.path : null;
}

export function clearRevealRequest(): void {
	revealStore.set(null);
}

interface FolderEntry {
	folders: ProjectFolder[];
	listeners: Set<() => void>;
	load: () => void;
}

/** One fetch per project and branch mode, shared by every component showing it. */
const folderCache = new Map<string, FolderEntry>();
const NO_FOLDERS: ProjectFolder[] = [];

function folderEntry(projectId: string, withBranch: boolean): FolderEntry {
	const key = `${projectId}:${withBranch ? 1 : 0}`;
	let entry = folderCache.get(key);
	if (entry) return entry;
	const created: FolderEntry = {
		folders: NO_FOLDERS,
		listeners: new Set(),
		load: () => {
			Promise.resolve()
				.then(() => api.request.getProjectFolders({ projectId, withBranch }))
				.catch(() => NO_FOLDERS)
				.then((next) => {
					if (JSON.stringify(next) === JSON.stringify(created.folders)) return;
					created.folders = next.length > 0 ? next : NO_FOLDERS;
					for (const listener of created.listeners) listener();
				});
		},
	};
	folderCache.set(key, created);
	entry = created;
	return entry;
}

export function reloadProjectFolders(projectId?: string): void {
	for (const [key, entry] of folderCache) {
		if ((!projectId || key.startsWith(`${projectId}:`)) && entry.listeners.size > 0) entry.load();
	}
}

if (typeof window !== "undefined") {
	window.addEventListener("rpc:projectUpdated", (event) => {
		const id = (event as CustomEvent<{ project?: { id?: string } }>).detail?.project?.id;
		reloadProjectFolders(id);
	});
	window.addEventListener("focus", () => reloadProjectFolders());
}

/** The project's extra folders, re-read when its settings change or the window regains focus. */
export function useProjectFolders(projectId: string | null, opts: { withBranch?: boolean; enabled?: boolean } = {}): ProjectFolder[] {
	const { withBranch = false, enabled = true } = opts;
	const entry = projectId && enabled ? folderEntry(projectId, withBranch) : null;
	const subscribe = useCallback((listener: () => void) => {
		if (!entry) return () => {};
		entry.listeners.add(listener);
		if (entry.listeners.size === 1) entry.load();
		return () => { entry.listeners.delete(listener); };
	}, [entry]);
	return useSyncExternalStore(subscribe, () => entry?.folders ?? NO_FOLDERS);
}
