import type { Context, Fiber } from "cordis";
import type { BuiltinPlugin } from "../plugins/runtime";
// Defines the slot before the plugin injects it.
import "./registry";
import type { OpenInTarget } from "./registry";

export const OPEN_IN_TARGETS_BUILTIN_ID = "builtin:open-in-targets";

const editor = (appId: string, icon: string, brandColor: string): OpenInTarget => ({ id: `builtin:open-in.${appId}`, appId, icon, brandColor, category: "editor" });
const terminal = (appId: string, brandColor: string): OpenInTarget => ({ id: `builtin:open-in.${appId}`, appId, icon: "\u{F489}", brandColor, category: "terminal" }); // nf-oct-terminal

const INTELLIJ = "\u{F0184}"; // nf-md-diamond_stone

/** One target per `DEFAULT_EXTERNAL_APPS` entry. The row order is bun's detection order, not this list's. */
export const BUILTIN_OPEN_IN_TARGETS: readonly OpenInTarget[] = [
	{ id: "builtin:open-in.finder", appId: "finder", icon: "\u{F024}", brandColor: "#4a90d9", category: "files" }, // nf-oct-file_directory
	editor("vscode", "\u{F0A1E}", "#2b9df4"), // nf-md-microsoft_visual_studio_code
	editor("cursor", "\u{F0A1E}", "#8b5cf6"), // reuses the VS Code glyph
	terminal("ghostty", "#38bdf8"),
	terminal("iterm", "#10b981"),
	terminal("terminal", "#64748b"),
	editor("intellij", INTELLIJ, "#ec4899"),
	editor("intellij-ultimate", INTELLIJ, "#ec4899"),
	editor("intellij-ce", INTELLIJ, "#ec4899"),
	editor("pycharm", INTELLIJ, "#22c55e"),
	editor("zed", "\u{F0599}", "#f59e0b"), // nf-md-lightning_bolt
	editor("sublime", "\u{F0CC5}", "#f97316"), // nf-md-text_box
];

export function installOpenInTargetBuiltins(ctx: Context): Fiber {
	return ctx.plugin({
		name: OPEN_IN_TARGETS_BUILTIN_ID,
		inject: ["openInTargets"],
		apply(pluginCtx: Context) {
			for (const def of BUILTIN_OPEN_IN_TARGETS) pluginCtx.openInTargets.register(def);
		},
	});
}

/** Required: the default apps have no other row source. */
export const BUILTIN_OPEN_IN_TARGETS_PLUGIN: BuiltinPlugin = {
	id: OPEN_IN_TARGETS_BUILTIN_ID,
	required: true,
	install: installOpenInTargetBuiltins,
};
