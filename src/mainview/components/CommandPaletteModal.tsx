import { useT } from "../i18n";
import { availableCommands, COMMAND_CATEGORY_KEY, useRegisteredCommands } from "../commands/available";
import type { CommandContext, CommandItem } from "../commands/registry";
import { PaletteShell } from "./PaletteShell";
import { useRegisteredBoardViews } from "../board-views/react";
import { useViewLabel } from "../board-views/BoardViewChrome";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

interface CommandPaletteModalProps {
	/** Which scopes are runnable in the current route. */
	context: CommandContext;
	/** Runs the picked command; the caller supplies the route it acts on. */
	onRun: (command: CommandItem) => void;
	onClose: () => void;
}

/**
 * Cmd/Ctrl+Shift+P action palette — the action counterpart to the Cmd+Shift+K
 * navigation palette. Lists the commands registered into the `commands` slot that
 * are runnable in the current route context, fuzzy-filtered by label; Enter runs
 * the highlighted one (see App `runCommand`).
 */
function CommandPaletteModal({ context, onRun, onClose }: CommandPaletteModalProps) {
	const t = useT();
	const registeredViews = useRegisteredBoardViews();
	const labelOf = useViewLabel();
	const narrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	// One command per offered view, only when there is a choice to make (same rule as the switcher).
	const offered = registeredViews.filter((view) => !narrow || view.def.supportsNarrow);
	const boardViews = offered.length > 1 ? offered.map((view) => ({ id: view.def.id, name: labelOf(view) })) : [];
	const registered = useRegisteredCommands();
	const commands = availableCommands(registered, { ...context, boardViews });

	return (
		<PaletteShell<CommandItem>
			items={commands}
			getKey={(c) => c.id}
			getText={(c) => t(c.labelKey, c.labelVars)}
			onSelect={onRun}
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
