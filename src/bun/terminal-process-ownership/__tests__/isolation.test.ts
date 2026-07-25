/**
 * Isolation guards for the ownership accounting module (seq 1293):
 *  - No production source imports it yet — this task builds the accounting seam,
 *    not its rollout (no UI, no RPC, no poller rewiring).
 *  - tmux stays confined to `tmux-source.ts`; the native path can never reach it.
 *  - The module is read-only: nothing here signals or kills a process.
 */

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
const relative = (path: string): string => path.slice(moduleRoot.length + 1);

describe("terminal process ownership isolation", () => {
	it("has no product callers (absent from the production import graph)", () => {
		const importsModule = /(?:from|require\s*\()\s*['"][^'"]*terminal-process-ownership(?:\/[^'"]*)?['"]/;
		const importers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => importsModule.test(readFileSync(path, "utf8")));
		expect(importers).toEqual([]);
	});

	it("keeps tmux confined to the tmux source", () => {
		// An import of the tmux MODULE (`../tmux`) — not this module's own files.
		const usesTmux = /(?:from|require\s*\()\s*['"][^'"]*\/tmux(?:\/[^'"]*)?['"]/;
		const offenders = moduleFilesNoTests.filter((path) => usesTmux.test(readFileSync(path, "utf8"))).map(relative);
		expect(offenders).toEqual(["tmux-source.ts"]);
	});

	it("never lets the native path reach tmux", () => {
		// Flag real usage — a tmux import path or a "tmux" command literal — not the
		// word appearing in prose that documents the boundary.
		const usesTmux = /(?:from|require\s*\()\s*['"][^'"]*tmux|['"`]tmux(?:\.exe|\.cmd)?['"`]/i;
		expect(usesTmux.test(readFileSync(join(moduleRoot, "native-source.ts"), "utf8"))).toBe(false);
	});

	it("signals no process (read-only accounting)", () => {
		const mutates = /process\.kill|SIGKILL|SIGTERM|killPane|killSession|terminateJob/;
		const offenders = moduleFilesNoTests.filter((path) => mutates.test(readFileSync(path, "utf8"))).map(relative);
		expect(offenders).toEqual([]);
	});

	it("exports nothing backend-internal from the barrel", () => {
		const barrel = readFileSync(join(moduleRoot, "index.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		expect(barrel).not.toMatch(/TmuxOwnershipPort|tmuxOwnershipPort|TmuxClient|PANE_/);
	});
});
