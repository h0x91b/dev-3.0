import { describe, expect, it } from "vitest";
import { evaluateTscOutput } from "../lint-tsc-output";

describe("evaluateTscOutput", () => {
	it("passes on a clean run", () => {
		const result = evaluateTscOutput(0, "");
		expect(result.failed).toBe(false);
	});

	it("fails and reports src/ diagnostics", () => {
		const combined = [
			"src/bun/data.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"node_modules/electrobun/bun/index.ts(3,1): error TS2769: No overload matches this call.",
		].join("\n");
		const result = evaluateTscOutput(2, combined);
		expect(result.failed).toBe(true);
		expect(result.errorLines).toEqual([
			"src/bun/data.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
		]);
	});

	it("ignores third-party per-file diagnostics (nonzero exit, no src/ errors)", () => {
		const combined =
			"node_modules/electrobun/bun/index.ts(3,1): error TS2769: No overload matches this call.";
		const result = evaluateTscOutput(2, combined);
		expect(result.failed).toBe(false);
	});

	it("fails on a global config error (TS5058 — project file missing)", () => {
		const combined = "error TS5058: The specified path does not exist: '/tmp/nope.json'.";
		const result = evaluateTscOutput(1, combined);
		expect(result.failed).toBe(true);
		expect(result.errorLines).toEqual([
			"error TS5058: The specified path does not exist: '/tmp/nope.json'.",
		]);
	});

	it("fails on TS18003 (no inputs found)", () => {
		const combined =
			"error TS18003: No inputs were found in config file 'tsconfig.json'. Specified 'include' paths were '[\"srcc\"]'.";
		const result = evaluateTscOutput(1, combined);
		expect(result.failed).toBe(true);
	});

	it("fails on tsconfig per-file diagnostics", () => {
		const combined = "tsconfig.json(5,3): error TS1005: ',' expected.";
		const result = evaluateTscOutput(1, combined);
		expect(result.failed).toBe(true);
		expect(result.errorLines).toEqual(["tsconfig.json(5,3): error TS1005: ',' expected."]);
	});

	it("fails on nonzero exit with no diagnostics at all (crash / missing binary)", () => {
		const result = evaluateTscOutput(1, "");
		expect(result.failed).toBe(true);
	});

	it("fails when bunx cannot resolve the tsc executable", () => {
		const combined = "error: could not determine executable to run for package tsc";
		const result = evaluateTscOutput(1, combined);
		expect(result.failed).toBe(true);
		expect(result.errorLines).toEqual([
			"error: could not determine executable to run for package tsc",
		]);
	});

	it("passes on exit 0 with non-diagnostic noise in the output", () => {
		const result = evaluateTscOutput(0, "some informational banner\n");
		expect(result.failed).toBe(false);
	});
});
