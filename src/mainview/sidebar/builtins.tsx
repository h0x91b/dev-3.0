import type { Context, Fiber } from "cordis";
import ActiveTasksSidebar from "../components/ActiveTasksSidebar";
import type { BuiltinPlugin } from "../plugins/runtime";
import { useSidebarProps } from "./props";
// Defines the slot before the plugin injects it.
import "./registry";

export const ACTIVE_TASKS_SIDEBAR_ID = "builtin:active-tasks";

/** The built-in Active Tasks list: the slot's only item and its undisableable fallback. */
export function ActiveTasksSidebarBody() {
	return <ActiveTasksSidebar {...useSidebarProps()} />;
}

const SIDEBAR_BUILTIN_ID = "builtin:sidebar";

/** Required: the task view has no other sidebar, so the user cannot switch it off. */
export const BUILTIN_SIDEBAR_PLUGIN: BuiltinPlugin = {
	id: SIDEBAR_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: SIDEBAR_BUILTIN_ID,
			inject: ["sidebar"],
			apply(pluginCtx: Context) {
				pluginCtx.sidebar.register({ id: ACTIVE_TASKS_SIDEBAR_ID, component: ActiveTasksSidebarBody });
			},
		});
	},
};
