import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_GO_TO_SOURCES_PLUGIN } from "../builtins";
import { getGoToSourceRegistry, resetGoToSourceFailuresForTests } from "../registry";

/** A fresh plugin root with the built-in palette sources, for any test that opens the Go-to palette. */
export async function installGoToSourceBuiltins(): Promise<void> {
	resetPluginsForTests();
	resetGoToSourceFailuresForTests();
	applyBuiltinPlugins([], [BUILTIN_GO_TO_SOURCES_PLUGIN]);
	for (let tick = 0; tick < 50 && getGoToSourceRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getGoToSourceRegistry().list().length === 0) throw new Error("built-in go-to sources never registered");
}
