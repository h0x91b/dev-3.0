import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("../index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);

describe("global quit proxy cleanup", () => {
	it("statically imports the synchronous kill and calls it before cleanup returns", () => {
		const imported = source.statements.filter(ts.isImportDeclaration).find((node) =>
			ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./model-sidecar");
		expect(imported?.getText(), "index.ts must statically import killModelSidecarNow for the synchronous quit gate")
			.toContain("killModelSidecarNow");
		const cleanup = source.statements.filter(ts.isFunctionDeclaration).find((node) => node.name?.text === "runGlobalQuitCleanup");
		expect(cleanup?.body, "runGlobalQuitCleanup moved; update this focused bootstrap test").toBeDefined();

		// Execute the actual cleanup body without booting Electrobun or its pollers.
		const names = new Set<string>(["log"]);
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text);
			ts.forEachChild(node, visit);
		};
		visit(cleanup!);
		const kill = vi.fn();
		const values = [...names].map((name) => name === "log" ? { info: vi.fn(), warn: vi.fn() } : name === "killModelSidecarNow" ? kill : vi.fn());
		const javascript = ts.transpileModule(cleanup!.getText(), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		const run = new Function(...names, `${javascript}; return runGlobalQuitCleanup;`)(...values) as () => void;
		run();
		expect(kill).toHaveBeenCalledExactlyOnceWith();
	});
});
