import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_TASK_MENU_PLUGIN } from "../builtins";
import { getTaskMenuRegistry } from "../registry";

/**
 * A fresh plugin root with the built-in task menu rows, for any test that opens
 * `TaskContextMenu`. Cordis applies a plugin a few microtasks after a reset, so this
 * waits for the rows; microtasks, not a timer, so files on fake timers work too.
 */
export async function installTaskMenuBuiltins(): Promise<void> {
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_TASK_MENU_PLUGIN]);
	for (let tick = 0; tick < 50 && getTaskMenuRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getTaskMenuRegistry().list().length === 0) throw new Error("built-in task menu rows never registered");
}
