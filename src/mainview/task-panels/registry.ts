import type { Context } from "cordis";
import type { ComponentType } from "react";
import type { TFunction } from "../i18n";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotItem } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `taskPanels`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/21/task-panels-slot.md).
declare module "cordis" {
	interface Context {
		taskPanels: TaskPanelsRegistry;
	}
}

/**
 * Where an open panel stands right now:
 * - `docked`: the active tab of its task's dock, on screen;
 * - `inactive`: in an on-screen dock behind another tab;
 * - `undocked`: its task is on screen but there is no dock (narrow viewport, immersive);
 * - `offscreen`: the route left its task, or the inline diff covers it.
 * Only `docked` is visible. The panel stays mounted in every state, so it keeps its state.
 */
export type TaskPanelPresentation = "docked" | "inactive" | "undocked" | "offscreen";

export interface TaskPanelProps {
	ctx: Context;
	taskId: string;
	presentation: TaskPanelPresentation;
	/** Closes this panel's tab for this task. */
	close: () => void;
}

/** One kind of panel the task dock can show, a tab per task it is open for. */
export interface TaskPanelDef extends SlotItem {
	title: (t: TFunction) => string;
	component: ComponentType<TaskPanelProps>;
	/** False: the tab has no ✕ and the panel closes itself (the artifact viewer's own Close). */
	closable?: boolean;
}

export class TaskPanelsRegistry extends SlotRegistry<TaskPanelDef> {
	constructor(ctx: Context) {
		super(ctx, "taskPanels", { kind: "contribute", noun: "task panel" });
	}
}

export const getTaskPanelsRegistry = defineAppSlot((root) => new TaskPanelsRegistry(root));
