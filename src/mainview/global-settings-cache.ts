// ── GlobalSettings write cache ──
// `saveGlobalSettings` takes the WHOLE settings object, so a patch from
// outside the Settings screen (a right-click "Hide" on a task card, say)
// needs the current object to merge into. App.tsx already receives every
// settings load/push as `globalSettings`; this module just mirrors the same
// value so any component can read-and-patch without owning Settings state.

import type { GlobalSettings } from "../shared/types";
import { api } from "./rpc";

let current: GlobalSettings | null = null;

export function syncGlobalSettingsCache(settings: GlobalSettings): void {
	current = settings;
}

export function getCachedGlobalSettings(): GlobalSettings | null {
	return current;
}

/**
 * Merge a patch into the last-known settings and persist it. A caller that
 * fires before the first sync (astonishingly early) is a no-op rather than a
 * crash — there is nothing yet to merge into.
 */
export function patchGlobalSettings(patch: Partial<GlobalSettings>): void {
	if (!current) return;
	current = { ...current, ...patch };
	api.request.saveGlobalSettings(current).catch(() => {});
}
