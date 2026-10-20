import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import { clonePaths, detectClonePaths } from "../cow-clone";
import { cleanup, g } from "./git-test-helpers";

/**
 * Real repositories, real git: the project root lags behind `main` (nobody works
 * in it), and a task worktree is checked out on `main` — the #2026 setup.
 */
interface Fixture {
	root: string;
	wt: string;
}

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function makeFixture(opts: { baseDeletesBuild?: boolean } = {}): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "dev3-cow-tracked-"));
	cleanup({ dir, local: dir });
	const root = join(dir, "root");
	mkdirSync(root);
	g("git init -q -b main", root);
	write(join(root, ".gitignore"), "node_modules\n.env\nbuild/*\n!build/keep.txt\nout/\n");
	write(join(root, "build/keep.txt"), "v1\n");
	write(join(root, "src/a.ts"), "v1\n");
	g("git add -A && git commit -qm v1", root);
	if (opts.baseDeletesBuild) {
		g("git rm -rq build", root);
	} else {
		write(join(root, "build/keep.txt"), "v2\n");
	}
	write(join(root, "src/a.ts"), "v2\n");
	g("git add -A && git commit -qm v2", root);
	g("git checkout -q HEAD~1", root);
	// Untracked/ignored content the root has and a clone path legitimately carries.
	write(join(root, "node_modules/dep/index.js"), "dep\n");
	write(join(root, ".env"), "SECRET=1\n");
	write(join(root, "build/generated.js"), "stale output\n");
	const wt = join(dir, "wt");
	g(`git worktree add -q "${wt}" main`, root);
	return { root, wt };
}

const status = (wt: string) => g("git status --porcelain", wt);

describe("clonePaths never replaces committed files (#2026)", () => {
	let fx: Fixture;
	beforeEach(() => {
		fx = makeFixture();
	});

	it("refuses a path with a tracked descendant and leaves the worktree clean", async () => {
		const results = await clonePaths(fx.root, fx.wt, ["build", "node_modules", ".env"]);

		expect(results.find((r) => r.path === "build")!.error).toContain("build/keep.txt");
		expect(readFileSync(join(fx.wt, "build/keep.txt"), "utf-8")).toBe("v2\n");
		expect(existsSync(join(fx.wt, "build/generated.js"))).toBe(false);
		expect(status(fx.wt)).toBe("");
		// Ignored paths still arrive.
		expect(results.find((r) => r.path === "node_modules")!.error).toBeUndefined();
		expect(readFileSync(join(fx.wt, "node_modules/dep/index.js"), "utf-8")).toBe("dep\n");
		expect(readFileSync(join(fx.wt, ".env"), "utf-8")).toBe("SECRET=1\n");
	});

	it("refuses a tracked path reached through a tracked symlink", async () => {
		symlinkSync("build", join(fx.root, "lnk"));
		symlinkSync("build", join(fx.wt, "lnk"));
		g("git add lnk && git commit -qm link", fx.wt);

		const [result] = await clonePaths(fx.root, fx.wt, ["lnk/keep.txt"]);

		expect(result.error).toContain("build/keep.txt");
		expect(readFileSync(join(fx.wt, "build/keep.txt"), "utf-8")).toBe("v2\n");
		expect(status(fx.wt)).toBe("");
	});

	it("refuses a differently-cased spelling on a case-insensitive filesystem", async () => {
		if (!existsSync(join(fx.wt, "BUILD"))) return; // case-sensitive filesystem: nothing to alias
		const [result] = await clonePaths(fx.root, fx.wt, ["BUILD"]);
		expect(result.error).toContain("git tracks files");
		expect(status(fx.wt)).toBe("");
	});

	it("refuses everything when git cannot inspect the destination", async () => {
		const plain = mkdtempSync(join(tmpdir(), "dev3-cow-nogit-"));
		cleanup({ dir: plain, local: plain });
		write(join(plain, "node_modules/mine.js"), "keep\n");

		const [result] = await clonePaths(fx.root, plain, ["node_modules"]);

		expect(result.error).toContain("Could not confirm with git");
		expect(readFileSync(join(plain, "node_modules/mine.js"), "utf-8")).toBe("keep\n");
	});

	it("auto-detection leaves out a tracked build/ and keeps ignored paths", async () => {
		const detected = await detectClonePaths(fx.root);
		expect(detected).not.toContain("build");
		expect(detected).toEqual(expect.arrayContaining(["node_modules", ".env"]));
	});
});

describe("root and base disagree (#2026)", () => {
	it("refuses a path only the stale project root still tracks", async () => {
		const fx = makeFixture({ baseDeletesBuild: true });
		expect(existsSync(join(fx.wt, "build"))).toBe(false);

		const results = await clonePaths(fx.root, fx.wt, ["build", "node_modules"]);

		expect(results.find((r) => r.path === "build")!.error).toContain("in the project root");
		expect(existsSync(join(fx.wt, "build"))).toBe(false);
		expect(results.find((r) => r.path === "node_modules")!.error).toBeUndefined();
		expect(status(fx.wt)).toBe("");
	});
});
