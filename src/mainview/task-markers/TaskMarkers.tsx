import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { Task } from "../../shared/types";
import { CordisContext } from "../plugins/react";
import { SlotErrorBoundary } from "../plugins/SlotHost";
import type { SlotEntry } from "../plugins/slot-registry";
import { getTaskMarkerRegistry, placeTaskMarkers, type TaskMarkerItem, type TaskMarkerSurface } from "./registry";

type Entries = readonly SlotEntry<TaskMarkerItem>[];

const TaskMarkerEntriesContext = createContext<Entries | null>(null);

/**
 * The slot's one subscription, at the app root. A board can hold thousands of cards, so they
 * read the entries from context instead of each subscribing to the registry.
 */
export function TaskMarkersProvider({ children }: { children: ReactNode }) {
	const registry = getTaskMarkerRegistry();
	const entries = useSyncExternalStore(registry.subscribe, registry.list);
	return <TaskMarkerEntriesContext.Provider value={entries}>{children}</TaskMarkerEntriesContext.Provider>;
}

/** Outside the provider (a surface rendered on its own, in tests) the entries are read once, not followed. */
export function useTaskMarkerEntries(): Entries {
	return useContext(TaskMarkerEntriesContext) ?? getTaskMarkerRegistry().list();
}

/** Draws already-placed markers: no wrapper element, so they sit in the host's own flex row. */
export function TaskMarkerItems({ entries, task, surface }: { entries: Entries; task: Task; surface: TaskMarkerSurface }) {
	return (
		<>
			{entries.map((entry) => {
				const Component = entry.def.component;
				return (
					<SlotErrorBoundary key={entry.def.id} slot="taskMarkers" resetKey={entry.def.id} fallback={() => null}>
						<CordisContext.Provider value={entry.ctx}>
							<Component ctx={entry.ctx} task={task} surface={surface} />
						</CordisContext.Provider>
					</SlotErrorBoundary>
				);
			})}
		</>
	);
}

export function TaskMarkers({ task, surface }: { task: Task; surface: TaskMarkerSurface }) {
	const shown = placeTaskMarkers(useTaskMarkerEntries(), { task, surface });
	return shown.length === 0 ? null : <TaskMarkerItems entries={shown} task={task} surface={surface} />;
}
