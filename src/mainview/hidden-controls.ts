import type { HideableControlId } from "./hideable-controls";
import {
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
	const changed = next.simplifiedMode !== state.simplifiedMode
		|| next.hiddenControls.length !== hidden.size
		|| next.hiddenControls.some((id) => !hidden.has(id));
	state = next;
	hidden = new Set(next.hiddenControls);
	if (changed) window.dispatchEvent(new CustomEvent(HIDDEN_CONTROLS_CHANGED_EVENT, { detail: [...hidden] }));
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

async function persist(next: SimplifiedInterfaceSettings): Promise<boolean> {
	const previous = state;
	const normalized = normalizeSimplifiedInterface(next);
	announce(normalized);
	const optimistic = state;
	const saved = await patchGlobalSettings(normalized);
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
	return persist({ simplifiedMode: false, personalHiddenControls: [...hidden].filter((value) => value !== id) });
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
	hidden = new Set(state.hiddenControls);
}
