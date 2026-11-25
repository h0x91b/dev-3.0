import { describe, expect, it } from "vitest";
import { evaluateTscOutput } from "../lint-tsc-output";

describe("evaluateTscOutput", () => {
	it("passes a clean run, third-party per-file diagnostics, and exit-0 noise", () => {
		const cases: Array<[name: string, exitCode: number, output: string]> = [
			["clean run", 0, ""],
			["third-party per-file diagnostic, nonzero exit", 2, "node_modules/electrobun/bun/index.ts(3,1): error TS2769: No overload matches this call."],
			["informational banner on exit 0", 0, "some informational banner\n"],
		];
		for (const [name, exitCode, output] of cases) {
			expect(evaluateTscOutput(exitCode, output).failed, name).toBe(false);
		}
	});

	it("fails on src/, config, tsconfig and launcher errors and on a silent nonzero exit, reporting the error lines", () => {
		const SRC = "src/bun/data.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.";
		const cases: Array<[name: string, exitCode: number, output: string, errorLines?: string[]]> = [
			["src/ diagnostic beside a third-party one", 2, `${SRC}\nnode_modules/electrobun/bun/index.ts(3,1): error TS2769: No overload matches this call.`, [SRC]],
			["global config error (TS5058 — project file missing)", 1, "error TS5058: The specified path does not exist: '/tmp/nope.json'.", ["error TS5058: The specified path does not exist: '/tmp/nope.json'."]],
			["TS18003 (no inputs found)", 1, "error TS18003: No inputs were found in config file 'tsconfig.json'. Specified 'include' paths were '[\"srcc\"]'."],
			["tsconfig per-file diagnostic", 1, "tsconfig.json(5,3): error TS1005: ',' expected.", ["tsconfig.json(5,3): error TS1005: ',' expected."]],
			["nonzero exit with no diagnostics (crash / missing binary)", 1, ""],
			["bunx cannot resolve the tsc executable", 1, "error: could not determine executable to run for package tsc", ["error: could not determine executable to run for package tsc"]],
		];
		for (const [name, exitCode, output, errorLines] of cases) {
			const result = evaluateTscOutput(exitCode, output);
			expect(result.failed, name).toBe(true);
			if (errorLines) expect(result.errorLines, name).toEqual(errorLines);
		}
	});

	// The wrapper pins `--pretty false` precisely so this shape never reaches us:
	// tsc's pretty output carries no `(line,col):` and would read as a crash, so a
	// third-party error would fail every local (TTY) run while CI stayed green.
	it("cannot recognise a pretty-printed third-party diagnostic — hence --pretty false", () => {
		const combined = "node_modules/electrobun/dist/api/bun/index.ts:32:24 - error TS7016: Could not find a declaration file.";
		expect(evaluateTscOutput(2, combined).failed).toBe(true);
	});
});
