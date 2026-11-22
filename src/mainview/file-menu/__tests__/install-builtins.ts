import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_FILE_MENU_PLUGIN } from "../builtins";
import { getFileMenuRegistry } from "../registry";

/** A fresh plugin root with the built-in explorer row menu, for any test that right-clicks a row. */
export async function installFileMenuBuiltins(): Promise<void> {
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_FILE_MENU_PLUGIN]);
	for (let tick = 0; tick < 50 && getFileMenuRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getFileMenuRegistry().list().length === 0) throw new Error("built-in file menu rows never registered");
}
