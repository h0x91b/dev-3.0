import type { HideableControlId } from "./hideable-controls";
import type { GlobalSettings } from "../shared/types";
import {
	isLegacyHiddenControlAlias,
	normalizeSimplifiedInterface,
	setSimplifiedInterfaceMode,
	type SimplifiedInterfaceSettings,
} from "../shared/simplified-interface";
import { patchGlobalSettings } from "./global-settings-cache";

export const HIDDEN_CONTROLS_CHANGED_EVENT = "hidden-controls-changed" as const;

let state = normalizeSimplifiedInterface({ simplifiedMode: false });
let hidden: ReadonlySet<string> = new Set();

function announce(settings: SimplifiedInterfaceSettings) {
	const next = normalizeSimplifiedInterface(settings);
	const nextHidden = currentIds(next.hiddenControls);
	const changed = next.simplifiedMode !== state.simplifiedMode
		|| nextHidden.size !== hidden.size
		|| [...nextHidden].some((id) => !hidden.has(id));
	state = next;
	hidden = currentIds(next.hiddenControls);
	if (changed) window.dispatchEvent(new CustomEvent(HIDDEN_CONTROLS_CHANGED_EVENT, { detail: [...hidden] }));
}

/** The stored set minus the legacy names kept on disk for older installed versions. */
function currentIds(ids: readonly string[]): ReadonlySet<string> {
	return new Set(ids.filter((id) => !isLegacyHiddenControlAlias(id)));
}

export function getHiddenControls(): ReadonlySet<string> {
	return hidden;
}

export function isControlHidden(id: HideableControlId): boolean {
	return hidden.has(id);
}

export function isSimplifyViewApplied(): boolean {
	return state.simplifiedMode;
}

export function syncHiddenControlsFromGlobalSettings(settings: SimplifiedInterfaceSettings): void {
	announce(settings);
}

async function persist(next: SimplifiedInterfaceSettings, extra: Partial<GlobalSettings> = {}): Promise<boolean> {
	const previous = state;
	const normalized = normalizeSimplifiedInterface(next);
	announce(normalized);
	const optimistic = state;
	const saved = await patchGlobalSettings({ ...extra, ...normalized });
	if (!saved && state === optimistic) announce(previous);
	return saved;
}

export function hideControl(id: HideableControlId): Promise<boolean> {
	if (state.personalHiddenControls.includes(id)) return Promise.resolve(true);
	return persist({ ...state, personalHiddenControls: [...state.personalHiddenControls, id] });
}

/** Restoring a preset control customizes the full interface, retaining the other hidden controls. */
export function restoreControl(id: HideableControlId): Promise<boolean> {
	if (!hidden.has(id)) return Promise.resolve(true);
	return updateHiddenControls({ restore: [id] });
}

/**
 * Hides and restores in one write. `extra` rides in the same settings patch, so a
 * task-header swap (hide one item, show another in its place) is one step on disk.
 */
export function updateHiddenControls(
	{ hide = [], restore = [] }: { hide?: readonly HideableControlId[]; restore?: readonly HideableControlId[] },
	extra: Partial<GlobalSettings> = {},
): Promise<boolean> {
	const restoring = restore.filter((id) => hidden.has(id));
	if (restoring.length === 0) {
		return persist({ ...state, personalHiddenControls: [...new Set([...state.personalHiddenControls, ...hide])] }, extra);
	}
	const kept = [...hidden, ...hide].filter((id) => !restoring.includes(id as HideableControlId));
	return persist({ simplifiedMode: false, personalHiddenControls: [...new Set(kept)] }, extra);
}

export function applySimplifyViewPreset(): Promise<boolean> {
	return persist(setSimplifiedInterfaceMode(state, true));
}

export function unapplySimplifyViewPreset(): Promise<boolean> {
	return persist(setSimplifiedInterfaceMode(state, false));
}

export function showAllControls(): Promise<boolean> {
	return persist({ simplifiedMode: false, personalHiddenControls: [] });
}

export function setHiddenControlsForTests(ids: readonly string[]): void {
	state = normalizeSimplifiedInterface({ hiddenControls: [...ids] });
	hidden = currentIds(state.hiddenControls);
}
