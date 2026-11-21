import { createContext, useContext, type ReactNode } from "react";
import { SlotItems } from "../plugins/SlotItems";
import { getTaskHeaderRegistry, type TaskHeaderRegion, type TaskHeaderScope } from "./registry";

/** Where a region is drawn: its bar in the header, or its section of the narrow actions sheet. */
export type TaskHeaderSurface = "bar" | "sheet";

/**
 * Today's JSX of each bar, built by `<TaskHeader>` for the layout on screen. The legacy
 * cluster items render it unchanged; 3.2–3.5 replace each cluster with real items.
 */
export type LegacyClusters = Record<TaskHeaderRegion, Partial<Record<TaskHeaderSurface, ReactNode>>>;

interface TaskHeaderContextValue {
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

export function useLegacyCluster(region: TaskHeaderRegion): ReactNode {
	const surface = useContext(SurfaceContext);
	return useTaskHeaderContext().legacy[region][surface] ?? null;
}

/**
 * One region's items. `display: contents`, so the items lay out as children of the
 * host's bar box and the bar keeps its own spacing, boxing and help id.
 */
export function TaskHeaderRegionItems({ region, surface = "bar" }: { region: TaskHeaderRegion; surface?: TaskHeaderSurface }) {
	const { scope } = useTaskHeaderContext();
	return (
		<SurfaceContext.Provider value={surface}>
			<SlotItems registry={getTaskHeaderRegistry()} region={region} scope={scope} className="contents" />
		</SurfaceContext.Provider>
	);
}
