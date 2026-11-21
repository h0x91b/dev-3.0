import { createContext, useContext, type ReactNode } from "react";
import type { Task } from "../../shared/types";
import { SlotItems } from "../plugins/SlotItems";
import type { TaskBranchStatusController } from "../components/task-info-panel/useTaskBranchStatus";
import type { TaskInlineDiffRequest } from "../components/task-inline-diff";
import type { TaskSessionController } from "./useTaskSession";
import { getTaskHeaderRegistry, TASK_HEADER_BAR_BUDGET, TASK_HEADER_BUDGET_EXCEPTIONS, TASK_HEADER_REGIONS, type TaskHeaderGroup, type TaskHeaderRegion, type TaskHeaderScope } from "./registry";

/** Where a region is drawn: its bar in the header, or its section of the narrow actions sheet. */
export type TaskHeaderSurface = "bar" | "sheet";

/** How much room the header has. Measured once by `<TaskHeader>`, read by every bar. */
export interface TaskHeaderLayout {
	/** Narrow window (`useCompact`): icon-only buttons. */
	compact: boolean;
	/** The header itself is narrow (split view): content folds first. */
	tight: boolean;
	/** The one-row header; the expanded one shows the details grid under it. */
	collapsed: boolean;
	/** Phone-width viewport: one summary bar plus the actions sheet. */
	narrow: boolean;
}

/**
 * Internal state the built-in items share across bars. The branch status has one owner,
 * the header, because the Context bar's diff badge reads it too. Not part of the slot's
 * public scope (decisions/2026/11/21/task-header-git-items.md).
 */
interface TaskHeaderInternals {
	layout: TaskHeaderLayout;
	/** The task's status is one of `ACTIVE_STATUSES`: its worktree and session may be live. */
	isTaskActive: boolean;
	git: TaskBranchStatusController;
	/** The session bar's dialogs and hibernation; the restore control (chrome) runs them too. */
	session: TaskSessionController;
	onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
	/** Closes the narrow actions sheet; a sheet row that opens something else calls it first. */
	closeSheet: () => void;
	/** The task's variant group, the task included; empty outside a group. */
	variants: Task[];
	/** The fullscreen task screen, where switching variant keeps the screen. */
	isFullPage?: boolean;
}

interface TaskHeaderContextValue extends TaskHeaderInternals {
	scope: TaskHeaderScope;
}

const TaskHeaderContext = createContext<TaskHeaderContextValue | null>(null);
const SurfaceContext = createContext<TaskHeaderSurface>("bar");

/** Scoped to one mounted header, so two headers on screen never see each other's task. */
export function TaskHeaderProvider({ value, children }: { value: TaskHeaderContextValue; children: ReactNode }) {
	return <TaskHeaderContext.Provider value={value}>{children}</TaskHeaderContext.Provider>;
}

function useTaskHeaderContext(): TaskHeaderContextValue {
	const value = useContext(TaskHeaderContext);
	if (!value) throw new Error("A task header item rendered outside <TaskHeader>");
	return value;
}

export function useTaskHeaderScope(): TaskHeaderScope {
	return useTaskHeaderContext().scope;
}

export function useTaskHeaderInternals(): TaskHeaderInternals {
	return useTaskHeaderContext();
}

export function useTaskHeaderSurface(): TaskHeaderSurface {
	return useContext(SurfaceContext);
}

function isBar(region: TaskHeaderRegion | TaskHeaderGroup): region is TaskHeaderRegion {
	return (TASK_HEADER_REGIONS as readonly string[]).includes(region);
}

/**
 * One region's items. `display: contents`, so the items lay out as children of the
 * host's bar box and the bar keeps its own spacing, boxing and help id. A bar has the
 * §5.1 budget; a group lives inside one item, spends that item's place and is a `span`,
 * as it sits inside that item's inline row.
 */
export function TaskHeaderRegionItems({ region, surface = "bar" }: { region: TaskHeaderRegion | TaskHeaderGroup; surface?: TaskHeaderSurface }) {
	const { scope } = useTaskHeaderContext();
	const placement = isBar(region) ? { budget: TASK_HEADER_BAR_BUDGET, budgetExempt: TASK_HEADER_BUDGET_EXCEPTIONS } : { as: "span" as const };
	return (
		<SurfaceContext.Provider value={surface}>
			<SlotItems registry={getTaskHeaderRegistry()} region={region} scope={scope} className="contents" {...placement} />
		</SurfaceContext.Provider>
	);
}
