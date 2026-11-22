import { applyBuiltinPlugins } from "../../plugins/runtime";
import { BUILTIN_TASK_MARKERS_PLUGIN } from "../builtins";
import { getTaskMarkerRegistry } from "../registry";

/**
 * The built-in identity markers on the current root, for any test that renders a card or a
 * sidebar row. Cordis applies a plugin a few microtasks later; microtasks, so fake timers work.
 */
export async function installTaskMarkerBuiltins(): Promise<void> {
	applyBuiltinPlugins([], [BUILTIN_TASK_MARKERS_PLUGIN]);
	for (let tick = 0; tick < 50 && getTaskMarkerRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getTaskMarkerRegistry().list().length === 0) throw new Error("built-in task markers never registered");
}
