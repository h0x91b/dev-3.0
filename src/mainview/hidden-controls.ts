// ── Hidden-controls registry ──
// One set of hidden control ids, mirrored from GlobalSettings.hiddenControls
// so it reaches registries outside React (the keymap, the palette, the
// native menu, the tip pool) the same way agent-traffic's own flag does.
//
// Absent id = visible. A control never added to the set (a brand-new
// feature, or one the user never touched) always renders — Simplify View
// only ever writes ids INTO this set, never assumes one that isn't there.
//
// Simplify View is not a separate boolean: it is the named preset in
// hideable-controls.ts, applied/unapplied by writing/removing exactly those
// ids. Two flags that could disagree — the trap the first version of this
// feature built — cannot exist here, because there is only one set.

import type { HideableControlId } from "./hideable-controls";
import { SIMPLIFY_VIEW_PRESET_IDS } from "./hideable-controls";
import { patchGlobalSettings } from "./global-settings-cache";

export const HIDDEN_CONTROLS_CHANGED_EVENT = "hidden-controls-changed" as const;

let hidden: ReadonlySet<string> = new Set();

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

function announce(next: ReadonlySet<string>) {
	if (setsEqual(next, hidden)) return;
	hidden = next;
	window.dispatchEvent(new CustomEvent(HIDDEN_CONTROLS_CHANGED_EVENT, { detail: Array.from(next) }));
}

export function getHiddenControls(): ReadonlySet<string> {
	return hidden;
}

export function isControlHidden(id: HideableControlId): boolean {
	return hidden.has(id);
}

/** Whether every Simplify View preset id is currently hidden — the toggle's checked state. */
export function isSimplifyViewApplied(): boolean {
	return SIMPLIFY_VIEW_PRESET_IDS.every((id) => hidden.has(id));
}

/** Called wherever globalSettings lands in the renderer (initial load + push). */
export function syncHiddenControlsFromGlobalSettings(settings: { hiddenControls?: string[] }): void {
	announce(new Set(settings.hiddenControls ?? []));
}

function persist(next: ReadonlySet<string>) {
	announce(next);
	patchGlobalSettings({ hiddenControls: Array.from(next) });
}

/** Right-click "Hide" on any registered control. */
export function hideControl(id: HideableControlId): void {
	if (hidden.has(id)) return;
	persist(new Set(hidden).add(id));
}

/** The panel/header restore row for one control. */
export function restoreControl(id: HideableControlId): void {
	if (!hidden.has(id)) return;
	const next = new Set(hidden);
	next.delete(id);
	persist(next);
}

/** Settings toggle ON: union the preset into whatever is already hidden. */
export function applySimplifyViewPreset(): void {
	const next = new Set(hidden);
	for (const id of SIMPLIFY_VIEW_PRESET_IDS) next.add(id);
	persist(next);
}

/** Settings toggle OFF: remove exactly the preset's ids, leaving any other manual hides. */
export function unapplySimplifyViewPreset(): void {
	const next = new Set(hidden);
	for (const id of SIMPLIFY_VIEW_PRESET_IDS) next.delete(id);
	persist(next);
}

/** The escape hatch: clears every hidden id, preset or manual alike. */
export function showAllControls(): void {
	persist(new Set());
}

/** Test-only override — production code changes the set through the actions above. */
export function setHiddenControlsForTests(ids: readonly string[]): void {
	hidden = new Set(ids);
}
