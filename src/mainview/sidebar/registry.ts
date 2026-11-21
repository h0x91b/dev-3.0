import type { Context } from "cordis";
import { defineAppSlot } from "../plugins/root";
import type { ReplaceSlotItem } from "../plugins/SlotHost";
import { SlotRegistry } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `sidebar`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/21/sidebar-slot.md).
declare module "cordis" {
	interface Context {
		sidebar: SidebarRegistry;
	}
}

/** One way of drawing the task view's left sidebar (the Active Tasks list today). Wide layouts only. */
export type SidebarItem = ReplaceSlotItem;

export class SidebarRegistry extends SlotRegistry<SidebarItem> {
	constructor(ctx: Context) {
		super(ctx, "sidebar", { kind: "replace", noun: "sidebar" });
	}
}

export const getSidebarRegistry = defineAppSlot((root) => new SidebarRegistry(root));
