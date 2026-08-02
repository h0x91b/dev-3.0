/**
 * The live layer of user shortcut overrides sitting on top of `keymap.ts`
 * defaults.
 *
 * Kept as a module-level store rather than React state because the dispatcher in
 * `App.tsx` reads it from inside a keydown handler and every consumer must see
 * the same answer in the same frame. Components subscribe through
 * `useKeymapVersion()` to re-render their key chips.
 *
 * Only overrides are persisted (`GlobalSettings.keyboardShortcuts`), so changing
 * a default still reaches every user who never touched that row.
 */

import { useSyncExternalStore } from "react";
import type { ShortcutOverrides } from "../shared/types";
import { parseBinding, serializeBinding, type Binding } from "./keymap-bindings";

let overrides: ShortcutOverrides = {};
let version = 0;
const listeners = new Set<() => void>();

function emit() {
	version++;
	for (const listener of listeners) listener();
}

/** Replace the whole override set (from persisted global settings). */
export function setShortcutOverrides(next: ShortcutOverrides | undefined) {
	const normalized = next ?? {};
	if (serializeOverrides(normalized) === serializeOverrides(overrides)) return;
	overrides = normalized;
	emit();
}

export function getShortcutOverrides(): ShortcutOverrides {
	return overrides;
}

function serializeOverrides(value: ShortcutOverrides): string {
	return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The bindings in force for one shortcut. An override replaces the defaults
 * wholesale — a stored empty array means the user deliberately unbound it.
 */
export function resolvedBindings(id: string, defaults: Binding[]): Binding[] {
	const stored = overrides[id];
	if (!stored) return defaults;
	return stored.map(parseBinding).filter((b): b is Binding => b !== null);
}

export function hasOverride(id: string): boolean {
	return overrides[id] !== undefined;
}

export function overrideCount(): number {
	return Object.keys(overrides).length;
}

/** Build the next override set with one shortcut rebound. */
export function withOverride(id: string, bindings: Binding[]): ShortcutOverrides {
	return { ...overrides, [id]: bindings.map(serializeBinding) };
}

/** Build the next override set with one shortcut back on its defaults. */
export function withoutOverride(id: string): ShortcutOverrides {
	const next = { ...overrides };
	delete next[id];
	return next;
}

let capturing = false;

/**
 * While the settings recorder is capturing a combo, no app shortcut may fire —
 * otherwise rebinding ⌘K would open the palette instead of recording ⌘K. Both
 * listeners sit on `window` in the capture phase and the dispatcher registered
 * first, so `stopPropagation` from the recorder is too late; this flag is the
 * only reliable gate.
 */
export function setKeymapCapture(active: boolean) {
	capturing = active;
}

export function isKeymapCapturing(): boolean {
	return capturing;
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Re-render on any rebind. The value is an opaque counter — read it, don't
 * interpret it.
 */
export function useKeymapVersion(): number {
	return useSyncExternalStore(subscribe, () => version, () => version);
}
