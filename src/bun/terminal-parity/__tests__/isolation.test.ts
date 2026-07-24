/**
 * Isolation guards for the parity-corpus artifact (MIG-001):
 *  - No production source imports this test-only module.
 *  - The corpus data and the runner interface stay backend-neutral: no raw tmux
 *    argv, subcommands, or `-F` format strings leak into the scenarios.
 * The tmux mapping is confined to `tmux-runner.ts`, which legitimately drives
 * tmux and is therefore exempt from the neutrality check.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

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

// The native single-view adapter (seq 1254, CUT-001) reuses this corpus + checks
// to drive a native runner — but ONLY from its tests; its production code stays
// decoupled (its own isolation test guards that). Allow its test files as a
// sanctioned, non-production consumer.
const adapterTestsRoot = resolve(sourceRoot, "bun/native-terminal-adapter/__tests__");

describe("terminal-parity corpus isolation", () => {
	it("is absent from the production source import graph", () => {
		// Match an actual import/require of the module, not a stray text mention
		// (e.g. the generated changelog bundle references this task's slug).
		const importsModule = /(?:from|import|require\s*\()\s*['"][^'"]*terminal-parity/;
		const importers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => !path.startsWith(adapterTestsRoot))
			.filter((path) => importsModule.test(readFileSync(path, "utf8")));
		expect(importers).toEqual([]);
	});

	it("keeps the shared modules free of side-effecting imports", () => {
		// Standalone `bun` e2e scripts import these modules directly. `pty-server.ts`
		// starts a WebSocket server at module load, so importing it (previously for
		// the pure `smallestClientSize` helper) left those scripts running forever
		// after their checks passed, burning the CI job's entire timeout.
		const importsPtyServer = /(?:from|import|require\s*\()\s*['"][^'"]*pty-server/;
		for (const name of ["checks.ts", "corpus.ts", "runner.ts"]) {
			const src = readFileSync(join(moduleRoot, name), "utf8");
			expect(src).not.toMatch(importsPtyServer);
		}
	});

	it("keeps corpus data and the runner interface free of raw tmux vocabulary", () => {
		// tmux `-F` format variables and subcommand/flag literals — the exact things
		// that must not leak into backend-neutral scenario cases (acceptance #2).
		const leak = /#\{|\b(?:capture-pane|split-window|new-session|kill-session|send-keys|list-panes|select-pane|has-session|resize-pane|display-message)\b|"-[tFL]"/;
		for (const name of ["corpus.ts", "runner.ts"]) {
			const src = readFileSync(join(moduleRoot, name), "utf8");
			expect(src).not.toMatch(leak);
		}
	});
});
