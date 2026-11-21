import { createContext, useContext, type ReactNode } from "react";
import { SlotItems } from "../plugins/SlotItems";
import type { TaskBranchStatusController } from "../components/task-info-panel/useTaskBranchStatus";
import type { TaskInlineDiffRequest } from "../components/task-inline-diff";
import { getTaskHeaderRegistry, type TaskHeaderGroup, type TaskHeaderRegion, type TaskHeaderScope } from "./registry";

/** Where a region is drawn: its bar in the header, or its section of the narrow actions sheet. */
export type TaskHeaderSurface = "bar" | "sheet";

/** The regions still drawn by one legacy cluster item; the git bar has real items. */
export type LegacyRegion = Exclude<TaskHeaderRegion, "git">;

/**
 * Today's JSX of each legacy bar, built by `<TaskHeader>` for the layout on screen. The
 * legacy cluster items render it unchanged; 3.2–3.5 replace each cluster with real items.
 */
export type LegacyClusters = Record<LegacyRegion, Partial<Record<TaskHeaderSurface, ReactNode>>>;

/** How much room the header has. Measured once by `<TaskHeader>`, read by every bar. */
export interface TaskHeaderLayout {
	/** Narrow window (`useCompact`): icon-only buttons. */
	compact: boolean;
	/** The header itself is narrow (split view): content folds first. */
	tight: boolean;
	/** The one-row header; the expanded one shows the details grid under it. */
	collapsed: boolean;
}

/**
 * Internal state the built-in items share across bars. The branch status has one owner,
 * the header, because the Context bar's diff badge reads it too. Not part of the slot's
 * public scope (decisions/2026/11/21/task-header-git-items.md).
 */
interface TaskHeaderInternals {
	layout: TaskHeaderLayout;
	git: TaskBranchStatusController;
	onOpenInlineDiff?: (request: TaskInlineDiffRequest) => void;
}

interface TaskHeaderContextValue extends TaskHeaderInternals {
	scope: TaskHeaderScope;
	legacy: LegacyClusters;
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

export function useLegacyCluster(region: LegacyRegion): ReactNode {
	const surface = useContext(SurfaceContext);
	return useTaskHeaderContext().legacy[region][surface] ?? null;
}

/**
 * One region's items. `display: contents`, so the items lay out as children of the
 * host's bar box and the bar keeps its own spacing, boxing and help id.
 */
export function TaskHeaderRegionItems({ region, surface = "bar" }: { region: TaskHeaderRegion | TaskHeaderGroup; surface?: TaskHeaderSurface }) {
	const { scope } = useTaskHeaderContext();
	return (
		<SurfaceContext.Provider value={surface}>
			<SlotItems registry={getTaskHeaderRegistry()} region={region} scope={scope} className="contents" />
		</SurfaceContext.Provider>
	);
}
