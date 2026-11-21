import type { Context } from "cordis";
import type { ComponentType } from "react";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry } from "../plugins/slot-registry";
import type { SettingsCategoryId, SettingsEntry } from "../settings-registry";

// Internal slot: built-ins only until the extension API opens it (no manifest kind yet,
// so the runtime guard unloads any extension that registers here).
declare module "cordis" {
	interface Context {
		settingsSections: SettingsSectionsRegistry;
	}
}

/** One block of a Global Settings category page. */
export interface SettingsSectionItem {
	/** `builtin:<section>` for built-ins. */
	id: string;
	/** The category page it renders on; the categories themselves are fixed. */
	region: SettingsCategoryId;
	/** Position within the category page. */
	order: number;
	/** The search rows this section answers for; their anchors live inside `component`. */
	entries: readonly SettingsEntry[];
	component: ComponentType<{ ctx: Context }>;
}

export class SettingsSectionsRegistry extends SlotRegistry<SettingsSectionItem> {
	constructor(ctx: Context) {
		super(ctx, "settingsSections", { kind: "contribute", noun: "settings section" });
	}
}

export const getSettingsSectionsRegistry = defineAppSlot((root) => new SettingsSectionsRegistry(root));
