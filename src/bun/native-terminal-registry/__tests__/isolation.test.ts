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

// The opt-in multi-session soak (seq 1301) is the third SANCTIONED non-production
// consumer: it drives real hosts through sustained load, reconnects, a crash, and
// create/stop churn, and proves in its own isolation test that nothing imports it.
const soakRoot = resolve(sourceRoot, "bun/native-terminal-soak");

// Since seq 1292 the registry HAS product callers, but only these: the host-runtime
// resolver (which build launches a host), the task-terminal module (one writer
// client per task), and the packaged host entrypoint. Everything else must reach
// the native backend through the product seam, so this list stays short by design.
// The platform launch dialect is the fifth: it owns the `ShellLaunchSpec`
// vocabulary for every generated wrapper script, and reuses this module's
// pure spec/validation helpers rather than restating them.
// Seq 1383 adds two, both for the process-naming contract only: the auxiliary
// pane seam, which stamps the task number every purpose's pane is named after,
// and read-only diagnostics — `dev3 doctor --processes` parses session records to
// answer "which dev3 task owns this pid" on the platforms whose process viewer
// cannot show it. Diagnostics reads and never starts, stops, or writes anything,
// and it is the ONLY CLI file allowed in here.
// The native pane identity module is the seventh, and the narrowest: the host and shell
// `startSignature` live only in the session record, and they are what make a pinned pane
// a strict process identity. It is its own file so the boundary is checkable rather than
// promised — see the named-import case below.
const SANCTIONED_PRODUCT_CALLERS = [
	"bun/native-host-runtime.ts",
	"bun/native-pane-identity.ts",
	"bun/native-task-panes.ts",
	"bun/native-task-terminal.ts",
	"bun/native-terminal-host/main.ts",
	"bun/task-aux-panes.ts",
	"bun/task-terminal-backend.ts",
	"bun/terminal-backend/native-backend.ts",
	"cli/commands/doctor-processes.ts",
	"shared/platform-launch.ts",
];

// Two alternatives, because one is not complete. The first catches the four direct reach
// shapes: static import, re-export, dynamic import, require. The second catches an
// indirect specifier — a module path parked in a variable and imported later — by flagging
// any RELATIVE path literal into this directory, whatever it is used for.
//
// The relative prefix is what keeps it precise. The repo has no tsconfig path aliases and
// the registry has no barrel, so a real specifier is always `./` or `../`. Repo-relative
// mentions like the CI scope list's "src/bun/native-terminal-registry/**" are not
// specifiers and stay out, which is the false positive this replaced. Both conditions the
// prefix rests on are pinned below, because they are facts about today.
//
// NOT covered: a specifier assembled at runtime from fragments. No static scan can catch
// that, and the substring detector this replaced missed it too, so it is a known limit
// rather than a regression.
const REACHES_REGISTRY =
	/(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*["'][^"']*native-terminal-registry|["']\.{1,2}\/[^"']*native-terminal-registry/;

// The detector above is precise only while a specifier into this directory must be
// relative and must spell the folder name. Both are facts about today, and both would
// go silently false — no test would notice the guard had stopped seeing a whole shape.
describe("what the relative-path discriminator rests on", () => {
	it("has no tsconfig path aliases, which would let an import skip the folder name", () => {
		const tsconfig = JSON.parse(
			readFileSync(resolve(sourceRoot, "../tsconfig.json"), "utf8"),
		) as { compilerOptions?: { paths?: Record<string, unknown>; baseUrl?: string } };
		expect(
			tsconfig.compilerOptions?.paths ?? null,
			"the relative-path discriminator in this test assumes no path aliases: an aliased import would reach the registry without `./` or the folder name, and this guard would not see it. Adding aliases means teaching REACHES_REGISTRY that shape first.",
		).toBeNull();
		expect(
			tsconfig.compilerOptions?.baseUrl ?? null,
			"a baseUrl makes bare non-relative specifiers resolvable, same blind spot as `paths` — teach REACHES_REGISTRY before adding one.",
		).toBeNull();
	});

	it("has no barrel, which would let an import name the directory and nothing else", () => {
		const barrels = moduleFiles
			.map((path) => path.slice(moduleRoot.length + 1).replaceAll("\\", "/"))
			.filter((path) => /^index\.tsx?$/.test(path));
		expect(
			barrels,
			"the relative-path discriminator still works through a barrel, but a barrel invites `from \"../native-terminal-registry\"` with no file after it — supported today, yet it also makes the module reachable in shapes this guard has never been proved against. Re-run the reach matrix before adding one.",
		).toEqual([]);
	});
});

describe("native-session registry isolation", () => {
	it("reaches production only through the sanctioned callers", () => {
		const importers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => !path.startsWith(adapterRoot))
			.filter((path) => !path.startsWith(multipaneRoot))
			.filter((path) => !path.startsWith(soakRoot))
			.filter((path) => !path.includes("__tests__"))
			// Import specifiers, not a bare substring. `includes` also flagged any file that
			// merely NAMES this directory in a string or a comment — a CI scope list does —
			// and the failure then read as "an unsanctioned module reaches the registry"
			// instead of "that is a path, not an import".
			//
			// Every way a module can reach the directory is covered, and completeness is
			// checkable rather than promised: the registry has no barrel and the repo has no
			// tsconfig path aliases, so a specifier that reaches it MUST contain the folder
			// name. If either of those ever changes, this filter stops being complete.
			.filter((path) => REACHES_REGISTRY.test(readFileSync(path, "utf8")))
			.map((path) => path.slice(sourceRoot.length + 1).replaceAll("\\", "/"))
			.sort();
		expect(importers).toEqual(SANCTIONED_PRODUCT_CALLERS);
	});

	// The door may READ a record and describe why one was rejected — nothing else. The
	// exact named-import set is what makes that enforceable rather than promised.
	it("lets the native pane identity module import the inspecting reader and nothing else", () => {
		const source = readFileSync(resolve(sourceRoot, "bun/native-pane-identity.ts"), "utf8");
		const imports = [...source.matchAll(/import\s+\{([^}]*)\}\s+from\s+["'][^"']*native-terminal-registry[^"']*["']/g)]
			.flatMap((match) => match[1].split(","))
			.map((name) => name.trim())
			.filter(Boolean)
			.sort();
		expect(imports).toEqual(["inspectRecordFile", "type RecordProblem"]);
		// Nothing may smuggle the rest of the module in by another route.
		const smuggling = [
			/import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+["'][^"']*native-terminal-registry/, // default / namespace
			/import\s*\(\s*["'][^"']*native-terminal-registry/, // dynamic import
			/require\s*\(\s*["'][^"']*native-terminal-registry/, // require
			/from\s+["'][^"']*native-terminal-registry\/(?!record")/, // any sibling module
		];
		for (const pattern of smuggling) expect(source, String(pattern)).not.toMatch(pattern);
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
