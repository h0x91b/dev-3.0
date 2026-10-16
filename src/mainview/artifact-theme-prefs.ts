import { useSyncExternalStore } from "react";

/**
 * How the artifact viewer themes the report, one preference for every artifact
 * and every viewer instance. Nothing stored means the user never chose, and
 * that reads as `light`; only an explicit pick is ever written, so a saved
 * choice survives every open and restart untouched.
 */
export type ArtifactThemeMode = "follow" | "light" | "dark";

const STORAGE_KEY = "dev3-artifact-theme";
const DEFAULT_MODE: ArtifactThemeMode = "light";

function load(): ArtifactThemeMode {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw === "follow" || raw === "light" || raw === "dark" ? raw : DEFAULT_MODE;
	} catch {
		return DEFAULT_MODE;
	}
}

let mode: ArtifactThemeMode = load();
const listeners = new Set<() => void>();

export function getArtifactThemeMode(): ArtifactThemeMode {
	return mode;
}

export function setArtifactThemeMode(next: ArtifactThemeMode): void {
	mode = next;
	try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function useArtifactThemeMode(): ArtifactThemeMode {
	return useSyncExternalStore(subscribe, getArtifactThemeMode, getArtifactThemeMode);
}

/** Test-only: re-read storage and drop listeners. */
export function _resetArtifactThemePrefs(): void {
	mode = load();
	listeners.clear();
}
