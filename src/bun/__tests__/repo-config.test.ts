import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock paths + git so repo-config resolves against tmp dirs and a stubbed git
const MOCK_DEV3_HOME = join(tmpdir(), `dev3-home-test-${process.pid}`);
vi.mock("../paths", () => ({ DEV3_HOME: join(tmpdir(), `dev3-home-test-${process.pid}`) }));
const { detectDefaultCompareRef } = vi.hoisted(() => ({
	detectDefaultCompareRef: vi.fn().mockResolvedValue("origin/main"),
}));

vi.mock("../git", () => ({
	detectDefaultCompareRef,
	projectSlug: (p: string) => p.replace(/^\//, "").replaceAll("/", "-"),
}));

import {
	loadRepoConfig,
	loadRepoConfigRaw,
	loadLocalConfigRaw,
	saveRepoConfig,
	saveRepoLocalConfig,
	ensureGitignore,
	getConfigSources,
	resolveProjectConfig,
	resolveOperationalProjectConfig,
	migrateProjectConfig,
	hasRepoConfig,
	hasLocalConfig,
} from "../repo-config";
import type { Project, Dev3RepoConfig } from "../../shared/types";

const TEST_DIR = join(tmpdir(), `dev3-repo-config-test-${process.pid}`);

function makeProject(overrides: Partial<Project> = {}): Project {
	return {
		id: "test-id",
		name: "test-project",
		path: TEST_DIR,
		setupScript: "npm install",
		devScript: "npm run dev",
		cleanupScript: "echo done",
		defaultBaseBranch: "main",
		clonePaths: ["node_modules"],
		createdAt: "2026-01-01",
		peerReviewEnabled: true,
		...overrides,
	};
}

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	mkdirSync(MOCK_DEV3_HOME, { recursive: true });
	detectDefaultCompareRef.mockResolvedValue("origin/main");
	detectDefaultCompareRef.mockClear();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	rmSync(MOCK_DEV3_HOME, { recursive: true, force: true });
});

describe("loadRepoConfig", () => {
	it("returns empty object when no files exist", async () => {
		const config = await loadRepoConfig(TEST_DIR);
		expect(config).toEqual({});
	});

	it("loads config.json when it exists", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			defaultBaseBranch: "develop",
		}));

		const config = await loadRepoConfig(TEST_DIR);
		expect(config.setupScript).toBe("bun install");
		expect(config.defaultBaseBranch).toBe("develop");
	});

	it("merges config.local.json on top of config.json", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			defaultBaseBranch: "develop",
			cleanupScript: "echo cleanup",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			setupScript: "npm install",
		}));

		const config = await loadRepoConfig(TEST_DIR);
		expect(config.setupScript).toBe("npm install"); // local overrides
		expect(config.defaultBaseBranch).toBe("develop"); // from repo
		expect(config.cleanupScript).toBe("echo cleanup"); // from repo
	});

	it("handles corrupt JSON gracefully", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), "not json at all");

		const config = await loadRepoConfig(TEST_DIR);
		expect(config).toEqual({});
	});

	it("ignores unknown keys in config files", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			unknownKey: "should be ignored",
		}));

		const config = await loadRepoConfig(TEST_DIR);
		expect(config.setupScript).toBe("bun install");
		expect((config as any).unknownKey).toBeUndefined();
	});
});

describe("loadRepoConfigRaw / loadLocalConfigRaw", () => {
	it("returns empty object when files don't exist", () => {
		expect(loadRepoConfigRaw(TEST_DIR)).toEqual({});
		expect(loadLocalConfigRaw(TEST_DIR)).toEqual({});
	});

	it("returns raw file contents", () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ setupScript: "repo" }));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ setupScript: "local" }));

		expect(loadRepoConfigRaw(TEST_DIR)).toEqual({ setupScript: "repo" });
		expect(loadLocalConfigRaw(TEST_DIR)).toEqual({ setupScript: "local" });
	});
});

