import type { Context, Fiber } from "cordis";
import ForeignCodeMark from "../components/ForeignCodeMark";
import NativeBackendMark, { isNativeBackendTask } from "../components/NativeBackendMark";
import type { BuiltinPlugin } from "../plugins/runtime";
// Defines the slot before the plugin injects it.
import "./registry";
import type { TaskMarkerItem, TaskMarkerProps } from "./registry";

export const TASK_MARKERS_BUILTIN_ID = "builtin:task-markers";

function NativeBackendMarker({ task, surface }: TaskMarkerProps) {
	return surface === "card"
		? <NativeBackendMark task={task} className="w-3.5 h-3.5 flex-shrink-0" testId="task-card-native-backend" />
		: <NativeBackendMark task={task} className="w-3 h-3" testId={`sidebar-native-backend-${task.id}`} />;
}

function ForeignCodeMarker({ task }: TaskMarkerProps) {
	return <ForeignCodeMark task={task} className="w-3.5 h-3.5 flex-shrink-0" testId="task-card-foreign-code" />;
}

/** The §5.6 identity markers, in display order. Foreign code stays card-only, as before the slot. */
export const BUILTIN_TASK_MARKERS: readonly TaskMarkerItem[] = [
	{
		id: "builtin:marker.native-backend",
		when: ({ task }) => isNativeBackendTask(task),
		label: (t) => t("task.nativeBackendMark"),
		component: NativeBackendMarker,
	},
	{
		id: "builtin:marker.foreign-code",
		surfaces: ["card"],
		when: ({ task }) => !!task.foreignCode,
		label: (t) => t("task.foreignCodeMark"),
		component: ForeignCodeMarker,
	},
];

export function installTaskMarkerBuiltins(ctx: Context): Fiber {
	return ctx.plugin({
		name: TASK_MARKERS_BUILTIN_ID,
		inject: ["taskMarkers"],
		apply(pluginCtx: Context) {
			for (const def of BUILTIN_TASK_MARKERS) pluginCtx.taskMarkers.register(def);
		},
	});
}

/** Required: these markers have no other source, so the user cannot switch them off. */
export const BUILTIN_TASK_MARKERS_PLUGIN: BuiltinPlugin = {
	id: TASK_MARKERS_BUILTIN_ID,
	required: true,
	install: installTaskMarkerBuiltins,
};
