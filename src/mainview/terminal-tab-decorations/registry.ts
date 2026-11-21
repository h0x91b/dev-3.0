import type { Context } from "cordis";
import type { ComponentType } from "react";
import type { TmuxWindowEntry } from "../../shared/types";
import type { TFunction } from "../i18n";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotEntry, type SlotItem } from "../plugins/slot-registry";
import { isBuiltinItem } from "../plugins/SlotItems";

// Internal for now: no manifest kind declares `terminalTabDecorations`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/22/terminal-tab-decorations-slot.md).
declare module "cordis" {
	interface Context {
		terminalTabDecorations: TerminalTabDecorationRegistry;
	}
}

/** One window tab in the terminal's window row. */
export interface TerminalTabScope {
	window: TmuxWindowEntry;
	/** The window printed something since the user last looked at it. */
	unseen: boolean;
}

export interface TerminalTabDecorationProps extends TerminalTabScope {
	ctx: Context;
}

/**
 * A passive glyph after a window tab's name: never an action, never focusable, `aria-hidden`.
 * `when` runs before anything mounts. `label` is folded into the tab's accessible name and
 * tooltip detail, since the glyph itself is hidden from assistive tech.
 */
export interface TerminalTabDecorationItem extends SlotItem {
	when: (scope: TerminalTabScope) => boolean;
	label: (t: TFunction, scope: TerminalTabScope) => string;
	component: ComponentType<TerminalTabDecorationProps>;
}

/** At most one extension decoration per tab, after every built-in, inside the tab's own max width. */
export const TERMINAL_TAB_DECORATION_EXTENSION_LIMIT = 1;

type Callback = "when" | "label" | "render";
const reportedFailures = new Set<string>();

/** Once per decoration and callback: the row calls them for every tab on every poll. */
export function reportDecorationFailure(id: string, callback: Callback, err: unknown): void {
	const key = `${id}\u0000${callback}`;
	if (reportedFailures.has(key)) return;
	reportedFailures.add(key);
	console.error(`[slots] ${callback} of terminal tab decoration ${id} threw; hiding it:`, err);
}

// Keyed by the registered object, so an extension that reloads gets a fresh chance.
let crashed = new WeakSet<TerminalTabDecorationItem>();

/** A decoration whose component threw stops being placed, so its label leaves the tab's name too. */
export function markDecorationCrashed(def: TerminalTabDecorationItem, err: unknown): void {
	crashed.add(def);
	reportDecorationFailure(def.id, "render", err);
}

export function resetDecorationFailuresForTests(): void {
	reportedFailures.clear();
	crashed = new WeakSet();
}

type Entry = SlotEntry<TerminalTabDecorationItem>;

function applies(entry: Entry, scope: TerminalTabScope): boolean {
	try {
		return entry.def.when(scope);
	} catch (err) {
		reportDecorationFailure(entry.def.id, "when", err);
		return false;
	}
}

/** The decorations one tab shows, with their labels: every applicable built-in, then the first applicable extension. */
export function placeTerminalTabDecorations(entries: readonly Entry[], t: TFunction, scope: TerminalTabScope): { entry: Entry; label: string }[] {
	const shown: { entry: Entry; label: string }[] = [];
	let extensionRoom = TERMINAL_TAB_DECORATION_EXTENSION_LIMIT;
	for (const entry of entries) {
		const builtin = isBuiltinItem(entry.def.id);
		if (!builtin && extensionRoom === 0) continue;
		if (crashed.has(entry.def) || !applies(entry, scope)) continue;
		let label: string;
		try {
			label = entry.def.label(t, scope);
		} catch (err) {
			reportDecorationFailure(entry.def.id, "label", err);
			continue;
		}
		if (!builtin) extensionRoom--;
		shown.push({ entry, label });
	}
	return shown.sort((a, b) => Number(!isBuiltinItem(a.entry.def.id)) - Number(!isBuiltinItem(b.entry.def.id)));
}

export class TerminalTabDecorationRegistry extends SlotRegistry<TerminalTabDecorationItem> {
	constructor(ctx: Context) {
		super(ctx, "terminalTabDecorations", { kind: "contribute", noun: "terminal tab decoration" });
	}
}

export const getTerminalTabDecorationRegistry = defineAppSlot((root) => new TerminalTabDecorationRegistry(root));
