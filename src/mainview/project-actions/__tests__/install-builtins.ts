import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_PROJECT_ACTIONS_PLUGIN } from "../builtins";
import { getProjectActionRegistry } from "../registry";

/** A fresh plugin root with the built-in project actions, for any test that renders the dashboard. */
export async function installProjectActionBuiltins(): Promise<void> {
	resetPluginsForTests();
	applyBuiltinPlugins([], [BUILTIN_PROJECT_ACTIONS_PLUGIN]);
	for (let tick = 0; tick < 50 && getProjectActionRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getProjectActionRegistry().list().length === 0) throw new Error("built-in project actions never registered");
}