describe("saveRepoConfig", () => {
	it("creates .dev3 directory and writes config.json", async () => {
		const config: Dev3RepoConfig = {
			setupScript: "bun install",
			defaultBaseBranch: "main",
		};

		await saveRepoConfig(TEST_DIR, config);

		const filePath = join(TEST_DIR, ".dev3", "config.json");
		expect(existsSync(filePath)).toBe(true);
		const written = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(written.setupScript).toBe("bun install");
	});

	it("also ensures .gitignore entry", async () => {
		await saveRepoConfig(TEST_DIR, { setupScript: "test" });

		const gitignore = readFileSync(join(TEST_DIR, ".gitignore"), "utf-8");
		expect(gitignore).toContain(".dev3/config.local.json");
	});
});

describe("saveRepoLocalConfig", () => {
	it("writes config.local.json", async () => {
		await saveRepoLocalConfig(TEST_DIR, { setupScript: "local-script" });

		const filePath = join(TEST_DIR, ".dev3", "config.local.json");
		expect(existsSync(filePath)).toBe(true);
		const written = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(written.setupScript).toBe("local-script");
	});
});

describe("ensureGitignore", () => {
	it("creates .gitignore if it does not exist", async () => {
		await ensureGitignore(TEST_DIR);

		const gitignore = readFileSync(join(TEST_DIR, ".gitignore"), "utf-8");
		expect(gitignore).toContain(".dev3/config.local.json");
	});

	it("appends to existing .gitignore", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "node_modules\n");

		await ensureGitignore(TEST_DIR);

		const gitignore = readFileSync(join(TEST_DIR, ".gitignore"), "utf-8");
		expect(gitignore).toContain("node_modules");
		expect(gitignore).toContain(".dev3/config.local.json");
	});

	it("is idempotent — does not duplicate entry", async () => {
		await ensureGitignore(TEST_DIR);
		await ensureGitignore(TEST_DIR);

		const gitignore = readFileSync(join(TEST_DIR, ".gitignore"), "utf-8");
		const matches = gitignore.match(/\.dev3\/config\.local\.json/g);
		expect(matches?.length).toBe(1);
	});

	it("does not add if entry already exists", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), ".dev3/config.local.json\n");

		await ensureGitignore(TEST_DIR);

		const gitignore = readFileSync(join(TEST_DIR, ".gitignore"), "utf-8");
		const matches = gitignore.match(/\.dev3\/config\.local\.json/g);
		expect(matches?.length).toBe(1);
	});
});

describe("getConfigSources", () => {
	it("returns empty array when no config files exist", async () => {
		const sources = await getConfigSources(TEST_DIR);
		expect(sources).toEqual([]);
	});

	it("returns repo for fields in config.json", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
		}));

		const sources = await getConfigSources(TEST_DIR);

		const setupSource = sources.find((s) => s.field === "setupScript");
		expect(setupSource?.source).toBe("repo");

		// Fields not in any config file should not appear
		const devSource = sources.find((s) => s.field === "devScript");
		expect(devSource).toBeUndefined();
	});

	it("returns local for fields in config.local.json", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			setupScript: "npm install",
		}));

		const sources = await getConfigSources(TEST_DIR);

		const setupSource = sources.find((s) => s.field === "setupScript");
		expect(setupSource?.source).toBe("local");
	});
});

