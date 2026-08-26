import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { concurrentBudget, concurrentShare, resolveMaxWorkers } from "../../../test-workers";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

describe("concurrent test worker budget", () => {
	it("keeps the vitest default when nothing asks for a cap", () => {
		expect(resolveMaxWorkers("bun", {})).toBeUndefined();
	});

	it("splits the chosen budget of 9 across the three concurrent suites", () => {
		expect(concurrentBudget(16)).toBe(9);
		expect(concurrentShare("mainview", 16)).toBe(4);
		expect(concurrentShare("bun", 16)).toBe(4);
		expect(concurrentShare("cli", 16)).toBe(1);
	});

	it("always splits exactly the budget, on any box size", () => {
		for (const cores of [1, 2, 4, 8, 12, 16, 24, 32, 64, 128]) {
			const total = (["mainview", "bun", "cli"] as const)
				.map((suite) => concurrentShare(suite, cores))
				.reduce((sum, share) => sum + share, 0);

			expect(total).toBe(concurrentBudget(cores));
		}
	});

	it("never starves a suite down to zero workers on a tiny box", () => {
		for (const cores of [1, 2, 4]) {
			for (const suite of ["mainview", "bun", "cli"] as const) {
				expect(concurrentShare(suite, cores)).toBeGreaterThanOrEqual(1);
			}
		}
	});

	it("caps each suite once the concurrent scripts announce themselves", () => {
		const env = { DEV3_TEST_CONCURRENT: "1" };
		expect(resolveMaxWorkers("mainview", env)).toBe(concurrentShare("mainview"));
		expect(resolveMaxWorkers("cli", env)).toBe(concurrentShare("cli"));
	});

	it("lets an explicit override win, and ignores junk", () => {
		expect(resolveMaxWorkers("bun", { DEV3_TEST_MAX_WORKERS: "3" })).toBe(3);
		expect(resolveMaxWorkers("bun", { DEV3_TEST_MAX_WORKERS: "0" })).toBeUndefined();
		expect(resolveMaxWorkers("bun", { DEV3_TEST_MAX_WORKERS: "nope" })).toBeUndefined();
	});

	// Without the flag the three scripts fall back to the vitest default and put ~3
	// workers per core on the box again, which is the bug this file exists to hold shut.
	it("has both concurrent scripts announcing themselves, and no solo script doing it", () => {
		const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;

		expect(scripts.test).toContain("DEV3_TEST_CONCURRENT=1");
		expect(scripts["test:full"]).toContain("DEV3_TEST_CONCURRENT=1");
		expect(scripts["test:bun"]).not.toContain("DEV3_TEST_CONCURRENT");
		expect(scripts["test:cli"]).not.toContain("DEV3_TEST_CONCURRENT");
	});

	it("keeps every vitest config reading the budget", () => {
		for (const [config, suite] of [
			["vitest.config.ts", "mainview"],
			["vitest.config.bun.ts", "bun"],
			["vitest.config.cli.ts", "cli"],
		]) {
			expect(readFileSync(join(repoRoot, config), "utf8"))
				.toContain(`maxWorkers: resolveMaxWorkers("${suite}")`);
		}
	});
});
