import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(process.cwd());

function filesUnder(root: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (statSync(path).isDirectory()) files.push(...filesUnder(path));
		else if (/\.(?:ts|tsx)$/.test(name)) files.push(path);
	}
	return files;
}

describe("test isolation audit", () => {
	it("keeps destructive filesystem and real socket operations off fixed /tmp paths", () => {
		const failures: string[] = [];
		const roots = ["src/bun/__tests__", "src/cli/__tests__", "src/mainview/__tests__"];

		for (const root of roots) {
			for (const path of filesUnder(join(REPO_ROOT, root))) {
				const source = readFileSync(path, "utf8");
				const directLiteral = /(?:rmSync|mkdirSync|writeFileSync|unlinkSync|rmdirSync|\.listen)\(\s*["'`]\/tmp\//;
				if (directLiteral.test(source)) {
					failures.push(`${relative(REPO_ROOT, path)} uses a fixed /tmp path in a stateful operation`);
				}

				for (const match of source.matchAll(/^const\s+([A-Z][A-Z0-9_]*(?:HOME|DIR|ROOT|SOCKET|FILE|PATH))\s*=\s*["'`]\/tmp\//gm)) {
					const name = match[1];
					const statefulUse = new RegExp(`(?:rmSync|mkdirSync|writeFileSync|unlinkSync|rmdirSync|\\.listen)\\(\\s*${name}\\b`);
					if (statefulUse.test(source)) {
						failures.push(`${relative(REPO_ROOT, path)} reuses fixed /tmp constant ${name}`);
					}
				}

				for (const match of source.matchAll(/^const\s+([A-Z][A-Z0-9_]*(?:HOME|DIR|ROOT|SOCKET|FILE|PATH))\s*=\s*`\/tmp\/[^`]*\$\{/gm)) {
					const name = match[1];
					const statefulUse = new RegExp(`(?:rmSync|mkdirSync|writeFileSync|unlinkSync|rmdirSync|\\.listen)\\(\\s*${name}\\b`);
					if (statefulUse.test(source)) {
						failures.push(`${relative(REPO_ROOT, path)} reuses dynamic /tmp constant ${name}`);
					}
				}
			}
		}

		expect(failures).toEqual([]);
	});

	it("routes production scratch files through the test-aware temp helper", () => {
		const failures = filesUnder(join(REPO_ROOT, "src/bun"))
			.filter((path) => !path.includes("/__tests__/"))
			.filter((path) => /\/tmp\/dev3-/.test(readFileSync(path, "utf8")))
			.map((path) => relative(REPO_ROOT, path));

		expect(failures).toEqual([]);
	});
});
