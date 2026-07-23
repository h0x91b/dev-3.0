import type { ExternalApp } from "../shared/types";

/** localStorage key holding the user's selected "Open in..." app id. */
const STORAGE_KEY = "dev3-open-in-app";

/** The app id last chosen from an "Open in..." picker, or null if none yet. */
export function getSelectedOpenInAppId(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

/** Persist the chosen app so Cmd/Ctrl+O opens it directly next time. */
export function setSelectedOpenInAppId(id: string): void {
	try {
		localStorage.setItem(STORAGE_KEY, id);
	} catch {
		// localStorage may be unavailable (private mode); selection is best-effort.
	}
}

/**
 * Resolve the persisted selection against the currently installed apps. Returns
 * null when nothing is selected yet or the chosen app is no longer available —
 * both cases fall back to opening the picker.
 */
export async function resolveSelectedOpenInApp(
	getApps: () => Promise<ExternalApp[]>,
): Promise<ExternalApp | null> {
	const id = getSelectedOpenInAppId();
	if (!id) return null;
	const apps = await getApps();
	return apps.find((app) => app.id === id) ?? null;
}
