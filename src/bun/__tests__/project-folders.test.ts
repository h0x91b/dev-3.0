import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../../shared/types";

const runGit = vi.fn(async (_cmd: string[], cwd: string) =>
	cwd.endsWith("lib") ? { ok: true, stdout: "feature/x\n", stderr: "" } : { ok: false, stdout: "", stderr: "not a repo" },
);
vi.mock("../git", () => ({ run: (...args: unknown[]) => runGit(...(args as [string[], string])) }));
const launchEnv = vi.fn(async (): Promise<Record<string, string>> => ({}));
vi.mock("../repo-config", () => ({
	resolveProjectConfig: async (p: unknown) => p,
	resolveProjectEnv: () => launchEnv(),
}));

import { ENV_UNSET } from "../../shared/agent-accounts";
import {
	claudeConfigDirFor,
	claudeSettingsFiles,
	clearProjectFoldersCache,
	collectProjectFolders,
	resolveProjectFolders,
	stripJsonc,
} from "../project-folders";

const tmp = mkdtempSync(join(tmpdir(), "dev3-project-folders-"));
const projectDir = join(tmp, "project");
const lib = join(tmp, "lib");
const docs = join(tmp, "docs");
const configDir = join(tmp, "claude-config");
const userDir = join(tmp, "user-claude");
// The machine's real ~/.claude must never leak into these lists.
process.env.CLAUDE_CONFIG_DIR = userDir;

function project(over: Partial<Project> = {}): Project {
	return { id: "p", name: "p", path: projectDir, kind: "git", ...over } as Project;
}

