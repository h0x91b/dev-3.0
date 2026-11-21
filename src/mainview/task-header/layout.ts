import { useSyncExternalStore } from "react";
import type { TaskHeaderUserLayout } from "../../shared/types";
import { patchGlobalSettings } from "../global-settings-cache";
import { updateHiddenControls } from "../hidden-controls";
import type { TaskHeaderItemId } from "../hideable-controls";
import { isBuiltinItem, type SlotUserLayout } from "../plugins/SlotItems";
import { TASK_HEADER_ALWAYS_SHOWN } from "./registry";

/**
 * The user's task-header layout (bible §5.1, §5.10): one for every task, stored in
 * `GlobalSettings.taskHeaderLayout`. Mirrors the settings the way `hidden-controls` does,
 * with optimistic writes that roll back on a failed save. Hiding lives in
 * `hidden-controls`; a swap writes both in one settings patch.
 */

let current: TaskHeaderUserLayout = {};
const listeners = new Set<() => void>();

function announce(next: TaskHeaderUserLayout): void {
	if (next === current) return;
	current = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

const getLayout = () => current;

export function syncTaskHeaderLayout(layout: TaskHeaderUserLayout | undefined): void {
	if (JSON.stringify(layout ?? {}) !== JSON.stringify(current)) announce(layout ?? {});
}

export function useTaskHeaderUserLayout(): TaskHeaderUserLayout {
	return useSyncExternalStore(subscribe, getLayout);
}

export function setTaskHeaderLayoutForTests(layout: TaskHeaderUserLayout): void {
	current = layout;
}

/** One region's slice, in the shape `<SlotItems>` takes. */
export function regionLayout(layout: TaskHeaderUserLayout, region: string, hidden: ReadonlySet<string>): SlotUserLayout {
	const shown = (id: string) => !TASK_HEADER_ALWAYS_SHOWN.has(id);
	return { order: layout.order?.[region], overflow: layout.overflow?.filter(shown), pinned: layout.pinned, hidden: [...hidden].filter(shown) };
}

// --- pure edits ------------------------------------------------------------------------

function without(ids: readonly string[] | undefined, id: string): string[] | undefined {
	const next = (ids ?? []).filter((value) => value !== id);
	return next.length > 0 ? next : undefined;
}

function withId(ids: readonly string[] | undefined, id: string): string[] {
	return (ids ?? []).includes(id) ? [...(ids ?? [])] : [...(ids ?? []), id];
}

function withOrder(layout: TaskHeaderUserLayout, region: string, order: string[]): TaskHeaderUserLayout {
	return { ...layout, order: { ...layout.order, [region]: order } };
}

/**
 * `id` one step left or right among the items actually drawn. `order` is every item of
 * the region as the user sees it, so items drawn nowhere right now keep their places.
 */
export function moveItem(
	layout: TaskHeaderUserLayout,
	region: string,
	order: readonly string[],
	drawn: readonly string[],
	id: string,
	direction: -1 | 1,
): TaskHeaderUserLayout {
	const neighbour = drawn[drawn.indexOf(id) + direction];
	if (!drawn.includes(id) || neighbour === undefined) return layout;
	const rest = order.filter((value) => value !== id);
	const at = rest.indexOf(neighbour) + (direction === 1 ? 1 : 0);
	return withOrder(layout, region, [...rest.slice(0, at), id, ...rest.slice(at)]);
}

export function sendToMore(layout: TaskHeaderUserLayout, id: string): TaskHeaderUserLayout {
	return { ...layout, overflow: withId(layout.overflow, id), pinned: without(layout.pinned, id) };
}

/** Out of More into the bar. An extension item also needs a pin: it starts in More. */
export function showInBar(layout: TaskHeaderUserLayout, id: string): TaskHeaderUserLayout {
	return { ...layout, overflow: without(layout.overflow, id), pinned: isBuiltinItem(id) ? without(layout.pinned, id) : withId(layout.pinned, id) };
}

/** `replacement` takes `replaced`'s place in the bar; hiding `replaced` is the caller's half. */
export function swapItems(
	layout: TaskHeaderUserLayout,
	region: string,
	order: readonly string[],
	replaced: string,
	replacement: string,
): TaskHeaderUserLayout {
	const rest = order.filter((value) => value !== replacement);
	const at = rest.indexOf(replaced);
	const nextOrder = at < 0 ? [...rest, replacement] : [...rest.slice(0, at), replacement, ...rest.slice(at)];
	return withOrder(showInBar(layout, replacement), region, nextOrder);
}

// --- writes ----------------------------------------------------------------------------

async function persist(next: TaskHeaderUserLayout, write: () => Promise<boolean>): Promise<boolean> {
	const previous = current;
	announce(next);
	const saved = await write();
	if (!saved && current === next) announce(previous);
	return saved;
}

export function saveTaskHeaderLayout(next: TaskHeaderUserLayout): Promise<boolean> {
	return persist(next, () => patchGlobalSettings({ taskHeaderLayout: next }));
}

/** "Use instead of…": hides `replaced`, brings `replacement` back if it was hidden, and puts it in `replaced`'s place. */
export function swapTaskHeaderItems(region: string, order: readonly string[], replaced: TaskHeaderItemId, replacement: TaskHeaderItemId): Promise<boolean> {
	const next = swapItems(current, region, order, replaced, replacement);
	return persist(next, () => updateHiddenControls({ hide: [replaced], restore: [replacement] }, { taskHeaderLayout: next }));
}

export function getTaskHeaderUserLayout(): TaskHeaderUserLayout {
	return current;
}
