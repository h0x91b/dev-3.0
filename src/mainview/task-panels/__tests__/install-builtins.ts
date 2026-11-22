import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_TASK_PANELS_PLUGIN } from "../builtins";
import { resetTaskDocksForTests } from "../dock-store";
import { resetArtifactViewerForTests } from "../artifact-panel";
import { getTaskPanelsRegistry } from "../registry";

/**
 * A fresh plugin root and empty docks, with the built-in task panels registered.
 * Cordis applies a plugin a few microtasks after a reset, so this waits for them.
 */
export async function installTaskPanelBuiltins(): Promise<void> {
	resetPluginsForTests();
	resetTaskDocksForTests();
	resetArtifactViewerForTests();
	applyBuiltinPlugins([], [BUILTIN_TASK_PANELS_PLUGIN]);
	for (let tick = 0; tick < 50 && getTaskPanelsRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getTaskPanelsRegistry().list().length === 0) throw new Error("built-in task panels never registered");
}
