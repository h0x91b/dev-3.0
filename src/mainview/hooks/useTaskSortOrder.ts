import { useEffect, useState } from "react";
import { api } from "../rpc";
import type { GlobalSettings } from "../../shared/types";
import type { TaskSortOrder } from "../components/sortTasks";

/**
 * The in-band task sort order, for surfaces that don't already hold the whole
 * `GlobalSettings` object. Self-contained: reads once on mount and follows the
 * `globalSettingsUpdated` push, which the backend fans out on every settings
 * write — so the sidebar reorders the moment the setting changes, without the
 * Settings screen having to know it exists.
 */
// Mirrors the backend's own normalization: anything that isn't the opt-in value
// is the default, so a settings payload from an older build can't leave the
// comparator holding `undefined` and silently flip the whole board.
function coerce(value: unknown): TaskSortOrder {
	return value === "newest-first" ? "newest-first" : "oldest-first";
}

export function useTaskSortOrder(): TaskSortOrder {
	const [order, setOrder] = useState<TaskSortOrder>("oldest-first");
	useEffect(() => {
		let alive = true;
		api.request.getGlobalSettings()
			.then((s) => { if (alive) setOrder(coerce(s.taskSortOrder)); })
			.catch(() => {});
		function onUpdated(e: Event) {
			setOrder(coerce((e as CustomEvent<GlobalSettings>).detail.taskSortOrder));
		}
		window.addEventListener("rpc:globalSettingsUpdated", onUpdated);
		return () => {
			alive = false;
			window.removeEventListener("rpc:globalSettingsUpdated", onUpdated);
		};
	}, []);
	return order;
}
