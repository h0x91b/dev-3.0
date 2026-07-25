import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url))); // repo/src
const moduleRoot = resolve(fileURLToPath(new URL("../", import.meta.url))); // the soak harness

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

describe("native-terminal soak isolation", () => {
	it("has no product callers — it is a proof harness, not a shipped feature", () => {
		// Match a real module reference, not any occurrence of the name: the
		// generated `changelog-bundled.ts` embeds this task's changelog SLUG, and a
		// naive substring scan reported that build artifact as a product caller.
		const importsSoak = /(?:from|import|require\s*\()\s*['"][^'"]*native-terminal-soak/;
		const importers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => importsSoak.test(readFileSync(path, "utf8")))
			.map((path) => path.slice(sourceRoot.length + 1).replaceAll("\\", "/"))
			.sort();
		expect(importers).toEqual([]);
	});

	it("never imports or spawns tmux", () => {
		const usesTmux = /(?:from|require\s*\()\s*['"][^'"]*tmux|['"`]tmux(?:\.exe|\.cmd)?['"`]/i;
		const offenders = moduleFilesNoTests
			.filter((path) => usesTmux.test(readFileSync(path, "utf8")))
			// The harness plants a PATH shim named tmux as a sentinel; that is the point.
			.filter((path) => !path.endsWith("run-soak.ts"));
		expect(offenders).toEqual([]);
	});

	it("keeps the entry point out of every vitest suite", () => {
		const collected = moduleFiles.filter((path) => /\.(?:test|spec)\.tsx?$/.test(path));
		for (const path of collected) expect(path).toContain("__tests__");
		expect(moduleFilesNoTests.some((path) => path.endsWith("run-soak.ts"))).toBe(true);
		expect(collected.some((path) => path.endsWith("run-soak.ts"))).toBe(false);
	});
});
