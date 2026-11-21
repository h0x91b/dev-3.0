import type { Context } from "cordis";
import type { ComponentType } from "react";
import type { Task } from "../../shared/types";
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
 * - `undocked`: its task is on screen but there is no room for a dock (narrow viewport);
 * - `offscreen`: the route left its task, or the inline diff or immersive fullscreen covers it;
 * - `floating`: opened floating (`openTaskPanel(..., { floating: true })`): no tab, the panel draws itself as a lightbox.
 * The host shows only `docked` itself. The panel stays mounted in every state, so it keeps its state.
 */
export type TaskPanelPresentation = "docked" | "inactive" | "undocked" | "offscreen" | "floating";

export interface TaskPanelProps {
	ctx: Context;
	taskId: string;
	/** The task's record when it is in the loaded project, for panels that read it (review, live artifact, worktree). */
	task: Task | undefined;
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

const reportedTitleFailures = new Set<string>();

/** A panel's tab label; a throwing `title` falls back to its id (logged once), so the tab stays closable. */
export function panelTitle(def: TaskPanelDef, t: TFunction): string {
	try {
		return def.title(t);
	} catch (err) {
		if (!reportedTitleFailures.has(def.id)) {
			reportedTitleFailures.add(def.id);
			console.error(`[slots] title() of task panel ${def.id} threw; showing its id:`, err);
		}
		return def.id;
	}
}
