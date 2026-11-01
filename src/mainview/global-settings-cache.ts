// ── GlobalSettings write cache ──
// `saveGlobalSettings` takes the WHOLE settings object, so a patch from
// outside the Settings screen (a right-click "Hide" on a task card, say)
// needs the current object to merge into. App.tsx already receives every
// settings load/push as `globalSettings`; this module just mirrors the same
// value so any component can read-and-patch without owning Settings state.

import type { GlobalSettings } from "../shared/types";
import { api } from "./rpc";
import { toast } from "./toast";
import { translate } from "./i18n";

let current: GlobalSettings | null = null;

export function syncGlobalSettingsCache(settings: GlobalSettings): void {
	current = settings;
}

export function getCachedGlobalSettings(): GlobalSettings | null {
	return current;
}

/**
 * Merge a patch into the last-known settings and persist it. Before the first
 * sync it merges into a fresh read from the host instead — never into a
 * renderer placeholder, which would overwrite the whole file.
 */
export async function patchGlobalSettings(patch: Partial<GlobalSettings>): Promise<boolean> {
	const previous = current;
	let next: GlobalSettings | null = null;
	try {
		const base = current ?? await api.request.getGlobalSettings();
		next = { ...base, ...patch };
		current = next;
		await api.request.saveGlobalSettings(next);
		return true;
	} catch {
		if (next && current === next) current = previous;
		toast.error(translate("settings.fullInterfaceError"), { source: "settings" });
		return false;
	}
}
