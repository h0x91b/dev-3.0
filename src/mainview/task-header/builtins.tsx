import type { Context, Fiber } from "cordis";
import type { ComponentType } from "react";
import type { BuiltinPlugin } from "../plugins/runtime";
import type { SlotItemProps } from "../plugins/SlotItems";
// Defines the `taskHeader` slot on the app root before the built-ins install.
import "./registry";
import { registerGitItems } from "./builtin-git";
import { useLegacyCluster, type LegacyRegion } from "./scope";

/** The bars still drawn as one cluster each, until their split lands. */
export const LEGACY_REGIONS: readonly LegacyRegion[] = ["status", "session", "runtime"];

export const TASK_HEADER_BUILTIN_ID = "builtin:task-header";

export function legacyClusterId(region: LegacyRegion): string {
	return `builtin:${region}.legacy-cluster`;
}

function legacyCluster(region: LegacyRegion): ComponentType<SlotItemProps> {
	function LegacyCluster() {
		return <>{useLegacyCluster(region)}</>;
	}
	LegacyCluster.displayName = `LegacyCluster(${region})`;
	return LegacyCluster;
}

/** The Git bar's own items, and one cluster item per bar not yet split. */
export function installTaskHeaderBuiltins(ctx: Context): Fiber {
	return ctx.plugin({
		name: TASK_HEADER_BUILTIN_ID,
		inject: ["taskHeader"],
		apply(pluginCtx: Context) {
			for (const region of LEGACY_REGIONS) {
				pluginCtx.taskHeader.register({ id: legacyClusterId(region), region, component: legacyCluster(region) });
			}
			registerGitItems(pluginCtx);
		},
	});
}

/** Required: the header has no other source of controls, so the user cannot switch these off. */
export const BUILTIN_TASK_HEADER_PLUGIN: BuiltinPlugin = {
	id: TASK_HEADER_BUILTIN_ID,
	required: true,
	install: installTaskHeaderBuiltins,
};
