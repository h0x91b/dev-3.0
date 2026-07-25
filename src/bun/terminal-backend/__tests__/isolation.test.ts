/**
 * Isolation guards for the product terminal-backend seam (MIG-002, seq 1280):
 *  - No production source imports it — this task creates the seam, not the
 *    rollout, so there is no selector, caller, flag, or persisted identity yet.
 *  - No backend-selection vocabulary anywhere in the module.
 *  - tmux stays private: only `tmux-port.ts` may speak tmux, and the barrel
 *    exports nothing tmux-shaped.
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

describe("terminal-backend seam isolation", () => {
	it("has no product callers (absent from the production import graph)", () => {
		// This module exactly — not the sibling `shared/terminal-backend-identity`.
		const importsModule = /(?:from|import|require\s*\()\s*['"][^'"]*terminal-backend(?:\/[^'"]*)?['"]/;
		const importers = sourceFiles(sourceRoot)
			.filter((path) => !path.startsWith(moduleRoot))
			.filter((path) => importsModule.test(readFileSync(path, "utf8")));
		expect(importers).toEqual([]);
	});

	it("contains no backend selection or negotiation vocabulary", () => {
		const selection = /selectBackend|backendFor|chooseBackend|terminalBackendFlag|capabilit(?:y|ies)\s*[:=]/;
		const offenders = moduleFilesNoTests.filter((path) => selection.test(readFileSync(path, "utf8")));
		expect(offenders).toEqual([]);
	});

	it("keeps tmux confined to the tmux port", () => {
		// An import of the tmux MODULE (`../tmux`, `../tmux/formats`) — not this
		// module's own `./tmux-port` / `./tmux-backend` files.
		const usesTmux = /(?:from|require\s*\()\s*['"][^'"]*\/tmux(?:\/[^'"]*)?['"]/;
		const offenders = moduleFilesNoTests
			.filter((path) => usesTmux.test(readFileSync(path, "utf8")))
			.map((path) => path.slice(moduleRoot.length + 1));
		expect(offenders).toEqual(["tmux-port.ts"]);
	});

	it("exports nothing tmux-shaped or native-registry-shaped from the barrel", () => {
		const barrel = readFileSync(join(moduleRoot, "index.ts"), "utf8");
		const exportBlock = barrel.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(exportBlock).not.toMatch(/TmuxBackendPort|TmuxClient|PANE_|NativeAdapterDeps|session-names/);
	});
});
