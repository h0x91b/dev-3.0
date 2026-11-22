import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_FILE_VIEWERS_PLUGIN } from "../builtins";
import { getFileViewerRegistry, resetFileViewerFailuresForTests } from "../registry";

/** A fresh plugin root with the built-in file viewers, for any test that opens a file preview. */
export async function installFileViewerBuiltins(): Promise<void> {
	resetPluginsForTests();
	resetFileViewerFailuresForTests();
	applyBuiltinPlugins([], [BUILTIN_FILE_VIEWERS_PLUGIN]);
	for (let tick = 0; tick < 50 && getFileViewerRegistry().list().length === 0; tick++) await Promise.resolve();
	if (getFileViewerRegistry().list().length === 0) throw new Error("built-in file viewers never registered");
}
