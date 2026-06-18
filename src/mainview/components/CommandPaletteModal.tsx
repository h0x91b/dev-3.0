import { useMemo } from "react";
import { useT } from "../i18n";
import { availableCommands, COMMAND_CATEGORY_KEY, type CommandContext, type PaletteCommand } from "../commands";
import { PaletteShell } from "./PaletteShell";

interface CommandPaletteModalProps {
	/** Which scopes are runnable in the current route. */
	context: CommandContext;
	/** Run a command by its `handleMenuAction` action id. */
	onRun: (actionId: string) => void;
	onClose: () => void;
}

/**
 * Cmd/Ctrl+Shift+P action palette — the action counterpart to the Cmd+K
 * navigation palette. Fuzzy-filter commands by label; Enter runs the highlighted
 * one via the shared `handleMenuAction` dispatcher (see App `runCommand`). Only
 * commands runnable in the current route context are listed.
 */
function CommandPaletteModal({ context, onRun, onClose }: CommandPaletteModalProps) {
	const t = useT();
	const commands = useMemo(() => availableCommands(context), [context]);

	return (
		<PaletteShell<PaletteCommand>
			items={commands}
			getKey={(c) => c.id}
			getText={(c) => t(c.labelKey)}
			onSelect={(c) => onRun(c.id)}
			onClose={onClose}
			placeholder={t("commandPalette.placeholder")}
			ariaLabel={t("commandPalette.title")}
			hint={t("commandPalette.hint")}
			noResults={t("commandPalette.noResults")}
			testId="command-palette"
			renderItemRight={(c) => (
				<span className="text-fg-3 text-xs flex-shrink-0">{t(COMMAND_CATEGORY_KEY[c.category])}</span>
			)}
		/>
	);
}

export default CommandPaletteModal;
