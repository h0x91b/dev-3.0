import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = readFileSync(fileURLToPath(new URL("./run-windows-shell-matrix.ps1", import.meta.url)), "utf8");

describe("native Windows shell matrix runner", () => {
	it("collapses duplicate PATH applications to one scalar executable path", () => {
		expect(runner).toContain("function Get-ApplicationPath");
		expect(runner).toContain("Select-Object -First 1 -ExpandProperty Source");
		expect(runner.match(/Get-Command /g)).toHaveLength(1);
		expect(runner).not.toMatch(/& \$[A-Za-z]+\.Source/);
	});
});
