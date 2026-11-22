import type { Context } from "cordis";
import { defineAppSlot } from "../plugins/root";
import type { ReplaceSlotItem } from "../plugins/SlotHost";
import { SlotRegistry } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `terminalCompanion`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/21/terminal-companion-slot.md).
declare module "cordis" {
	interface Context {
		terminalCompanion: TerminalCompanionRegistry;
	}
}

/** What sits on a terminal's left (the file explorer today), on the task pane and on Repo alike. */
export type TerminalCompanionItem = ReplaceSlotItem;

export class TerminalCompanionRegistry extends SlotRegistry<TerminalCompanionItem> {
	constructor(ctx: Context) {
		super(ctx, "terminalCompanion", { kind: "replace", noun: "terminal companion" });
	}
}

export const getTerminalCompanionRegistry = defineAppSlot((root) => new TerminalCompanionRegistry(root));
