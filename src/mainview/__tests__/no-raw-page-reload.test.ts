import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// A raw reload pops the remote tab-close guard's "Leave site?" prompt on the app's
// own deliberate reload; every one must go through `reloadPage()` (tab-close-guard.ts).
const ROOT = join(__dirname, "..");
const ALLOWED = new Set(["tab-close-guard.ts"]);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
		return /\.(ts|tsx)$/.test(name) ? [path] : [];
	});
}

describe("page reloads", () => {
	it("never call location.reload() outside reloadPage()", () => {
		const offenders = sourceFiles(ROOT)
			.filter((path) => !ALLOWED.has(relative(ROOT, path)))
			.filter((path) =>
				readFileSync(path, "utf8")
					.split("\n")
					.some((line) => /location\.reload\(\)/.test(line) && !/^\s*(\*|\/\/)/.test(line)),
			)
			.map((path) => relative(ROOT, path));
		expect(offenders).toEqual([]);
	});
});
