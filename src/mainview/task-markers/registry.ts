import type { Context } from "cordis";
import type { ComponentType } from "react";
import type { Task } from "../../shared/types";
import type { TFunction } from "../i18n";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotEntry, type SlotItem } from "../plugins/slot-registry";
import { isBuiltinItem } from "../plugins/SlotItems";

// Internal for now: no manifest kind declares `taskMarkers`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/22/task-marker-slot.md).
declare module "cordis" {
	interface Context {
		taskMarkers: TaskMarkerRegistry;
	}
}

/** The task-identity surfaces a marker may sit on (bible §5.6): the board card and the Active Tasks row. */
export type TaskMarkerSurface = "card" | "sidebar";

export interface TaskMarkerScope {
	task: Task;
	surface: TaskMarkerSurface;
}

export interface TaskMarkerProps extends TaskMarkerScope {
	ctx: Context;
}

/**
 * A passive glyph that states a property of the task (bible §5.6): never an action, never
 * focusable. `when` is required and runs before anything mounts, so a card the marker does not
 * apply to pays nothing. `label` is its accessible name, which the sidebar row folds into its own.
 */
export interface TaskMarkerItem extends SlotItem {
	/** Where it may show; both surfaces when omitted. */
	surfaces?: readonly TaskMarkerSurface[];
	when: (scope: TaskMarkerScope) => boolean;
	label: (t: TFunction, scope: TaskMarkerScope) => string;
	component: ComponentType<TaskMarkerProps>;
}

/** Bible §9: at most one extension marker per card or row, after every built-in. */
export const TASK_MARKER_EXTENSION_LIMIT = 1;

const reportedFailures = new Set<string>();

/** Once per marker and callback: a board calls them for every card on every render. */
function reportOnce(id: string, callback: "when" | "label", err: unknown): void {
	const key = `${id}\u0000${callback}`;
	if (reportedFailures.has(key)) return;
	reportedFailures.add(key);
	console.error(`[slots] ${callback}() of task marker ${id} threw; hiding it:`, err);
}

function applies(entry: SlotEntry<TaskMarkerItem>, scope: TaskMarkerScope): boolean {
	const { surfaces, when } = entry.def;
	if (surfaces && !surfaces.includes(scope.surface)) return false;
	try {
		return when(scope);
	} catch (err) {
		reportOnce(entry.def.id, "when", err);
		return false;
	}
}

/** The markers one card or row shows: every applicable built-in, then the first applicable extension. */
export function placeTaskMarkers(entries: readonly SlotEntry<TaskMarkerItem>[], scope: TaskMarkerScope): SlotEntry<TaskMarkerItem>[] {
	const shown: SlotEntry<TaskMarkerItem>[] = [];
	let extensionRoom = TASK_MARKER_EXTENSION_LIMIT;
	for (const entry of entries) {
		const builtin = isBuiltinItem(entry.def.id);
		if (!builtin && extensionRoom === 0) continue;
		if (!applies(entry, scope)) continue;
		if (!builtin) extensionRoom--;
		shown.push(entry);
	}
	return shown.sort((a, b) => Number(!isBuiltinItem(a.def.id)) - Number(!isBuiltinItem(b.def.id)));
}

export class TaskMarkerRegistry extends SlotRegistry<TaskMarkerItem> {
	constructor(ctx: Context) {
		super(ctx, "taskMarkers", { kind: "contribute", noun: "task marker" });
	}
}

export const getTaskMarkerRegistry = defineAppSlot((root) => new TaskMarkerRegistry(root));

/**
 * Shown markers with their accessible names, for a host that folds them into its own name (the
 * sidebar row). A marker whose `label` throws is dropped, so it cannot take the row down with it.
 */
export function labelTaskMarkers(
	entries: readonly SlotEntry<TaskMarkerItem>[],
	t: TFunction,
	scope: TaskMarkerScope,
): { entry: SlotEntry<TaskMarkerItem>; label: string }[] {
	const labelled: { entry: SlotEntry<TaskMarkerItem>; label: string }[] = [];
	for (const entry of entries) {
		try {
			labelled.push({ entry, label: entry.def.label(t, scope) });
		} catch (err) {
			reportOnce(entry.def.id, "label", err);
		}
	}
	return labelled;
}
