/**
 * Isolation guards for the native single-view adapter (seq 1254):
 *  - Only the sanctioned product terminal-backend seam imports it, and that seam
 *    has no product callers either — which is what keeps the registry it
 *    consumes out of the production graph too.
 *  - It never imports the removable prototype spikes.
 *  - Its production (non-test) code never imports the test-only parity corpus —
 *    the adapter conforms to the ParityRunner shape structurally; only tests
 *    drive the corpus.
 *  - It never imports or spawns tmux.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url))); // repo/src
const moduleRoot = resolve(fileURLToPath(new URL("../", import.meta.url))); // the adapter module

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

// The product terminal-backend seam (seq 1280) is a SANCTIONED consumer: its
// native adapter wraps this one, and it has no product callers of its own
// (proved by `bun/terminal-backend/__tests__/isolation.test.ts`).
const seamRoot = resolve(sourceRoot, "bun/terminal-backend");

// The native multi-pane coordinator (seq 1283) is a SANCTIONED consumer: it uses
// the adapter's snapshot surface for point-in-time captures without importing the
// rest of the single-view lifecycle.
const multipaneRoot = resolve(sourceRoot, "bun/native-terminal-multipane");

describe("native single-view adapter isolation", () => {
	it("has no product callers beyond the sanctioned seam", () => {
		// Match an actual import/require of the module, not a stray mention (the
		// registry/parity isolation tests reference the adapter path as a string to
		// exempt this sanctioned consumer).
		const importsModule = /(?:from|import|require\s*\()\s*['"][^'"]*native-terminal-adapter/;
		const importers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => !path.startsWith(seamRoot))
			.filter((path) => !path.startsWith(multipaneRoot))
			.filter((path) => importsModule.test(readFileSync(path, "utf8")));
		expect(importers).toEqual([]);
	});

	it("never imports the removable prototype spikes", () => {
		const importsPrototype = /(?:from|import|require\s*\()\s*['"][^'"]*prototypes\//;
		const offenders = moduleFiles.filter((path) => importsPrototype.test(readFileSync(path, "utf8")));
		expect(offenders).toEqual([]);
	});

	it("keeps production code decoupled from the test-only parity corpus", () => {
		const importsCorpus = /(?:from|import|require\s*\()\s*['"][^'"]*terminal-parity/;
		const offenders = moduleFilesNoTests.filter((path) => importsCorpus.test(readFileSync(path, "utf8")));
		expect(offenders).toEqual([]);
	});

	it("never imports or spawns tmux (static sentinel over the module source)", () => {
		const usesTmux = /(?:from|require\s*\()\s*['"][^'"]*tmux|['"`]tmux(?:\.exe|\.cmd)?['"`]/i;
		const offenders = moduleFilesNoTests.filter((path) => usesTmux.test(readFileSync(path, "utf8")));
		expect(offenders).toEqual([]);
	});
});