describe("resolveProjectConfig", () => {
	it("falls back to project values then defaults when no config files exist", async () => {
		const project = makeProject();
		const resolved = await resolveProjectConfig(project);
		// Falls back to project.setupScript ("npm install"), not default ("")
		expect(resolved.setupScript).toBe("npm install");
		expect(resolved.defaultBaseBranch).toBe("main");
		expect(resolved.peerReviewEnabled).toBe(true);
		expect(resolved.clonePaths).toEqual(["node_modules"]);
	});

	it("returns defaults for a project with default-like values", async () => {
		const project = makeProject({
			setupScript: "",
			devScript: "",
			cleanupScript: "",
			clonePaths: [],
			defaultBaseBranch: "main",
		});
		const resolved = await resolveProjectConfig(project);
		expect(resolved.setupScript).toBe("");
		expect((resolved as any).setupScriptLaunchMode).toBe("parallel");
		expect(resolved.defaultBaseBranch).toBe("main");
		expect(resolved.defaultCompareRef).toBe("origin/main");
		expect(resolved.autoReviewEnabled).toBe(false);
		expect(resolved.peerReviewEnabled).toBe(true);
		expect(resolved.clonePaths).toEqual([]);
		expect(detectDefaultCompareRef).toHaveBeenCalledWith(TEST_DIR, "main");
	});

	it("respects project-level defaultCompareRef when no file configs set it", async () => {
		const project = makeProject({ defaultCompareRef: "origin/develop" });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.defaultCompareRef).toBe("origin/develop");
		expect(detectDefaultCompareRef).not.toHaveBeenCalled();
	});

	it("uses repo config values over project values", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			defaultBaseBranch: "develop",
		}));

		const project = makeProject();
		const resolved = await resolveProjectConfig(project);
		expect(resolved.setupScript).toBe("bun install");
		expect(resolved.defaultBaseBranch).toBe("develop");
		expect(resolved.defaultCompareRef).toBe("origin/main");
		expect(detectDefaultCompareRef).toHaveBeenCalledWith(TEST_DIR, "develop");
		// Non-configured fields fall back to project values (level 4)
		expect(resolved.cleanupScript).toBe("echo done");
	});

	it("does not mutate the original project", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "changed",
		}));

		const project = makeProject();
		const resolved = await resolveProjectConfig(project);
		expect(resolved.setupScript).toBe("changed");
		expect(project.setupScript).toBe("npm install"); // original unchanged
	});

	it("applies priority: local > repo > project", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-script",
			defaultBaseBranch: "develop",
			defaultCompareRef: "develop",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			setupScript: "local-script",
		}));

		const project = makeProject();
		const resolved = await resolveProjectConfig(project);
		expect(resolved.setupScript).toBe("local-script"); // local wins
		expect(resolved.defaultBaseBranch).toBe("develop"); // repo
		expect(resolved.defaultCompareRef).toBe("develop"); // repo
		expect(resolved.cleanupScript).toBe("echo done"); // from project (level 4)
	});
});

describe("migrateProjectConfig", () => {
	it("creates config.json from project settings when no config exists", async () => {
		const project = makeProject({
			setupScript: "bun install",
			cleanupScript: "rm -rf dist",
			defaultBaseBranch: "develop",
		});

		await migrateProjectConfig(project);

		const filePath = join(TEST_DIR, ".dev3", "config.json");
		expect(existsSync(filePath)).toBe(true);
		const written = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(written.setupScript).toBe("bun install");
		expect(written.cleanupScript).toBe("rm -rf dist");
		expect(written.defaultBaseBranch).toBe("develop");
	});

	it("skips if config.json already exists", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ setupScript: "existing" }));

		const project = makeProject({ setupScript: "should-not-overwrite" });
		await migrateProjectConfig(project);

		const written = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
		expect(written.setupScript).toBe("existing");
	});

	it("skips if config.local.json already exists", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ setupScript: "local" }));

		const project = makeProject({ setupScript: "should-not-migrate" });
		await migrateProjectConfig(project);

		// config.json should NOT be created
		expect(existsSync(join(configDir, "config.json"))).toBe(false);
	});

	it("skips if project has only default settings", async () => {
		const project = makeProject({
			setupScript: "",
			devScript: "",
			cleanupScript: "",
			clonePaths: [],
			defaultBaseBranch: "main",
			peerReviewEnabled: true,
		});

		await migrateProjectConfig(project);

		expect(existsSync(join(TEST_DIR, ".dev3", "config.json"))).toBe(false);
	});

	it("does not recreate a deleted project folder", async () => {
		const missingPath = join(TEST_DIR, "deleted-project");
		const project = makeProject({ path: missingPath, setupScript: "bun install" });

		await migrateProjectConfig(project);

		expect(existsSync(missingPath)).toBe(false);
	});
});

