import { applyBuiltinPlugins } from "../../plugins/runtime";
import { BUILTIN_TIPS_PLUGIN } from "../builtins";
import { getTipRegistry } from "../registry";

/** The built-in tips on the current root, for a test that renders a tip carrier. Microtasks, so fake timers work. */
export async function installTipBuiltins(): Promise<void> {
	applyBuiltinPlugins([], [BUILTIN_TIPS_PLUGIN]);
	for (let tick = 0; tick < 50 && getTipRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getTipRegistry().list().length === 0) throw new Error("built-in tips never registered");
}
