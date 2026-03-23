import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock DEV3_HOME and projectSlug for app-level config tests
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
	migrateProjectConfig,
	hasRepoConfig,
	hasLocalConfig,
	loadAppConfig,
	saveAppConfig,
	hasAppConfig,
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

describe("app-level config (loadAppConfig / saveAppConfig / hasAppConfig)", () => {
	it("returns empty object when no app config exists", () => {
		const config = loadAppConfig(TEST_DIR);
		expect(config).toEqual({});
	});

	it("saves and loads app config", async () => {
		await saveAppConfig(TEST_DIR, { setupScript: "app-setup", devScript: "app-dev" });
		const config = loadAppConfig(TEST_DIR);
		expect(config.setupScript).toBe("app-setup");
		expect(config.devScript).toBe("app-dev");
	});

	it("hasAppConfig returns false when no config exists", () => {
		expect(hasAppConfig(TEST_DIR)).toBe(false);
	});

	it("hasAppConfig returns true after saving", async () => {
		await saveAppConfig(TEST_DIR, { setupScript: "test" });
		expect(hasAppConfig(TEST_DIR)).toBe(true);
	});
});

describe("4-level resolution (local > repo > app > project > defaults)", () => {
	it("app config overrides project values", async () => {
		await saveAppConfig(TEST_DIR, { setupScript: "app-script" });

		const project = makeProject({ setupScript: "project-script" });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.setupScript).toBe("app-script");
	});

	it("repo config overrides app config", async () => {
		await saveAppConfig(TEST_DIR, { setupScript: "app-script", devScript: "app-dev" });

		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-script",
		}));

		const project = makeProject();
		const resolved = await resolveProjectConfig(project);
		expect(resolved.setupScript).toBe("repo-script"); // repo wins over app
		expect(resolved.devScript).toBe("app-dev"); // app wins for fields not in repo
	});

	it("local config overrides everything", async () => {
		await saveAppConfig(TEST_DIR, { setupScript: "app-script" });

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

	it("full fallback chain: local > repo > app > project > default", async () => {
		await saveAppConfig(TEST_DIR, { devScript: "app-dev", cleanupScript: "app-cleanup" });

		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-setup",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			defaultBaseBranch: "local-branch",
		}));

		const project = makeProject({ peerReviewEnabled: false });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.defaultBaseBranch).toBe("local-branch"); // level 1: local
		expect(resolved.setupScript).toBe("repo-setup");          // level 2: repo
		expect(resolved.devScript).toBe("app-dev");                // level 3: app
		expect(resolved.peerReviewEnabled).toBe(false);            // level 4: project
		expect(resolved.sparseCheckoutEnabled).toBe(false);        // level 5: default
	});

	it("app config is read from project.path, not worktree path", async () => {
		// Set app config keyed by project.path
		await saveAppConfig(TEST_DIR, { setupScript: "app-from-project-path" });

		const WORKTREE = join(tmpdir(), `dev3-wt-app-test-${process.pid}`);
		mkdirSync(WORKTREE, { recursive: true });

		const project = makeProject();
		const resolved = await resolveProjectConfig(project, WORKTREE);
		expect(resolved.setupScript).toBe("app-from-project-path");

		rmSync(WORKTREE, { recursive: true, force: true });
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

	it("empty clonePaths in app config falls through to project values", async () => {
		await saveAppConfig(TEST_DIR, { clonePaths: [] });

		const project = makeProject({ clonePaths: [".venv"] });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.clonePaths).toEqual([".venv"]);
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

describe("getConfigSources with app-level", () => {
	it("reports app source for fields only in app config", async () => {
		await saveAppConfig(TEST_DIR, { devScript: "app-dev" });

		const sources = await getConfigSources(TEST_DIR, TEST_DIR);
		const devSource = sources.find((s) => s.field === "devScript");
		expect(devSource?.source).toBe("app");
	});

	it("repo overrides app in source report", async () => {
		await saveAppConfig(TEST_DIR, { setupScript: "app-setup" });

		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-setup",
		}));

		const sources = await getConfigSources(TEST_DIR, TEST_DIR);
		const setupSource = sources.find((s) => s.field === "setupScript");
		expect(setupSource?.source).toBe("repo");
	});
});