describe("resolveProjectConfig — deleted project folder resilience", () => {
	it("resolves with fallback compare ref when detection fails on an existing path", async () => {
		detectDefaultCompareRef.mockRejectedValue(new Error("spawn failed"));

		const project = makeProject({ defaultCompareRef: undefined });
		const resolved = await resolveProjectConfig(project);

		expect(resolved.defaultCompareRef).toBe("main");
	});

	it("skips compare-ref detection entirely when the project folder is missing", async () => {
		detectDefaultCompareRef.mockRejectedValue(new Error("ENOENT: no such cwd"));

		const project = makeProject({ path: join(TEST_DIR, "gone"), defaultCompareRef: undefined });
		const resolved = await resolveProjectConfig(project);

		expect(detectDefaultCompareRef).not.toHaveBeenCalled();
		expect(resolved.defaultCompareRef).toBe("main");
	});
});

describe("hasRepoConfig", () => {
	it("returns false when no config exists", () => {
		expect(hasRepoConfig(TEST_DIR)).toBe(false);
	});

	it("returns true when config.json exists", () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), "{}");
		expect(hasRepoConfig(TEST_DIR)).toBe(true);
	});
});

describe("hasLocalConfig", () => {
	it("returns false when no local config exists", () => {
		expect(hasLocalConfig(TEST_DIR)).toBe(false);
	});

	it("returns true when config.local.json exists", () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.local.json"), "{}");
		expect(hasLocalConfig(TEST_DIR)).toBe(true);
	});
});

describe("resolveProjectConfig with configPath override (worktree)", () => {
	const WORKTREE_DIR = join(tmpdir(), `dev3-worktree-test-${process.pid}`);

	beforeEach(() => {
		mkdirSync(WORKTREE_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(WORKTREE_DIR, { recursive: true, force: true });
	});

	it("reads config from worktree path instead of project.path", async () => {
		// Main project has no .dev3/
		const project = makeProject();

		// Worktree has .dev3/config.json
		const wtConfigDir = join(WORKTREE_DIR, ".dev3");
		mkdirSync(wtConfigDir, { recursive: true });
		writeFileSync(join(wtConfigDir, "config.json"), JSON.stringify({
			setupScript: "worktree-setup",
			defaultBaseBranch: "feature-branch",
		}));

		const resolved = await resolveProjectConfig(project, WORKTREE_DIR);
		expect(resolved.setupScript).toBe("worktree-setup");
		expect(resolved.defaultBaseBranch).toBe("feature-branch");
	});

	it("falls back to project.path when configPath is undefined", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "project-setup",
		}));

		const project = makeProject();
		const resolved = await resolveProjectConfig(project, undefined);
		expect(resolved.setupScript).toBe("project-setup");
	});

	it("uses worktree config.local.json over worktree config.json", async () => {
		const wtConfigDir = join(WORKTREE_DIR, ".dev3");
		mkdirSync(wtConfigDir, { recursive: true });
		writeFileSync(join(wtConfigDir, "config.json"), JSON.stringify({
			setupScript: "repo-script",
		}));
		writeFileSync(join(wtConfigDir, "config.local.json"), JSON.stringify({
			setupScript: "local-worktree-script",
		}));

		const project = makeProject();
		const resolved = await resolveProjectConfig(project, WORKTREE_DIR);
		expect(resolved.setupScript).toBe("local-worktree-script");
	});

	it("falls back to project values when worktree has no .dev3/ directory", async () => {
		const project = makeProject();
		const resolved = await resolveProjectConfig(project, WORKTREE_DIR);
		// Falls back to project values (level 4) since worktree has no config
		expect(resolved.setupScript).toBe("npm install");
		expect(resolved.defaultBaseBranch).toBe("main");
	});

	it("preserves non-config project fields", async () => {
		const wtConfigDir = join(WORKTREE_DIR, ".dev3");
		mkdirSync(wtConfigDir, { recursive: true });
		writeFileSync(join(wtConfigDir, "config.json"), JSON.stringify({
			setupScript: "wt-script",
		}));

		const project = makeProject({ name: "my-project", id: "proj-42" });
		const resolved = await resolveProjectConfig(project, WORKTREE_DIR);
		expect(resolved.name).toBe("my-project");
		expect(resolved.id).toBe("proj-42");
		expect(resolved.setupScript).toBe("wt-script");
	});
});

