import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the module functions via dynamic import to avoid Bun-specific issues in vitest.
// The functions under test use Bun.file() and Bun.write(), which work in the vitest bun environment.

import {
	loadRepoConfig,
	saveRepoConfig,
	saveRepoLocalConfig,
	ensureGitignore,
	getConfigSources,
	mergeRepoConfig,
	hasRepoConfig,
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
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
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
	it("returns all global when no config files exist", async () => {
		const project = makeProject();
		const sources = await getConfigSources(TEST_DIR, project);

		for (const s of sources) {
			expect(s.source).toBe("global");
		}
	});

	it("returns repo for fields in config.json", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
		}));

		const project = makeProject();
		const sources = await getConfigSources(TEST_DIR, project);

		const setupSource = sources.find((s) => s.field === "setupScript");
		expect(setupSource?.source).toBe("repo");

		const devSource = sources.find((s) => s.field === "devScript");
		expect(devSource?.source).toBe("global");
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

		const project = makeProject();
		const sources = await getConfigSources(TEST_DIR, project);

		const setupSource = sources.find((s) => s.field === "setupScript");
		expect(setupSource?.source).toBe("local");
	});
});

describe("mergeRepoConfig", () => {
	it("returns same project when no config files exist", async () => {
		const project = makeProject();
		const merged = await mergeRepoConfig(project);
		expect(merged.setupScript).toBe("npm install");
		expect(merged.defaultBaseBranch).toBe("main");
	});

	it("overrides project fields with repo config", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "bun install",
			defaultBaseBranch: "develop",
		}));

		const project = makeProject();
		const merged = await mergeRepoConfig(project);
		expect(merged.setupScript).toBe("bun install");
		expect(merged.defaultBaseBranch).toBe("develop");
		// Non-overridden fields stay the same
		expect(merged.cleanupScript).toBe("echo done");
	});

	it("does not mutate the original project", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "changed",
		}));

		const project = makeProject();
		const merged = await mergeRepoConfig(project);
		expect(merged.setupScript).toBe("changed");
		expect(project.setupScript).toBe("npm install"); // original unchanged
	});

	it("applies full priority: global < repo < local", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), JSON.stringify({
			setupScript: "repo-script",
			defaultBaseBranch: "develop",
		}));
		writeFileSync(join(configDir, "config.local.json"), JSON.stringify({
			setupScript: "local-script",
		}));

		const project = makeProject();
		const merged = await mergeRepoConfig(project);
		expect(merged.setupScript).toBe("local-script"); // local wins
		expect(merged.defaultBaseBranch).toBe("develop"); // repo wins over global
		expect(merged.cleanupScript).toBe("echo done"); // global stays
	});
});

describe("hasRepoConfig", () => {
	it("returns false when no config exists", async () => {
		expect(await hasRepoConfig(TEST_DIR)).toBe(false);
	});

	it("returns true when config.json exists", async () => {
		const configDir = join(TEST_DIR, ".dev3");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "config.json"), "{}");
		expect(await hasRepoConfig(TEST_DIR)).toBe(true);
	});
});
