import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard: the `dev3` CLI is now a SINGLE binary that also contains the headless
 * server (`dev3 remote` boots it). The whole point of variant-2 is that the
 * heavy backend stays OUT of the CLI's startup path — it's pulled only via a
 * dynamic `import("../../bun/headless-entry")` inside the remote handler, which
 * Bun bundles into the executable but does NOT evaluate until `dev3 remote`
 * actually runs.
 *
 * This test walks the STATIC import graph starting from `src/cli/main.ts`
 * (dynamic `import()` is deliberately ignored) and asserts that none of the
 * heavy/native backend modules are statically reachable. If someone adds a
 * top-level `import ... from ".../headless-entry"` (or pulls in electrobun) to
 * any CLI module, every `dev3 <cmd>` invocation would suddenly pay the backend's
 * startup cost — this test goes red before that ships.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const ENTRY = resolve(REPO_ROOT, "src/cli/main.ts");

// Matches static `import ... from "x"` / `export ... from "x"` (including
// multi-line forms — `[^'";]*?` spans newlines but stops at the next quote or
// statement terminator). Dynamic `import("x")` has no `from`, so it never
// matches — exactly what we want. The `(?!\s+type\b)` lookahead skips
// type-only `import type` / `export type` statements: TypeScript erases them,
// so they carry ZERO runtime cost and must not count toward the startup graph
// (e.g. `import type { RPCSchema } from "electrobun/bun"` in shared/types.ts).
const FROM_RE = /(?:^|\n)\s*(?:import|export)\b(?!\s+type\b)[^'";]*?\bfrom\s*["']([^"']+)["']/g;
// Side-effect static imports: `import "x";`.
const SIDE_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "") // block comments
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (keep `https://`)
}

function resolveRelative(fromFile: string, spec: string): string | null {
	const base = resolve(dirname(fromFile), spec);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		resolve(base, "index.ts"),
		resolve(base, "index.tsx"),
	];
	for (const c of candidates) {
		if (existsSync(c) && statSync(c).isFile()) return c;
	}
	return null;
}

function walkStaticGraph(entry: string): { files: Set<string>; bare: Set<string> } {
	const files = new Set<string>();
	const bare = new Set<string>();
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.pop()!;
		if (files.has(file)) continue;
		files.add(file);

		const code = stripComments(readFileSync(file, "utf8"));
		const specs: string[] = [];
		for (const m of code.matchAll(FROM_RE)) specs.push(m[1]);
		for (const m of code.matchAll(SIDE_RE)) specs.push(m[1]);

		for (const spec of specs) {
			if (spec.startsWith(".")) {
				const resolved = resolveRelative(file, spec);
				if (resolved) queue.push(resolved);
			} else {
				bare.add(spec);
			}
		}
	}
	return { files, bare };
}

describe("CLI startup import graph stays light", () => {
	const { files, bare } = walkStaticGraph(ENTRY);

	it("walks a non-trivial graph that includes the remote command", () => {
		// Sanity: the walker actually traversed the CLI, so a green result below
		// means "not reachable", not "walker found nothing".
		expect(files.size).toBeGreaterThan(10);
		expect(files.has(resolve(REPO_ROOT, "src/cli/commands/remote.ts"))).toBe(true);
	});

	it("never statically imports the headless backend", () => {
		const forbidden = [
			"src/bun/headless-entry.ts",
			"src/bun/remote-access-server.ts",
			"src/bun/rpc-handlers.ts",
		].map((p) => resolve(REPO_ROOT, p));

		// Guard against a typo silently disarming the test.
		for (const f of forbidden) expect(existsSync(f)).toBe(true);

		for (const f of forbidden) {
			expect(files.has(f), `${f} must NOT be in the CLI static import graph`).toBe(false);
		}
	});

	it("never statically imports electrobun (the native GUI layer)", () => {
		const electrobunDeps = [...bare].filter((d) => d === "electrobun" || d.startsWith("electrobun/"));
		expect(electrobunDeps, `unexpected static electrobun import(s): ${electrobunDeps.join(", ")}`).toEqual([]);
	});
});

/**
 * The headless server must be window-free BY DESIGN, not by luck. `dev3 remote`
 * is the documented answer for a machine with no interactive desktop — the exact
 * situation where creating a BrowserWindow yields a window with no WebView2
 * controller and no renderer (see renderer-readiness.ts). If the window layer
 * ever becomes statically reachable from headless-entry, remote mode inherits
 * that failure mode; this goes red first.
 */
describe("headless server never reaches the desktop window layer", () => {
	const HEADLESS_ENTRY = resolve(REPO_ROOT, "src/bun/headless-entry.ts");
	const { files, bare } = walkStaticGraph(HEADLESS_ENTRY);

	it("walks a non-trivial graph that includes the remote access server", () => {
		expect(files.size).toBeGreaterThan(10);
		expect(files.has(resolve(REPO_ROOT, "src/bun/remote-access-server.ts"))).toBe(true);
	});

	it("never statically imports the window manager", () => {
		const windowManager = resolve(REPO_ROOT, "src/bun/window-manager.ts");
		expect(existsSync(windowManager)).toBe(true);
		expect(files.has(windowManager), "headless mode must never reach window-manager").toBe(false);
	});

	it("never statically imports electrobun's native GUI layer", () => {
		const electrobunDeps = [...bare].filter((d) => d === "electrobun" || d.startsWith("electrobun/"));
		expect(electrobunDeps, `unexpected static electrobun import(s): ${electrobunDeps.join(", ")}`).toEqual([]);
	});
});