describe("migrateProjectConfig with configPath override", () => {
	const WORKTREE_DIR = join(tmpdir(), `dev3-migrate-wt-test-${process.pid}`);

	beforeEach(() => {
		mkdirSync(WORKTREE_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(WORKTREE_DIR, { recursive: true, force: true });
	});

	it("migrates to worktree path when configPath is provided", async () => {
		const project = makeProject({
			setupScript: "bun install",
			defaultBaseBranch: "develop",
		});

		await migrateProjectConfig(project, WORKTREE_DIR);

		const filePath = join(WORKTREE_DIR, ".dev3", "config.json");
		expect(existsSync(filePath)).toBe(true);
		const written = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(written.setupScript).toBe("bun install");

		// Original project.path should NOT have config
		expect(existsSync(join(TEST_DIR, ".dev3", "config.json"))).toBe(false);
	});

	it("skips if worktree already has config", async () => {
		const wtConfigDir = join(WORKTREE_DIR, ".dev3");
		mkdirSync(wtConfigDir, { recursive: true });
		writeFileSync(join(wtConfigDir, "config.json"), JSON.stringify({ setupScript: "existing" }));

		const project = makeProject({ setupScript: "should-not-overwrite" });
		await migrateProjectConfig(project, WORKTREE_DIR);

		const written = JSON.parse(readFileSync(join(wtConfigDir, "config.json"), "utf-8"));
		expect(written.setupScript).toBe("existing");
	});
});

describe("config resolution (local > repo > project > defaults)", () => {
	it("repo config overrides project, project fills the rest", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-script",
		}));

		const project = makeProject({ setupScript: "project-script", devScript: "project-dev" });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.setupScript).toBe("repo-script"); // repo wins over project
		expect(resolved.devScript).toBe("project-dev");    // project fills fields not in repo
	});

	it("local config overrides repo and project", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-script",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			setupScript: "local-script",
		}));

		const project = makeProject();
		const resolved = await resolveProjectConfig(project);
		expect(resolved.setupScript).toBe("local-script"); // local wins
	});

	it("full fallback chain: local > repo > project > default", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-setup",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			defaultBaseBranch: "local-branch",
		}));

		const project = makeProject({ peerReviewEnabled: false, devScript: "project-dev" });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.defaultBaseBranch).toBe("local-branch"); // level 1: local
		expect(resolved.setupScript).toBe("repo-setup");          // level 2: repo
		expect(resolved.devScript).toBe("project-dev");           // level 3: project object
		expect(resolved.sparseCheckoutEnabled).toBe(false);       // level 4: default
	});
});

