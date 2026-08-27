import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

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

/** Every test file, including the ones in nested `__tests__` dirs. */
function testFiles(): string[] {
	return ["src/bun", "src/cli", "src/mainview"]
		.flatMap((root) => filesUnder(join(REPO_ROOT, root)))
		.filter((path) => path.includes(`${sep}__tests__${sep}`));
}

describe("test isolation audit", () => {
	it("keeps destructive filesystem and real socket operations off fixed /tmp paths", () => {
		const failures: string[] = [];
		for (const path of testFiles()) {
			const source = readFileSync(path, "utf8");
			const directLiteral = /(?:rmSync|mkdirSync|mkdtempSync|writeFileSync|unlinkSync|rmdirSync|\.listen)\(\s*["'`]\/tmp\//;
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

		expect(failures).toEqual([]);
	});

	it("builds every unix socket fixture path through the socket helper", () => {
		// A socket path over ~104 bytes fails to bind with a bare EINVAL that reads
		// like a broken fixture. The isolated run root and TMPDIR are both far too
		// deep to fit one, so a `.sock` under either is a latent failure that only
		// shows up on a machine with a longer temp dir. `testSocketPath` /
		// `testSocketRoot` are the only sanctioned base.
		const failures: string[] = [];
		for (const path of testFiles()) {
			const source = readFileSync(path, "utf8");
			for (const line of source.split("\n")) {
				const deepBase = /tmpdir\(\)|DEV3_TEST_ROOT/.test(line);
				if (deepBase && /\.sock/.test(line)) {
					failures.push(`${relative(REPO_ROOT, path)} builds a socket path under a deep temp root: ${line.trim()}`);
				}
			}
		}

		expect(failures).toEqual([]);
	});

	it("routes production scratch files through the test-aware temp helper", () => {
		const failures = filesUnder(join(REPO_ROOT, "src/bun"))
			.filter((path) => !path.includes("/__tests__/"))
			// changelog-bundled.ts is generated changelog DATA (entry bodies), not source —
			// an entry may legitimately mention a "/tmp/dev3-…" path as documentation.
			.filter((path) => !path.endsWith("changelog-bundled.ts"))
			.filter((path) => /\/tmp\/dev3-/.test(readFileSync(path, "utf8")))
			.map((path) => relative(REPO_ROOT, path));

		expect(failures).toEqual([]);
	});
});