beforeAll(() => {
	for (const dir of [join(projectDir, ".claude"), lib, docs, configDir, userDir]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(projectDir, ".claude", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [lib] } }));
	writeFileSync(join(projectDir, ".claude", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["../docs", projectDir] } }));
	writeFileSync(join(configDir, "settings.json"), "{ not json");
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("collectProjectFolders", () => {
	it("merges the dev3 list with Claude's additionalDirectories, deduped, without the project itself", async () => {
		const folders = await collectProjectFolders(project({ extraFolders: [docs, join(tmp, "gone")] }));
		expect(folders.map((f) => [f.path, f.source, f.exists])).toEqual([
			[docs, "dev3", true],
			[join(tmp, "gone"), "dev3", false],
			[lib, "claude", true],
		]);
		expect(folders[0].name).toBe("docs");
	});

	it("drops a folder inside the project and keeps one that contains it", async () => {
		const folders = await collectProjectFolders(project({ extraFolders: [join(projectDir, "src"), "./docs-inside", tmp] }));
		expect(folders.map((f) => f.path)).toEqual([tmp, lib, docs]);
	});

	it("resolves relative paths against the project and ~ against home", async () => {
		const folders = await collectProjectFolders(project({ extraFolders: ["../lib", "~/dev3-nonexistent-folder"] }));
		expect(folders[0].path).toBe(lib);
		expect(folders[1]).toMatchObject({ path: join(homedir(), "dev3-nonexistent-folder"), displayPath: "~/dev3-nonexistent-folder" });
	});

	it("reads the config dir pinned through env.CLAUDE_CONFIG_DIR and skips an unreadable settings file", async () => {
		writeFileSync(join(configDir, "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: [join(tmp, "pinned")] } }));
		const folders = await collectProjectFolders(project({ env: { CLAUDE_CONFIG_DIR: configDir } }));
		expect(folders.map((f) => f.path)).toEqual([lib, docs, join(tmp, "pinned")]);
		expect(claudeSettingsFiles(projectDir, join(projectDir, ".claude"))).toHaveLength(2);
	});

	it("fills the branch only when asked and only for git checkouts", async () => {
		const without = await collectProjectFolders(project());
		expect(without.every((f) => f.branch === undefined)).toBe(true);
		const withBranch = await collectProjectFolders(project(), { withBranch: true });
		expect(withBranch.find((f) => f.path === lib)?.branch).toBe("feature/x");
		expect(withBranch.find((f) => f.path === docs)?.branch).toBeUndefined();
	});

	it("drops network paths before touching the filesystem", async () => {
		const folders = await collectProjectFolders(project({
			extraFolders: ["\\\\attacker.example\\share", "//attacker.example/share"],
			env: { CLAUDE_CONFIG_DIR: "\\\\attacker.example\\cfg" },
		}));
		expect(folders.map((f) => f.path)).toEqual([lib, docs]);
		expect(claudeSettingsFiles(projectDir, "//attacker.example/cfg")).toHaveLength(2);
	});

	it("runs git with bare-repo discovery and fsmonitor turned off", async () => {
		runGit.mockClear();
		await collectProjectFolders(project(), { withBranch: true });
		for (const [cmd] of runGit.mock.calls) {
			expect(cmd.slice(0, 5)).toEqual(["git", "-c", "safe.bareRepository=explicit", "-c", "core.fsmonitor=false"]);
		}
		expect(runGit).toHaveBeenCalled();
	});

	it("reads the user-scope settings when the project pins no config dir", async () => {
		writeFileSync(join(userDir, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [join(tmp, "global")] } }));
		try {
			expect((await collectProjectFolders(project())).map((f) => f.path)).toEqual([lib, docs, join(tmp, "global")]);
			delete process.env.CLAUDE_CONFIG_DIR;
			expect(claudeConfigDirFor({ path: projectDir })).toBe(join(homedir(), ".claude"));
			expect(claudeConfigDirFor({ path: projectDir, env: { CLAUDE_CONFIG_DIR: configDir } })).toBe(configDir);
		} finally {
			process.env.CLAUDE_CONFIG_DIR = userDir;
			rmSync(join(userDir, "settings.json"));
		}
	});

	it("adds the folders of a VS Code workspace file in the project root, JSONC and all", async () => {
		const file = join(projectDir, "team.code-workspace");
		writeFileSync(file, `{
			// the project itself, then its siblings
			"folders": [
				{ "name": "Main", "path": "." },
				{ "path": "../lib" }, /* already a Claude grant */
				{ "path": "../vs-only", },
				{ "uri": "file://attacker.example/share" },
				{ "path": "C:\\\\Users\\\\me\\\\repo" },
			],
			"settings": { "x": "// not a comment" },
		}`);
		try {
			const folders = await collectProjectFolders(project());
			expect(folders.map((f) => [f.path, f.source])).toEqual([
				[lib, "claude"],
				[docs, "claude"],
				[join(tmp, "vs-only"), "vscode"],
			]);
		} finally {
			rmSync(file);
		}
	});

	it("strips JSONC comments and trailing commas without touching strings", () => {
		expect(JSON.parse(stripJsonc('{"a": "//x", /* c */ "b": [1, 2,], // end\n}'))).toEqual({ a: "//x", b: [1, 2] });
	});

	it("returns nothing for a board without a folder", async () => {
		expect(await collectProjectFolders(project({ kind: "virtual", path: "" }))).toEqual([]);
	});
});

describe("resolveProjectFolders", () => {
	// The server was started from a terminal pinned to another project's Claude folder.
	const appSettings = join(userDir, "settings.local.json");
	beforeAll(() => {
		writeFileSync(appSettings, JSON.stringify({ permissions: { additionalDirectories: [join(tmp, "other-project-grant")] } }));
	});
	afterAll(() => {
		rmSync(appSettings);
	});

	async function foldersWithLaunchEnv(env: Record<string, string>): Promise<string[]> {
		launchEnv.mockResolvedValueOnce(env);
		clearProjectFoldersCache();
		return (await resolveProjectFolders(project())).map((f) => f.path);
	}

	it("reads the config dir the project's agent launches with, not the server's own", async () => {
		// The global `{projectPath}/.claude` default resolves to the project's own folder.
		expect(await foldersWithLaunchEnv({ CLAUDE_CONFIG_DIR: join(projectDir, ".claude") })).toEqual([lib, docs]);
	});

	it("reads ~/.claude, not the server's dir, when the launch clears the variable", async () => {
		expect(claudeConfigDirFor({ path: projectDir, env: { CLAUDE_CONFIG_DIR: ENV_UNSET } })).toBe(join(homedir(), ".claude"));
	});

	it("falls back to the server's dir only when the launch sets none", async () => {
		expect(await foldersWithLaunchEnv({})).toEqual([lib, docs, join(tmp, "other-project-grant")]);
	});
});