describe("resolveProjectConfig — empty array fallthrough (#378)", () => {
	it("empty clonePaths in repo config falls through to project values", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		// Phantom clonePaths: [] in .dev3/config.json (created by sanitizeConfigPaths bug)
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			clonePaths: [],
		}));

		const project = makeProject({ clonePaths: ["node_modules", "dist"] });
		const resolved = await resolveProjectConfig(project);
		// Empty array in repo config should NOT shadow project-level clonePaths
		expect(resolved.clonePaths).toEqual(["node_modules", "dist"]);
	});

	it("empty clonePaths in local config falls through to project values", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			clonePaths: [],
		}));

		const project = makeProject({ clonePaths: ["node_modules"] });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.clonePaths).toEqual(["node_modules"]);
	});

	it("non-empty clonePaths in repo config still overrides project values", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			clonePaths: ["vendor"],
		}));

		const project = makeProject({ clonePaths: ["node_modules"] });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.clonePaths).toEqual(["vendor"]);
	});

	it("empty sparseCheckoutPaths in repo config falls through to project values", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			sparseCheckoutPaths: [],
		}));

		const project = makeProject({ sparseCheckoutPaths: ["src/", "tests/"] });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.sparseCheckoutPaths).toEqual(["src/", "tests/"]);
	});

	it("worktree with phantom empty clonePaths falls through to project values", async () => {
		const WORKTREE = join(tmpdir(), `dev3-cow-wt-test-${process.pid}`);
		mkdirSync(WORKTREE, { recursive: true });

		// Worktree has .dev3/config.json with phantom clonePaths: []
		const wtConfigDir = join(WORKTREE, ".dev3");
		mkdirSync(wtConfigDir, { recursive: true });
		writeFileSync(join(wtConfigDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			clonePaths: [],
		}));

		const project = makeProject({ clonePaths: ["node_modules", ".env"] });
		const resolved = await resolveProjectConfig(project, WORKTREE);
		expect(resolved.clonePaths).toEqual(["node_modules", ".env"]);

		rmSync(WORKTREE, { recursive: true, force: true });
	});
});

describe("getConfigSources — provenance", () => {
	it("empty clonePaths in repo config is not reported as source (#378)", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			clonePaths: [],
		}));

		const sources = await getConfigSources(TEST_DIR);
		const cloneSource = sources.find((s) => s.field === "clonePaths");
		// Empty array should not be reported as a source — it's "not configured"
		expect(cloneSource).toBeUndefined();
	});

	it("local overrides repo in source report", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-setup",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			setupScript: "local-setup",
		}));

		const sources = await getConfigSources(TEST_DIR);
		const setupSource = sources.find((s) => s.field === "setupScript");
		expect(setupSource?.source).toBe("local");
	});
});

