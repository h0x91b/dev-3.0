import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("../index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);

/** Builds the actual cleanup body without booting Electrobun or its pollers; unnamed calls become spies. */
function loadGlobalQuitCleanup(overrides: Record<string, unknown>): () => Promise<void> {
	const cleanup = source.statements.filter(ts.isFunctionDeclaration).find((node) => node.name?.text === "runGlobalQuitCleanup");
	expect(cleanup?.body, "runGlobalQuitCleanup moved; update this focused bootstrap test").toBeDefined();
	const names = new Set<string>(["log", "claudeSessionWatches", "codexTurnWatches"]);
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text);
		ts.forEachChild(node, visit);
	};
	visit(cleanup!);
	const values = [...names].map((name) => {
		if (name in overrides) return overrides[name];
		if (name === "log") return { info: vi.fn(), warn: vi.fn() };
		if (name === "claudeSessionWatches" || name === "codexTurnWatches") return { close: vi.fn() };
		return vi.fn();
	});
	const javascript = ts.transpileModule(cleanup!.getText(), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
	return new Function(...names, `${javascript}; return runGlobalQuitCleanup;`)(...values) as () => Promise<void>;
}

describe("global quit proxy cleanup", () => {
	it("statically imports the synchronous kill and calls it before cleanup returns", async () => {
		const imported = source.statements.filter(ts.isImportDeclaration).find((node) =>
			ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./model-sidecar");
		expect(imported?.getText(), "index.ts must statically import killModelSidecarNow for the synchronous quit gate")
			.toContain("killModelSidecarNow");
		const kill = vi.fn();
		const closeWatches = vi.fn();
		await loadGlobalQuitCleanup({
			killModelSidecarNow: kill,
			claudeSessionWatches: { close: closeWatches },
			stopAllOpenCodeServers: vi.fn(async () => {}),
		})();
		expect(closeWatches).toHaveBeenCalledExactlyOnceWith();
		expect(kill).toHaveBeenCalledExactlyOnceWith();
	});

	it("leaves every live-app service running when OpenCode shutdown cannot be verified", async () => {
		const stopSocketServer = vi.fn();
		const kill = vi.fn();
		const run = loadGlobalQuitCleanup({
			stopAllOpenCodeServers: vi.fn(async () => { throw new Error("server still alive"); }),
			stopSocketServer,
			killModelSidecarNow: kill,
		});
		await expect(run()).rejects.toThrow("server still alive");
		expect(stopSocketServer).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
	});
});
