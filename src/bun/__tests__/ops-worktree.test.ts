import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../paths", () => ({ DEV3_HOME: join(tmpdir(), `dev3-home-test-${process.pid}`) }));
vi.mock("../git", () => ({
	detectDefaultCompareRef: vi.fn().mockResolvedValue("origin/main"),
	resolveConfiguredCompareRef: vi.fn(async (_p: string, _b: string, configured: string) => configured),
	projectSlug: (p: string) => p.replace(/^\//, "").replaceAll("/", "-"),
}));

import { resolveLaunchProject } from "../ops-worktree";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function dirWithConfig(config: object): string {
	const dir = mkdtempSync(join(tmpdir(), "dev3-ops-wt-"));
	dirs.push(dir);
	mkdirSync(join(dir, ".dev3"));
	writeFileSync(join(dir, ".dev3", "config.json"), JSON.stringify(config));
	return dir;
}

const project = { id: "vp1", kind: "virtual", path: "/tmp/dev3-test/ops/operations", setupScript: "" } as any;

describe("resolveLaunchProject", () => {
	it("gives a worktree-mode task the repo's config while the project path keeps keying the task file", async () => {
		const repo = dirWithConfig({ setupScript: "bun install", env: { A: "1" } });
		const worktree = dirWithConfig({});

		const resolved = await resolveLaunchProject(project, { opsWorktree: true, attachedRepo: repo } as any, worktree);

		expect(resolved.setupScript).toBe("bun install");
		expect(resolved.env).toEqual({ A: "1" });
		expect(resolved.path).toBe(project.path);
		expect(resolved.kind).toBe("virtual");
	});

	it("prefers the worktree's own committed config over the repo's", async () => {
		const repo = dirWithConfig({ setupScript: "from repo" });
		const worktree = dirWithConfig({ setupScript: "from worktree" });

		const resolved = await resolveLaunchProject(project, { opsWorktree: true, attachedRepo: repo } as any, worktree);

		expect(resolved.setupScript).toBe("from worktree");
	});

	it("leaves a plain Operations task and an attached-only task untouched", async () => {
		const repo = dirWithConfig({ setupScript: "bun install" });

		expect(await resolveLaunchProject(project, {} as any, repo)).toBe(project);
		expect(await resolveLaunchProject(project, { attachedRepo: repo } as any, repo)).toBe(project);
	});
});
