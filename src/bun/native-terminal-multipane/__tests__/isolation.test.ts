import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url))); // repo/src
const moduleRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
	}
	return files;
}

const moduleFiles = sourceFiles(moduleRoot);
const moduleFilesNoTests = moduleFiles.filter((path) => !path.includes("__tests__"));

describe("native multipane coordinator isolation", () => {
	it("has no product callers — nothing outside the module imports it", () => {
		// Sibling isolation tests may NAME this module in their allowlists; only a
		// real import from product source would put it into the app graph.
		const importsMultipane = /(?:from|import|require\s*\()\s*['"][^'"]*native-terminal-multipane/;
		const importers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => importsMultipane.test(readFileSync(path, "utf8")));
		expect(importers).toEqual([]);
	});

	it("never imports or spawns tmux (static sentinel over the module source)", () => {
		const usesTmux = /(?:from|require\s*\()\s*['"][^'"]*tmux|['"`]tmux(?:\.exe|\.cmd)?['"`]/i;
		expect(moduleFilesNoTests.filter((path) => usesTmux.test(readFileSync(path, "utf8")))).toEqual([]);
	});

	it("never touches the legacy tmux task records or the registry's own namespace root", () => {
		const legacy = /tasks\.json|projects\.json|DEV3_NATIVE_SESSIONS_DIR/;
		expect(moduleFilesNoTests.filter((path) => legacy.test(readFileSync(path, "utf8")))).toEqual([]);
	});

	it("keeps the client-local layout model free of PTY dimensions", () => {
		const source = readFileSync(join(moduleRoot, "client-view.ts"), "utf8");
		expect(/\bcols\b|\brows\b|resize/.test(source)).toBe(false);
	});
});
