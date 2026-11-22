import type { Context } from "cordis";
import type { TmuxWindowEntry } from "../../shared/types";
import type { TFunction } from "../i18n";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry } from "../plugins/slot-registry";
import type { MenuSlotItem } from "../plugins/menu-rows";

// Internal for now: no manifest kind declares `terminalWindowMenu`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/22/file-and-window-menu-slots.md).
declare module "cordis" {
	interface Context {
		terminalWindowMenu: TerminalWindowMenuRegistry;
	}
}

/** One group today: dev3's rows. Anything else lands in a trailing group of its own. */
export type TerminalWindowMenuGroup = "window";

export const TERMINAL_WINDOW_MENU_GROUPS: readonly TerminalWindowMenuGroup[] = ["window"];

/** What every item sees: the tmux window the menu was opened on, and what the tab row can do with it. */
export interface TerminalWindowMenuScope {
	window: TmuxWindowEntry;
	taskId: string;
	/** False for a session's last window, which tmux never closes. */
	closable: boolean;
	t: TFunction;
	select: () => void;
	/** Turns the tab into its own name field. */
	rename: () => void;
	close: () => void;
}

/** One row of a window tab's right-click menu. It runs itself; the host closes the menu first. */
export interface TerminalWindowMenuItem extends Omit<MenuSlotItem<TerminalWindowMenuScope, TerminalWindowMenuGroup>, "disabled" | "checked"> {
	run: (scope: TerminalWindowMenuScope) => void | Promise<void>;
}

export class TerminalWindowMenuRegistry extends SlotRegistry<TerminalWindowMenuItem> {
	constructor(ctx: Context) {
		super(ctx, "terminalWindowMenu", { kind: "contribute", noun: "terminal window menu item" });
	}
}

export const getTerminalWindowMenuRegistry = defineAppSlot((root) => new TerminalWindowMenuRegistry(root));
