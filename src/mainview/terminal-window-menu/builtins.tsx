import type { Context, Fiber } from "cordis";
import type { BuiltinPlugin } from "../plugins/runtime";
// Defines the slot before the plugin injects it.
import "./registry";
import type { TerminalWindowMenuItem } from "./registry";

const TERMINAL_WINDOW_MENU_BUILTIN_ID = "builtin:terminal-window-menu";

const BUILTIN_ITEMS: Omit<TerminalWindowMenuItem, "order">[] = [
	{ id: "builtin:switch", region: "window", when: ({ window: w }) => !w.active, label: ({ t }) => t("windowNav.switchTo"), run: ({ select }) => select() },
	{ id: "builtin:rename", region: "window", label: ({ t }) => t("windowNav.renameItem"), run: ({ rename }) => rename() },
	{ id: "builtin:close", region: "window", danger: true, when: ({ closable }) => closable, label: ({ t }) => t("tmux.closeWindowDesc"), run: ({ close }) => close() },
];

/** Required: these rows are the window tab's own actions, and ⇧F10 reaches them from the keyboard. */
export const BUILTIN_TERMINAL_WINDOW_MENU_PLUGIN: BuiltinPlugin = {
	id: TERMINAL_WINDOW_MENU_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: TERMINAL_WINDOW_MENU_BUILTIN_ID,
			inject: ["terminalWindowMenu"],
			apply(pluginCtx: Context) {
				BUILTIN_ITEMS.forEach((item, order) => pluginCtx.terminalWindowMenu.register({ ...item, order }));
			},
		});
	},
};
