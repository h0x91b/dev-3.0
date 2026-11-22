import type { Context } from "cordis";
import type { ComponentType } from "react";
import type { ExplorerEntry } from "../../shared/types";
import type { TFunction } from "../i18n";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry } from "../plugins/slot-registry";
import type { MenuSlotItem } from "../plugins/menu-rows";

// Internal for now: no manifest kind declares `fileMenu`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/22/file-and-window-menu-slots.md).
declare module "cordis" {
	interface Context {
		fileMenu: FileMenuRegistry;
	}
}

/** The menu's sections, separated by a rule, in display order. */
export type FileMenuGroup = "open" | "path" | "host";

export const FILE_MENU_GROUPS: readonly FileMenuGroup[] = ["open", "path", "host"];

/** What every item sees: the explorer row the menu was opened on, and what the explorer can do with it. */
export interface FileMenuScope {
	entry: ExplorerEntry;
	/** The row sits in the worktree or checkout the terminal runs in, not in an extra folder. */
	inPrimaryRoot: boolean;
	projectId: string;
	/** Null on the Repo screen: the explorer lists the project checkout. */
	taskId: string | null;
	t: TFunction;
	/** Opens the file in the preview, handing focus off like a click on the row. */
	openFile: () => void;
	/** Tells an auto-hidden explorer that the user is done with it. */
	handOff: () => void;
	/** Copies with the explorer's own success/failure toast. */
	copyText: (text: string) => void;
	/** Opens on the host machine; only meaningful in the desktop shell. */
	openWithSystem: (path: string, mode: "system" | "reveal") => void;
}

/** One row of the explorer's right-click menu. It runs itself; the host closes the menu first. */
export interface FileMenuItem extends Omit<MenuSlotItem<FileMenuScope, FileMenuGroup>, "disabled" | "checked" | "danger"> {
	/** A 14px outline glyph before the label. */
	icon?: ComponentType;
	run: (scope: FileMenuScope) => void | Promise<void>;
}

export class FileMenuRegistry extends SlotRegistry<FileMenuItem> {
	constructor(ctx: Context) {
		super(ctx, "fileMenu", { kind: "contribute", noun: "file menu item" });
	}
}

export const getFileMenuRegistry = defineAppSlot((root) => new FileMenuRegistry(root));
