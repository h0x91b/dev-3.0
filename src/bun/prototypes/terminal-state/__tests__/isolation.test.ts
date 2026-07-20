import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const prototypeRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (path === prototypeRoot) continue;
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
	}
	return files;
}

describe("terminal-state spike isolation", () => {
	it("is absent from the production source import graph", () => {
		const importers = sourceFiles(sourceRoot).filter((path) =>
			readFileSync(path, "utf8").includes("prototypes/terminal-state"),
		);
		expect(importers).toEqual([]);
	});
});
