import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../paths", () => ({
	DEV3_HOME: join(tmpdir(), `dev3-home-test-${process.pid}`),
	OPS_DIR: join(tmpdir(), `dev3-ops-wt-test-${process.pid}`),
}));
vi.mock("../git", () => ({
	detectDefaultCompareRef: vi.fn().mockResolvedValue("origin/main"),
	resolveConfiguredCompareRef: vi.fn(async (_p: string, _b: string, configured: string) => configured),
	projectSlug: (p: string) => p.replace(/^\//, "").replaceAll("/", "-"),
}));

import { isAttachedRepoInTaskFolder } from "../../shared/types";
import { OPS_DIR } from "../paths";
import { repoPathInOwnTaskFolder, resolveLaunchProject } from "../ops-worktree";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	rmSync(OPS_DIR, { recursive: true, force: true });
});

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

describe("repoPathInOwnTaskFolder", () => {
	const folder = () => `${OPS_DIR}/slug/abcdef12/work`;

	it("accepts the folder itself and anything below it", () => {
		expect(repoPathInOwnTaskFolder(folder(), folder())).toBe(folder());
		expect(repoPathInOwnTaskFolder(`${folder()}/repo`, folder())).toBe(`${folder()}/repo`);
	});

	it("rejects another task's folder, a sibling with the same prefix and a path outside OPS_DIR", () => {
		expect(repoPathInOwnTaskFolder(`${OPS_DIR}/slug/99999999/work/repo`, folder())).toBeNull();
		expect(repoPathInOwnTaskFolder(`${folder()}-2/repo`, folder())).toBeNull();
		expect(repoPathInOwnTaskFolder("/elsewhere/repo", folder())).toBeNull();
	});

	it("never treats a folder outside OPS_DIR as a managed one", () => {
		expect(repoPathInOwnTaskFolder("/chosen/dir/repo", "/chosen/dir")).toBeNull();
		expect(repoPathInOwnTaskFolder("/x", null)).toBeNull();
	});

	it("rewrites a symlink-resolved root onto the folder as the task stores it", () => {
		const real = join(tmpdir(), `dev3-ops-wt-real-${process.pid}`);
		dirs.push(real);
		mkdirSync(join(real, "slug", "abcdef12", "work", "repo"), { recursive: true });
		symlinkSync(real, OPS_DIR);
		const resolved = join(realpathSync(OPS_DIR), "slug", "abcdef12", "work", "repo");

		expect(repoPathInOwnTaskFolder(resolved, folder())).toBe(`${folder()}/repo`);
	});
});

describe("isAttachedRepoInTaskFolder", () => {
	const task = { worktreePath: "/ops/slug/abcdef12/work" };

	it("is true for anything strictly below the folder, and false for the folder itself", () => {
		expect(isAttachedRepoInTaskFolder({ ...task, attachedRepo: "/ops/slug/abcdef12/work" })).toBe(false);
		expect(isAttachedRepoInTaskFolder({ ...task, attachedRepo: "/ops/slug/abcdef12/work/wt" })).toBe(true);
	});

	it("is false outside the folder, for a sibling with the same prefix, and with nothing attached", () => {
		expect(isAttachedRepoInTaskFolder({ ...task, attachedRepo: "/repos/main" })).toBe(false);
		expect(isAttachedRepoInTaskFolder({ ...task, attachedRepo: "/ops/slug/abcdef12/work-2" })).toBe(false);
		expect(isAttachedRepoInTaskFolder({ ...task, attachedRepo: null })).toBe(false);
		expect(isAttachedRepoInTaskFolder({ worktreePath: null, attachedRepo: "/ops/x" })).toBe(false);
	});

	it("is false for worktree mode and for a user-chosen folder", () => {
		expect(isAttachedRepoInTaskFolder({ ...task, attachedRepo: "/ops/slug/abcdef12/work", opsWorktree: true })).toBe(false);
		expect(isAttachedRepoInTaskFolder({ ...task, attachedRepo: "/ops/slug/abcdef12/work/wt", opsWorkDir: "/ops/slug/abcdef12/work" })).toBe(false);
	});
});