describe("resolveOperationalProjectConfig — worktree + main cascade", () => {
	const WT_DIR = join(tmpdir(), `dev3-op-wt-${process.pid}`);

	function writeCfg(dir: string, file: "config.json" | "config.local.json", obj: Record<string, unknown>): void {
		const d = join(dir, ".dev3");
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, file), JSON.stringify(obj));
	}

	beforeEach(() => { mkdirSync(WT_DIR, { recursive: true }); });
	afterEach(() => { rmSync(WT_DIR, { recursive: true, force: true }); });

	it("no worktree path → single-path project resolution", async () => {
		writeCfg(TEST_DIR, "config.json", { setupScript: "main-setup" });
		const resolved = await resolveOperationalProjectConfig(makeProject());
		expect(resolved.setupScript).toBe("main-setup");
	});

	it("worktreePath === project.path → single-path resolution", async () => {
		writeCfg(TEST_DIR, "config.json", { setupScript: "main-setup" });
		const resolved = await resolveOperationalProjectConfig(makeProject(), TEST_DIR);
		expect(resolved.setupScript).toBe("main-setup");
	});

	// Scenario 1: main has NO .dev3 config; worktree has config.json + config.local.json.
	it("main has no config: worktree provides scripts AND non-scripts; local beats repo", async () => {
		writeCfg(WT_DIR, "config.json", { setupScript: "wt-setup", devScript: "wt-dev-repo", portCount: 3 });
		writeCfg(WT_DIR, "config.local.json", { devScript: "wt-dev-local" });

		// Project object keeps its own scripts (makeProject defaults) — worktree must win.
		const project = makeProject({ cleanupScript: "proj-cleanup" });
		const resolved = await resolveOperationalProjectConfig(project, WT_DIR);

		expect(resolved.setupScript).toBe("wt-setup");        // worktree repo beats project object
		expect(resolved.devScript).toBe("wt-dev-local");      // worktree local beats worktree repo
		expect(resolved.portCount).toBe(3);                   // non-script field from worktree
		expect(resolved.cleanupScript).toBe("proj-cleanup");  // unset in worktree/main → project object
	});

	// Scenario 2a: worktree outranks main for EVERY field, scripts included (the inversion).
	it("worktree config wins over main config for all fields incl scripts", async () => {
		writeCfg(TEST_DIR, "config.json", { setupScript: "main-setup", devScript: "main-dev", portCount: 9 });
		writeCfg(WT_DIR, "config.json", { setupScript: "wt-setup", devScript: "wt-dev", portCount: 2 });

		const resolved = await resolveOperationalProjectConfig(makeProject(), WT_DIR);
		expect(resolved.setupScript).toBe("wt-setup");
		expect(resolved.devScript).toBe("wt-dev");
		expect(resolved.portCount).toBe(2);
	});

	// Scenario 2b: main config.local.json (level 3) fills a field the worktree omits,
	// and beats main config.json (level 4).
	it("main config.local.json fills fields the worktree does not set", async () => {
		writeCfg(WT_DIR, "config.json", { setupScript: "wt-setup" });
		writeCfg(TEST_DIR, "config.local.json", { devScript: "main-local-dev" });
		writeCfg(TEST_DIR, "config.json", { devScript: "main-repo-dev" });

		const resolved = await resolveOperationalProjectConfig(makeProject({ devScript: "" }), WT_DIR);
		expect(resolved.setupScript).toBe("wt-setup");      // level 2
		expect(resolved.devScript).toBe("main-local-dev");  // level 3 beats level 4
	});

	// Scenario 2c: main config.json (level 4) is a fallback for NON-script fields too —
	// the behavior the old resolver lacked (it ignored main for non-scripts).
	it("main config.json portCount reaches a worktree with no config of its own", async () => {
		writeCfg(TEST_DIR, "config.json", { portCount: 7 });
		// WT_DIR has no .dev3
		const resolved = await resolveOperationalProjectConfig(makeProject(), WT_DIR);
		expect(resolved.portCount).toBe(7);
	});

	it("honours full precedence wt-local > wt-repo > main-local > main-repo > project", async () => {
		writeCfg(WT_DIR, "config.local.json", { setupScript: "L1-wt-local" });
		writeCfg(WT_DIR, "config.json", { setupScript: "L2-wt-repo" });
		writeCfg(TEST_DIR, "config.local.json", { setupScript: "L3-main-local" });
		writeCfg(TEST_DIR, "config.json", { setupScript: "L4-main-repo" });
		const project = makeProject({ setupScript: "L5-project" });

		const resolved = await resolveOperationalProjectConfig(project, WT_DIR);
		expect(resolved.setupScript).toBe("L1-wt-local");
	});

	it("main-repo (level 4) beats the project object (level 5) when higher levels are absent", async () => {
		writeCfg(TEST_DIR, "config.json", { setupScript: "L4-main-repo" });
		const project = makeProject({ setupScript: "L5-project" });
		const resolved = await resolveOperationalProjectConfig(project, WT_DIR);
		expect(resolved.setupScript).toBe("L4-main-repo");
	});

	// Empty arrays are "not configured" across the combined cascade too (#378).
	it("phantom empty clonePaths in worktree falls through to main config.json", async () => {
		writeCfg(WT_DIR, "config.json", { clonePaths: [] });
		writeCfg(TEST_DIR, "config.json", { clonePaths: ["main-cache"] });
		const project = makeProject({ clonePaths: ["proj-cache"] });
		const resolved = await resolveOperationalProjectConfig(project, WT_DIR);
		expect(resolved.clonePaths).toEqual(["main-cache"]);
	});

	it("auto-detects defaultCompareRef using the worktree path", async () => {
		writeCfg(WT_DIR, "config.json", { setupScript: "wt-setup" });
		const resolved = await resolveOperationalProjectConfig(makeProject({ defaultCompareRef: undefined }), WT_DIR);
		expect(resolved.defaultCompareRef).toBe("origin/main");
		expect(detectDefaultCompareRef).toHaveBeenCalledWith(WT_DIR, "main");
	});
});
