import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../../shared/types";

const runGit = vi.fn(async (_cmd: string[], cwd: string) =>
	cwd.endsWith("lib") ? { ok: true, stdout: "feature/x\n", stderr: "" } : { ok: false, stdout: "", stderr: "not a repo" },
);
vi.mock("../git", () => ({ run: (...args: unknown[]) => runGit(...(args as [string[], string])) }));

import { claudeSettingsFiles, collectProjectFolders } from "../project-folders";

const tmp = mkdtempSync(join(tmpdir(), "dev3-project-folders-"));
const projectDir = join(tmp, "project");
const lib = join(tmp, "lib");
const docs = join(tmp, "docs");
const configDir = join(tmp, "claude-config");

function project(over: Partial<Project> = {}): Project {
	return { id: "p", name: "p", path: projectDir, kind: "git", ...over } as Project;
}

beforeAll(() => {
	for (const dir of [join(projectDir, ".claude"), lib, docs, configDir]) mkdirSync(dir, { recursive: true });
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

	it("returns nothing for a board without a folder", async () => {
		expect(await collectProjectFolders(project({ kind: "virtual", path: "" }))).toEqual([]);
	});
});
