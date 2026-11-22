import type { Context } from "cordis";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotItem } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `openInTargets`, so the extension guard unloads any
// extension that registers here (decisions/2026/11/22/open-in-targets-slot.md).
declare module "cordis" {
	interface Context {
		openInTargets: OpenInTargetRegistry;
	}
}

export type OpenInCategory = "files" | "editor" | "terminal";

/**
 * How one app a path can open in looks: data only. There is no open callback on purpose: the host
 * opens a row by `appId` through the bun-side `openInApp`, which refuses any id the defaults or the
 * user's settings do not define. A target shows only while bun has detected its app.
 */
export interface OpenInTarget extends SlotItem {
	/** An `ExternalApp` id: one of `DEFAULT_EXTERNAL_APPS`, or an app the user added in Settings. */
	appId: string;
	/** Nerd Font glyph. */
	icon?: string;
	/** The app's brand colour for the launcher tile: an external identity, not theme chrome. */
	brandColor?: string;
	category?: OpenInCategory;
}

export class OpenInTargetRegistry extends SlotRegistry<OpenInTarget> {
	constructor(ctx: Context) {
		super(ctx, "openInTargets", { kind: "contribute", noun: "open-in target" });
	}
}

export const getOpenInTargetRegistry = defineAppSlot((root) => new OpenInTargetRegistry(root));
