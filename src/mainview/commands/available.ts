import { useSyncExternalStore } from "react";
import { boardViewAction } from "../board-views/view-commands";
import { openBoardView } from "../app-actions";
import { getCommandsRegistry, type CommandCategory, type CommandContext, type CommandItem } from "./registry";
import type { TranslationKey } from "../i18n";

export const COMMAND_CATEGORY_KEY: Record<CommandCategory, TranslationKey> = {
	app: "command.category.app",
	create: "command.category.create",
	import: "command.category.import",
	nav: "command.category.nav",
	git: "command.category.git",
	devserver: "command.category.devserver",
	task: "command.category.task",
	terminal: "command.category.terminal",
};

/** The board-view commands follow this one. */
export const BOARD_COMMAND_ID = "builtin:view-board";

export function useRegisteredCommands(): readonly CommandItem[] {
	const registry = getCommandsRegistry();
	const entries = useSyncExternalStore(registry.subscribe, registry.list);
	return entries.map((entry) => entry.def);
}

function boardViewCommands(ctx: CommandContext): CommandItem[] {
	return (ctx.boardViews ?? []).map((view, order) => ({
		id: boardViewAction(view.id),
		order,
		labelKey: "command.boardView",
		labelVars: { name: view.name },
		category: "nav",
		scope: "project",
		run: (actionCtx) => openBoardView(actionCtx, view.id),
	}));
}

function hiddenByProjectKind(command: CommandItem, ctx: CommandContext): boolean {
	// An Operations board has no repository, so nothing could have run "in" it —
	// an import scan would always answer nothing.
	if (ctx.isVirtual && (command.category === "git" || command.category === "devserver" || command.category === "import")) return true;
	return Boolean(ctx.gitless && (command.category === "git" || command.category === "import"));
}

/** A throwing rule drops only its own command, never the whole palette. */
function isWhenMet(command: CommandItem, ctx: CommandContext): boolean {
	try {
		return command.when!(ctx);
	} catch (err) {
		console.error(`[commands] "${command.id}" visibility rule failed`, err);
		return false;
	}
}

/** Commands runnable in the current route context, in palette order. */
export function availableCommands(commands: readonly CommandItem[], ctx: CommandContext): CommandItem[] {
	const views = boardViewCommands(ctx);
	return commands
		.flatMap((command) => (command.id === BOARD_COMMAND_ID ? [command, ...views] : [command]))
		.filter((command) => {
			if (hiddenByProjectKind(command, ctx)) return false;
			if (command.when && !isWhenMet(command, ctx)) return false;
			if (command.scope === "task") return ctx.hasTask;
			if (command.scope === "project") return ctx.hasProject;
			return true;
		});
}
