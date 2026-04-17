import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("release workflow lockfile references", () => {
	it("hashes only lockfiles that exist in the repository", () => {
		const workflowPath = resolve(repoRoot, ".github/workflows/release.yml");
		const workflow = readFileSync(workflowPath, "utf-8");
		const lockfiles = [...workflow.matchAll(/hashFiles\('([^']+)'\)/g)].map((match) => match[1]);

		expect(lockfiles.length).toBeGreaterThan(0);

		for (const lockfile of lockfiles) {
			expect(
				existsSync(resolve(repoRoot, lockfile)),
				`Expected ${lockfile} referenced in release.yml to exist`,
			).toBe(true);
		}
	});
});
