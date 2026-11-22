import { applyBuiltinPlugins } from "../../plugins/runtime";
import { BUILTIN_OPEN_IN_TARGETS_PLUGIN } from "../builtins";
import { getOpenInTargetRegistry } from "../registry";

/** The built-in open-in targets on the current root, for a test that opens an "Open in…" surface. */
export async function installOpenInTargetBuiltins(): Promise<void> {
	applyBuiltinPlugins([], [BUILTIN_OPEN_IN_TARGETS_PLUGIN]);
	for (let tick = 0; tick < 50 && getOpenInTargetRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getOpenInTargetRegistry().list().length === 0) throw new Error("built-in open-in targets never registered");
}
