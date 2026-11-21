import type { Context } from "cordis";
import type { Dispatch } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { defineAppSlot } from "../plugins/root";
import { SlotRegistry } from "../plugins/slot-registry";
import type { ContributionSlotItem } from "../plugins/SlotItems";

// Internal for now: no manifest kind declares `taskHeader`, so the extension guard
// unloads any extension that registers here (decisions/2026/11/21/task-header-slot-frame.md).
declare module "cordis" {
	interface Context {
		taskHeader: TaskHeaderRegistry;
	}
}

/** The four bars of the task header (bible §5.1): Context, Git, Session/Agent, Runtime & access. */
export type TaskHeaderRegion = "status" | "git" | "session" | "runtime";

/** In display order: row 1 left, row 1 right, row 2 left, row 2 right. */
export const TASK_HEADER_REGIONS: readonly TaskHeaderRegion[] = ["status", "session", "git", "runtime"];

/** What every header item sees: the task on screen and how to act on it. */
export interface TaskHeaderScope {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

/** One header item. Every item names its bar; chrome (⚙, info, fullscreen, collapse) is the host's, never an item. */
export interface TaskHeaderItem extends ContributionSlotItem<TaskHeaderScope> {
	region: TaskHeaderRegion;
}

export class TaskHeaderRegistry extends SlotRegistry<TaskHeaderItem> {
	constructor(ctx: Context) {
		super(ctx, "taskHeader", { kind: "contribute", noun: "task header item" });
	}
}

export const getTaskHeaderRegistry = defineAppSlot((root) => new TaskHeaderRegistry(root));
