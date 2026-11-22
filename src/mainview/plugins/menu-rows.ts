import type { SlotEntry, SlotItem } from "./slot-registry";

/** What every menu slot's item shares: a group, a guarded label and visibility, and how its row looks. */
export interface MenuSlotItem<Scope, Group extends string> extends SlotItem {
	region: Group;
	label: (scope: Scope) => string;
	/** Shown only when this holds. */
	when?: (scope: Scope) => boolean;
	disabled?: (scope: Scope) => boolean;
	/** A ✓ before the label, for toggles whose label does not already name the action. */
	checked?: (scope: Scope) => boolean;
	danger?: boolean;
}

/** An item resolved against one scope: what the row draws. */
export interface MenuRow<Item> {
	item: Item;
	/** Test ids and React keys; built-ins drop their `builtin:` prefix. */
	key: string;
	label: string;
	disabled: boolean;
	checked: boolean;
}

const BUILTIN_PREFIX = "builtin:";

function rowKey(id: string): string {
	return id.startsWith(BUILTIN_PREFIX) ? id.slice(BUILTIN_PREFIX.length) : id;
}

/** A throwing item drops only its own row, never the whole menu. */
export function resolveMenuRow<Scope, Item extends MenuSlotItem<Scope, string>>(slot: string, item: Item, scope: Scope): MenuRow<Item> | null {
	try {
		if (item.when && !item.when(scope)) return null;
		return {
			item,
			key: rowKey(item.id),
			label: item.label(scope),
			disabled: item.disabled?.(scope) ?? false,
			checked: item.checked?.(scope) ?? false,
		};
	} catch (err) {
		console.error(`[${slot}] "${item.id}" failed to resolve`, err);
		return null;
	}
}

/**
 * Built-in items land in their own group, in `groups` order. Anything else goes
 * into one trailing group the host owns, never interleaved with dev3's rows —
 * the slot of a future extension "Extensions" section (bible §11).
 */
export function groupMenuRows<Scope, Group extends string, Item extends MenuSlotItem<Scope, Group>>(
	slot: string,
	entries: readonly SlotEntry<Item>[],
	scope: Scope,
	groups: readonly Group[],
): MenuRow<Item>[][] {
	const builtin = new Map<Group, MenuRow<Item>[]>();
	const foreign: MenuRow<Item>[] = [];
	for (const { def } of entries) {
		const row = resolveMenuRow(slot, def, scope);
		if (!row) continue;
		if (!def.id.startsWith(BUILTIN_PREFIX)) foreign.push(row);
		else if (groups.includes(def.region)) builtin.set(def.region, [...(builtin.get(def.region) ?? []), row]);
	}
	return [...groups.map((group) => builtin.get(group) ?? []), foreign].filter((group) => group.length > 0);
}

/** A failing row reports itself; it never escapes into the click or goes unhandled. */
export function runMenuItem<Scope>(slot: string, id: string, run: ((scope: Scope) => void | Promise<void>) | undefined, scope: Scope): void {
	const fail = (err: unknown) => console.error(`[${slot}] "${id}" failed`, err);
	try {
		void Promise.resolve(run?.(scope)).catch(fail);
	} catch (err) {
		fail(err);
	}
}
