import type { Context } from "cordis";
import type { Dispatch } from "react";
import type { Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import type { TranslationKey } from "../i18n";
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

/** A row of items drawn inside one item of a bar: the Git bar's actions, the diff badge's segments. */
export type TaskHeaderGroup = "git.actions" | "status.diff";

/** In display order: row 1 left, row 1 right, row 2 left, row 2 right. */
export const TASK_HEADER_REGIONS: readonly TaskHeaderRegion[] = ["status", "session", "git", "runtime"];

/** Bible §5.1: visible controls per bar before overflow. Built-ins always show; extension items fill what is left. */
export const TASK_HEADER_BAR_BUDGET = 4;

/**
 * The bible's composite exceptions, owned by the host so no contributor can claim one:
 * the conditional variant switcher (one composite control) and the Runtime bar's
 * conditional Images and Artifacts readouts. The budget counts only the built-ins that
 * draw something on the current layout, so these leave room for a pinned extension item.
 */
export const TASK_HEADER_BUDGET_EXCEPTIONS: ReadonlySet<string> = new Set([
	"builtin:status.variant-switcher",
	"builtin:runtime.images",
	"builtin:runtime.artifacts",
]);

/**
 * Never hidden and never sent to More (bible §5.10 never_hideable): the user can only move
 * them within their bar. Their menu shows Move to More, Use instead of and Hide disabled.
 */
export const TASK_HEADER_ALWAYS_SHOWN: ReadonlySet<string> = new Set([
	"builtin:runtime.open-in",
	"builtin:runtime.dev-server",
	"builtin:runtime.ports",
]);

/** What every header item sees: the task on screen and how to act on it. */
export interface TaskHeaderScope {
	task: Task;
	project: Project;
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

/** Where an item may go besides its own place: a bar or a group with a More menu. */
export const TASK_HEADER_MORE_REGIONS: ReadonlySet<string> = new Set<TaskHeaderRegion | TaskHeaderGroup>(["status", "session", "git", "runtime", "git.actions"]);

/**
 * One header item. Every item names its bar; chrome (⚙, info, fullscreen, collapse) is the
 * host's, never an item, so it is never hidden or moved. `label` names it in the item menu,
 * the "Use instead of…" list and the restore list.
 */
export interface TaskHeaderItem extends ContributionSlotItem<TaskHeaderScope> {
	region: TaskHeaderRegion | TaskHeaderGroup;
	label: TranslationKey;
}

export class TaskHeaderRegistry extends SlotRegistry<TaskHeaderItem> {
	constructor(ctx: Context) {
		super(ctx, "taskHeader", { kind: "contribute", noun: "task header item" });
	}
}

export const getTaskHeaderRegistry = defineAppSlot((root) => new TaskHeaderRegistry(root));
