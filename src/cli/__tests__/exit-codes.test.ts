import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_EXIT_CODE_DEFINITIONS } from "../../shared/cli-exit-codes";

const DOC_PATH = resolve(import.meta.dirname, "../../../docs/cli-exit-codes.md");

describe("CLI exit code registry", () => {
	it("uses unique non-zero exit codes", () => {
		const nonZeroCodes = CLI_EXIT_CODE_DEFINITIONS
			.map((def) => def.code)
			.filter((code) => code !== 0);

		expect(new Set(nonZeroCodes).size).toBe(nonZeroCodes.length);
	});

	it("documents every registered exit code in docs/cli-exit-codes.md", () => {
		const doc = readFileSync(DOC_PATH, "utf-8");

		for (const def of CLI_EXIT_CODE_DEFINITIONS) {
			expect(doc).toContain(`\`${def.code}\``);
			expect(doc).toContain(`\`${def.constant}\``);
		}
	});
});
