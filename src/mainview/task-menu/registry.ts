import type { Context } from "cordis";
import type { Dispatch, ReactNode } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction } from "../state";
import type { TFunction } from "../i18n";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotItem } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `taskMenu`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/21/task-menu-slot.md).
declare module "cordis" {
	interface Context {
		taskMenu: TaskMenuRegistry;
	}
}

/** The menu's sections, separated by a rule, in display order. */
export type TaskMenuGroup = "open" | "edit" | "workspace" | "session" | "danger";

export const TASK_MENU_GROUPS: readonly TaskMenuGroup[] = ["open", "edit", "workspace", "session", "danger"];

/** What every item sees: the task the menu was opened on, and what its surface can do with it. */
export interface TaskMenuScope {
	task: Task;
	/** The task's OWN project: labels, columns and the move source resolve against it. */
	project: Project;
	dispatch: Dispatch<AppAction>;
	t: TFunction;
	/** Opens the task's workspace, the row or card's own navigation. */
	openTask: () => void;
	/** The surface's detail modal, or the menu's own; `rename` starts it in rename mode. */
	openDetails: (rename: boolean) => void;
	/** Filters the board to the task's lineage batch; only the card offers it. */
	showFamily?: () => void;
}

/** How a submenu hands back control: `done` ends a pick (closes everything), `close` only dismisses. */
export interface TaskMenuPick {
	done: () => void;
	close: () => void;
}

/** Where the menu stood when a touch row handed off: a 0×0 element at the cursor point, once mounted. */
export interface TaskMenuAnchor extends TaskMenuPick {
	anchorEl: HTMLElement | null;
	anchorPos: { x: number; y: number };
}

/** A row that opens a picker: a flyout beside it on desktop, its own touch surface on a phone. */
export interface TaskMenuSubmenu {
	/** Flyout width; content without a fixed width sizes itself. */
	width?: number;
	flyout: (scope: TaskMenuScope, pick: TaskMenuPick) => ReactNode;
	/** Drawn after the phone sheet closes. */
	sheet: (scope: TaskMenuScope, anchor: TaskMenuAnchor) => ReactNode;
}

/** One row of the task context menu. `region` is its group; it runs itself, nothing routes it by id. */
export interface TaskMenuItem extends SlotItem {
	region: TaskMenuGroup;
	label: (scope: TaskMenuScope) => string;
	/** Shown only when this holds. */
	when?: (scope: TaskMenuScope) => boolean;
	disabled?: (scope: TaskMenuScope) => boolean;
	/** A ✓ before the label, for toggles whose label does not already name the action. */
	checked?: (scope: TaskMenuScope) => boolean;
	danger?: boolean;
	/** Exactly one of `run` and `submenu`. The host closes the menu before `run`. */
	run?: (scope: TaskMenuScope) => void | Promise<void>;
	submenu?: TaskMenuSubmenu;
}

export class TaskMenuRegistry extends SlotRegistry<TaskMenuItem> {
	constructor(ctx: Context) {
		super(ctx, "taskMenu", { kind: "contribute", noun: "task menu item" });
	}
}

export const getTaskMenuRegistry = defineAppSlot((root) => new TaskMenuRegistry(root));
