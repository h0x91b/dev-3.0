import type { Context, Fiber } from "cordis";
import type { BuiltinPlugin } from "../plugins/runtime";
// Defines the `taskHeader` slot on the app root before the built-ins install.
import "./registry";
import { registerGitItems } from "./builtin-git";
import { RUNTIME_ITEMS } from "./builtin-runtime";
import { SESSION_ITEMS } from "./builtin-session";
import { STATUS_DIFF_ITEMS, STATUS_ITEMS } from "./builtin-status";

export const TASK_HEADER_BUILTIN_ID = "builtin:task-header";

/** Every bar's built-in items, in display order. */
export function installTaskHeaderBuiltins(ctx: Context): Fiber {
	return ctx.plugin({
		name: TASK_HEADER_BUILTIN_ID,
		inject: ["taskHeader"],
		apply(pluginCtx: Context) {
			for (const def of STATUS_ITEMS) pluginCtx.taskHeader.register(def);
			for (const def of STATUS_DIFF_ITEMS) pluginCtx.taskHeader.register(def);
			for (const def of SESSION_ITEMS) pluginCtx.taskHeader.register(def);
			registerGitItems(pluginCtx);
			for (const def of RUNTIME_ITEMS) pluginCtx.taskHeader.register(def);
		},
	});
}

/** Required: the header has no other source of controls, so the user cannot switch these off. */
export const BUILTIN_TASK_HEADER_PLUGIN: BuiltinPlugin = {
	id: TASK_HEADER_BUILTIN_ID,
	required: true,
	install: installTaskHeaderBuiltins,
};
