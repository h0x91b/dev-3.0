import type { Context } from "cordis";
import type { ComponentType } from "react";
import type { Project, Task } from "../../shared/types";
import type { TFunction } from "../i18n";
import type { Route } from "../state";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry, type SlotItem } from "../plugins/slot-registry";

// Internal for now: no manifest kind declares `taskDetailSections`, so the extension guard unloads any
// extension that registers here (decisions/2026/11/22/task-detail-sections-slot.md).
declare module "cordis" {
	interface Context {
		taskDetailSections: TaskDetailSectionRegistry;
	}
}

/** What every item sees: the archived task, read-only. Note editing stays with the built-in Notes section. */
export interface TaskDetailScope {
	task: Task;
	project: Project;
	/** Present when the opener can navigate; makes links (e.g. the parent task) live. */
	navigate?: (route: Route) => void;
}

export interface TaskDetailItemProps extends TaskDetailScope {
	ctx: Context;
}

/** A section in the left column of a finished task's view: shared outputs, description, notes, then extensions. */
export interface TaskDetailMainSection extends SlotItem {
	region: "main";
	when?: (scope: TaskDetailScope) => boolean;
	/** The heading the host draws above an extension's section; built-ins draw their own. */
	title?: (t: TFunction, scope: TaskDetailScope) => string;
	component: ComponentType<TaskDetailItemProps>;
}

/** A row of the metadata grid in the right column. */
export interface TaskDetailMetaRow extends SlotItem {
	region: "meta";
	when?: (scope: TaskDetailScope) => boolean;
	/** The row's label; the host draws it, so every extension row reads the same. */
	label?: (t: TFunction, scope: TaskDetailScope) => string;
	value?: ComponentType<TaskDetailItemProps>;
	/** Built-ins only: the row's own label and value cells, kept byte-identical to the view before the slot. */
	cells?: ComponentType<TaskDetailItemProps>;
}

export type TaskDetailSectionItem = TaskDetailMainSection | TaskDetailMetaRow;
export type TaskDetailRegion = TaskDetailSectionItem["region"];

/** Extension sections drawn in the main column; the rest wait behind one disclosure (bible §9). */
export const TASK_DETAIL_MAIN_EXTENSION_BUDGET = 2;
/** Extension rows drawn in the metadata grid; the rest are not drawn (bible §9). */
export const TASK_DETAIL_META_EXTENSION_BUDGET = 3;

export class TaskDetailSectionRegistry extends SlotRegistry<TaskDetailSectionItem> {
	constructor(ctx: Context) {
		super(ctx, "taskDetailSections", { kind: "contribute", noun: "task detail section" });
	}
}

export const getTaskDetailSectionRegistry = defineAppSlot((root) => new TaskDetailSectionRegistry(root));
