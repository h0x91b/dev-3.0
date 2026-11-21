import type { Context, Fiber } from "cordis";
import { useContext } from "react";
import { useT } from "../i18n";
import FileExplorerFrame from "../components/FileExplorerFrame";
import type { BuiltinPlugin } from "../plugins/runtime";
import { ReplacementCrashedContext, useTerminalCompanionProps } from "./props";
// Defines the slot before the plugin injects it.
import "./registry";

export const FILE_EXPLORER_COMPANION_ID = "builtin:file-explorer";

/** The built-in file explorer frame: the slot's only item and its undisableable fallback. */
export function FileExplorerCompanion() {
	const dismiss = useContext(ReplacementCrashedContext);
	return <FileExplorerFrame {...useTerminalCompanionProps()} notice={dismiss && <ReplacementCrashed onDismiss={dismiss} />} />;
}

/** §5.12: a crashed replacement shows the built-in under a notice, here one compact line above the tree. */
function ReplacementCrashed({ onDismiss }: { onDismiss: () => void }) {
	const t = useT();
	return (
		<div role="alert" data-testid="terminal-companion-crashed" className="flex flex-shrink-0 items-start gap-2 border-b border-edge bg-danger/10 px-3 py-1.5 text-xs text-danger [overflow-wrap:anywhere]">
			<span className="min-w-0 flex-1">{t("fileExplorer.replacementCrashed")}</span>
			<button type="button" onClick={onDismiss} className="flex-shrink-0 rounded-md underline underline-offset-2 hover:text-fg active:scale-[0.96]">
				{t("fileExplorer.dismiss")}
			</button>
		</div>
	);
}

const TERMINAL_COMPANION_BUILTIN_ID = "builtin:terminal-companion";

/** Required: the explorer is the terminal's only companion, so the user cannot switch it off. */
export const BUILTIN_TERMINAL_COMPANION_PLUGIN: BuiltinPlugin = {
	id: TERMINAL_COMPANION_BUILTIN_ID,
	required: true,
	install(ctx: Context): Fiber {
		return ctx.plugin({
			name: TERMINAL_COMPANION_BUILTIN_ID,
			inject: ["terminalCompanion"],
			apply(pluginCtx: Context) {
				pluginCtx.terminalCompanion.register({ id: FILE_EXPLORER_COMPANION_ID, component: FileExplorerCompanion });
			},
		});
	},
};
