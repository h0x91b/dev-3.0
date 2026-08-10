import { describe, it, expect } from "vitest";
import { isExecutableConfigPath } from "../../shared/executable-config-files";

describe("isExecutableConfigPath", () => {
	it("marks every file dev3 or an agent executes on its own", () => {
		expect(isExecutableConfigPath(".dev3/config.json")).toBe(true);
		expect(isExecutableConfigPath(".dev3/config.local.json")).toBe(true);
		expect(isExecutableConfigPath(".mcp.json")).toBe(true);
		expect(isExecutableConfigPath(".claude/settings.json")).toBe(true);
		expect(isExecutableConfigPath(".claude/settings.local.json")).toBe(true);
	});

	it("tolerates the ./ prefix and surrounding whitespace a diff may carry", () => {
		expect(isExecutableConfigPath("./.dev3/config.json")).toBe(true);
		expect(isExecutableConfigPath("  .mcp.json  ")).toBe(true);
	});

	it("leaves ordinary files alone", () => {
		expect(isExecutableConfigPath("src/bun/repo-config.ts")).toBe(false);
		expect(isExecutableConfigPath("package.json")).toBe(false);
		expect(isExecutableConfigPath(".dev3/README.md")).toBe(false);
		expect(isExecutableConfigPath(null)).toBe(false);
		expect(isExecutableConfigPath(undefined)).toBe(false);
		expect(isExecutableConfigPath("")).toBe(false);
	});

	// Only the repo root's copies are the ones dev3 reads. A same-named file nested
	// somewhere else is ordinary content and must not wear the badge.
	it("does not match a nested lookalike", () => {
		expect(isExecutableConfigPath("fixtures/.dev3/config.json")).toBe(false);
		expect(isExecutableConfigPath("docs/.mcp.json")).toBe(false);
	});
});
