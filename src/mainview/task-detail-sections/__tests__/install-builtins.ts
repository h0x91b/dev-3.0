import { applyBuiltinPlugins } from "../../plugins/runtime";
import { BUILTIN_TASK_DETAIL_SECTIONS_PLUGIN } from "../builtins";
import { getTaskDetailSectionRegistry } from "../registry";

/** The built-in sections of a finished task's view, for a test that opens TaskDetailModal on one. */
export async function installTaskDetailSectionBuiltins(): Promise<void> {
	applyBuiltinPlugins([], [BUILTIN_TASK_DETAIL_SECTIONS_PLUGIN]);
	for (let tick = 0; tick < 50 && getTaskDetailSectionRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getTaskDetailSectionRegistry().list().length === 0) throw new Error("built-in task detail sections never registered");
}
