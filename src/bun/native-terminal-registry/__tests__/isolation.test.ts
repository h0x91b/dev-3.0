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

// The native single-view adapter (seq 1254) is a SANCTIONED non-production
// consumer of this registry: it composes these primitives but has no product
// callers of its own (proved by its own isolation test), so it does not put the
// registry into the app/CLI graph.
const adapterRoot = resolve(sourceRoot, "bun/native-terminal-adapter");

// The native multi-pane coordinator (seq 1283) is the second SANCTIONED
// non-production consumer: it composes one registry-owned host per logical pane
// and proves in its own isolation test that nothing imports it either.
const multipaneRoot = resolve(sourceRoot, "bun/native-terminal-multipane");

// Since seq 1292 the registry HAS product callers, but only these: the host-runtime
// resolver (which build launches a host), the task-terminal module (one writer
// client per task), and the packaged host entrypoint. Everything else must reach
// the native backend through the product seam, so this list stays short by design.
// The platform launch dialect is the fifth: it owns the `ShellLaunchSpec`
// vocabulary for every generated wrapper script, and reuses this module's
// pure spec/validation helpers rather than restating them.
const SANCTIONED_PRODUCT_CALLERS = [
	"bun/native-host-runtime.ts",
	"bun/native-task-terminal.ts",
	"bun/native-terminal-host/main.ts",
	"bun/task-terminal-backend.ts",
	"shared/platform-launch.ts",
];

describe("native-session registry isolation", () => {
	it("reaches production only through the sanctioned callers", () => {
		const importers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => !path.startsWith(adapterRoot))
			.filter((path) => !path.startsWith(multipaneRoot))
			.filter((path) => !path.includes("__tests__"))
			.filter((path) => readFileSync(path, "utf8").includes("native-terminal-registry"))
			.map((path) => path.slice(sourceRoot.length + 1).replaceAll("\\", "/"))
			.sort();
		expect(importers).toEqual(SANCTIONED_PRODUCT_CALLERS);
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
