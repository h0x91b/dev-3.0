import type { Context, Fiber } from "cordis";
import type { ComponentType } from "react";
import type { BuiltinPlugin } from "../plugins/runtime";
import type { SlotItemProps } from "../plugins/SlotItems";
// Defines the `taskHeader` slot on the app root before the built-ins install.
import "./registry";
import { TASK_HEADER_REGIONS, type TaskHeaderRegion } from "./registry";
import { useLegacyCluster } from "./scope";

export const TASK_HEADER_BUILTIN_ID = "builtin:task-header";

export function legacyClusterId(region: TaskHeaderRegion): string {
	return `builtin:${region}.legacy-cluster`;
}

function legacyCluster(region: TaskHeaderRegion): ComponentType<SlotItemProps> {
	function LegacyCluster() {
		return <>{useLegacyCluster(region)}</>;
	}
	LegacyCluster.displayName = `LegacyCluster(${region})`;
	return LegacyCluster;
}

/** One item per bar, each wrapping that bar's existing controls as one unit. */
export function installTaskHeaderBuiltins(ctx: Context): Fiber {
	return ctx.plugin({
		name: TASK_HEADER_BUILTIN_ID,
		inject: ["taskHeader"],
		apply(pluginCtx: Context) {
			for (const region of TASK_HEADER_REGIONS) {
				pluginCtx.taskHeader.register({ id: legacyClusterId(region), region, component: legacyCluster(region) });
			}
		},
	});
}

/** Required: the header has no other source of controls, so the user cannot switch these off. */
export const BUILTIN_TASK_HEADER_PLUGIN: BuiltinPlugin = {
	id: TASK_HEADER_BUILTIN_ID,
	required: true,
	install: installTaskHeaderBuiltins,
};
