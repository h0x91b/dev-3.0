import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url))); // repo/src
const moduleRoot = resolve(fileURLToPath(new URL("../", import.meta.url))); // the registry module

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

describe("native-session registry isolation", () => {
	it("is absent from the production source import graph", () => {
		const importers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => readFileSync(path, "utf8").includes("native-terminal-registry"));
		expect(importers).toEqual([]);
	});

	it("never imports the removable prototype spikes", () => {
		const importsPrototype = /(?:from|import|require\s*\()\s*['"][^'"]*prototypes\//;
		const offenders = moduleFiles.filter((path) => importsPrototype.test(readFileSync(path, "utf8")));
		expect(offenders).toEqual([]);
	});

	it("never imports or spawns tmux (static sentinel over the module source)", () => {
		// Flag real usage — a tmux import path or a "tmux" command literal — not the
		// word appearing in prose that documents this module never touches tmux.
		const usesTmux = /(?:from|require\s*\()\s*['"][^'"]*tmux|['"`]tmux(?:\.exe|\.cmd)?['"`]/i;
		const offenders = moduleFilesNoTests.filter((path) => usesTmux.test(readFileSync(path, "utf8")));
		expect(offenders).toEqual([]);
	});
});
