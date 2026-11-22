import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** `src/mainview`, where every slot is defined. */
export const MAINVIEW = resolve(__dirname, "../..");

/** Every non-test source file under `dir`. */
export function sourceFiles(dir: string = MAINVIEW): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

/**
 * Defines every slot the app reaches: importing the app and its built-in plugin composition runs
 * every `defineAppSlot` call, however a module spells or wraps it. Call it in `beforeAll`.
 */
export async function importAppSlots(): Promise<void> {
	await import("../../App");
	await import("../../builtin-plugins");
}
