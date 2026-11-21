import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** `src/mainview`, where every slot is defined. */
export const MAINVIEW = resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

/**
 * Every module that defines a slot on the app root, found by scanning so a new one cannot be
 * forgotten. Import them all before enumerating the root's slots: a slot exists once its module loads.
 */
export const SLOT_MODULES = sourceFiles(MAINVIEW).filter(
	(file) => !file.endsWith(join("plugins", "root.ts")) && readFileSync(file, "utf8").includes("defineAppSlot("),
);
