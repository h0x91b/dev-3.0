import type { Context, Fiber } from "cordis";
import type { BuiltinPlugin } from "../plugins/runtime";
import type { TerminalTabDecorationItem, TerminalTabDecorationProps } from "./registry";
// Defines the slot before the plugin injects it.
import "./registry";

/** Background signal after the name: bell (warning) outranks new output (accent). The active tab shows no dot. */
function WindowMarker({ window: w }: TerminalTabDecorationProps) {
	if (w.active) return null;
	return (
		<span
			aria-hidden="true"
			data-window-marker={w.bell ? "bell" : "output"}
			className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${w.bell ? "bg-warning" : "bg-accent"}`}
		/>
	);
}

/** Applies to the active tab too: its name keeps saying "bell" even though the dot is hidden there. */
export const WINDOW_ACTIVITY_DECORATION: TerminalTabDecorationItem = {
	id: "builtin:window-activity",
	order: 10,
	when: ({ window: w, unseen }) => w.bell || unseen,
	label: (t, { window: w }) => (w.bell ? t("windowNav.bell") : t("windowNav.newOutput")),
	component: WindowMarker,
};

const TERMINAL_TAB_DECORATIONS_BUILTIN_ID = "builtin:terminal-tab-decorations";

/** Required: the bell/new-output signal is how a background window asks for attention. */
export const BUILTIN_TERMINAL_TAB_DECORATIONS_PLUGIN: BuiltinPlugin = {
	id: TERMINAL_TAB_DECORATIONS_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: TERMINAL_TAB_DECORATIONS_BUILTIN_ID,
			inject: ["terminalTabDecorations"],
			apply(pluginCtx: Context) {
				pluginCtx.terminalTabDecorations.register(WINDOW_ACTIVITY_DECORATION);
			},
		});
	},
};
