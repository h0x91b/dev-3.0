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

/** The fixed tabs of Project Settings; each tab body is a region of this slot. */
export type ProjectSettingsTab = "global" | "project" | "worktree" | "automations";

/** A Global Settings category, or a Project Settings tab (`projectSettings.<tab>`). */
export type SettingsSectionRegion = SettingsCategoryId | `projectSettings.${ProjectSettingsTab}`;

/** One block of a settings page: a Global Settings category or a Project Settings tab. */
export interface SettingsSectionItem {
	/** `builtin:<section>` for built-ins. */
	id: string;
	/** The page it renders on; categories and tabs themselves are fixed. */
	region: SettingsSectionRegion;
	/** Position within that page. */
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
