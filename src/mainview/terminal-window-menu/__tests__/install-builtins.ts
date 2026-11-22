import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_TERMINAL_WINDOW_MENU_PLUGIN } from "../builtins";
import { getTerminalWindowMenuRegistry } from "../registry";

/** A fresh plugin root with the built-in window tab menu, for any test that right-clicks a tab. */
export async function installTerminalWindowMenuBuiltins(): Promise<void> {
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_TERMINAL_WINDOW_MENU_PLUGIN]);
	for (let tick = 0; tick < 50 && getTerminalWindowMenuRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getTerminalWindowMenuRegistry().list().length === 0) throw new Error("built-in window menu rows never registered");
}
