import type { Context } from "cordis";
import type { ComponentType } from "react";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotEntry } from "../plugins/slot-registry";
import type { BoardService } from "./board-service";

// Declaration merging is the whole plugin API (D7): plugin authors get typed
// `ctx.board` / `ctx.boardViews` on the raw Cordis Context, no dev3 facade.
declare module "cordis" {
	interface Context {
		board: BoardService;
		boardViews: BoardViewRegistry;
	}
	interface Events {
		"board/changed"(): void;
	}
}

/** One way of showing a board. Built-ins and extensions register the same shape. */
export interface BoardViewDef {
	/** `builtin:<id>` for built-ins, `<extensionId>:<viewId>` for extensions. */
	id: string;
	/** An i18n key for built-ins, a plain string for extensions. */
	label: string;
	icon?: ComponentType | string;
	component: ComponentType<{ ctx: Context }>;
	supportsNarrow: boolean;
	defaultLayout?: unknown;
	/** Content of the host's "View options" popover; no icon is shown without it. */
	Options?: ComponentType<{ ctx: Context }>;
}

/** A registered view and the context of the plugin that registered it — the one its component receives. */
export type RegisteredBoardView = SlotEntry<BoardViewDef>;

/** The board views currently registered, in registration order: built-ins first, extensions after. */
export class BoardViewRegistry extends SlotRegistry<BoardViewDef> {
	constructor(ctx: Context) {
		super(ctx, "boardViews", { kind: "replace", noun: "board view" });
	}
}

export const getBoardViewRegistry = defineAppSlot((root) => new BoardViewRegistry(root));
