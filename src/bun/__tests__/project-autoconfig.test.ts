import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../paths", () => ({ DEV3_HOME: "/tmp/dev3-test" }));

const onPath = new Set(["uv", "cargo"]);
vi.mock("../which", () => ({
	whichSync: (command: string) => (onPath.has(command) ? `/usr/bin/${command}` : null),
}));

vi.mock("../spawn", async () => {
	const { createSpawnMock } = await import("./git-test-helpers");
	return createSpawnMock();
});

import type { Project } from "../../shared/types";
import { autoConfigureProject, detectProjectConfig } from "../project-autoconfig";
import { g } from "./git-test-helpers";

describe("project-autoconfig", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "dev3-autoconfig-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const write = (name: string, content = "") => writeFileSync(join(tmp, name), content);
	const project = (overrides: Partial<Project> = {}) => ({ id: "p1", name: "p", path: tmp, ...overrides }) as Project;
	const gitInit = () => g("git init -q", tmp);
	const gitCommitAll = () => g("git add -A && git commit -qm init", tmp);
	const gitStatus = () => g("git status --porcelain", tmp).trim();
	const localConfig = () => JSON.parse(readFileSync(join(tmp, ".dev3/config.local.json"), "utf-8"));

	describe("detectProjectConfig", () => {
		it("derives install and dev commands from the lockfile runner", () => {
			write("package.json", JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
			write("pnpm-lock.yaml");
			expect(detectProjectConfig(tmp)).toEqual({
				setupScript: "pnpm install",
				devScript: "pnpm run dev",
			});
		});

		it("falls back to start when there is no dev script", () => {
			write("package.json", JSON.stringify({ scripts: { start: "node server.js" } }));
			expect(detectProjectConfig(tmp)).toEqual({
				setupScript: "npm install",
				devScript: "npm run start",
			});
		});

		it("chains installs for every ecosystem it finds", () => {
			write("package.json", JSON.stringify({}));
			write("bun.lock");
			write("uv.lock");
			write("Cargo.lock");
			expect(detectProjectConfig(tmp)).toEqual({
				setupScript: "bun install && uv sync && cargo fetch",
			});
		});

		it("leaves out an ecosystem whose toolchain is not on PATH", () => {
			write("package.json", JSON.stringify({}));
			write("bun.lock");
			write("uv.lock");
			write("Gemfile.lock");
			expect(detectProjectConfig(tmp)).toEqual({
				setupScript: "bun install && uv sync",
			});
		});

		it("finds nothing in an empty folder", () => {
			expect(detectProjectConfig(tmp)).toEqual({});
		});
	});

	describe("autoConfigureProject", () => {
		it("writes config.local.json and ignores it without touching git status", async () => {
			gitInit();
			write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
			write("bun.lock");
			gitCommitAll();

			const result = await autoConfigureProject(project());

			expect(result).toEqual({ written: ["setupScript", "devScript"] });
			expect(localConfig()).toEqual({ setupScript: "bun install", devScript: "bun run dev" });
			expect(existsSync(join(tmp, ".gitignore"))).toBe(false);
			expect(readFileSync(join(tmp, ".git/info/exclude"), "utf-8")).toContain(".dev3/config.local.json");
			expect(existsSync(join(tmp, ".dev3/config.json"))).toBe(false);
			expect(gitStatus()).toBe("");
		});

		it("configures a plain folder added with the git workflow off, without a git exclude", async () => {
			write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
			write("bun.lock");

			const result = await autoConfigureProject(project({ gitWorkflow: false }));

			expect(result).toEqual({ written: ["devScript"] });
			expect(localConfig()).toEqual({ devScript: "bun run dev" });
			expect(existsSync(join(tmp, ".git"))).toBe(false);
		});

		// Its tasks run in the project folder and skip the setup script, so writing one would be noise.
		it("writes no setup script for a repository added with the git workflow off", async () => {
			gitInit();
			write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
			write("bun.lock");

			const result = await autoConfigureProject(project({ gitWorkflow: false }));

			expect(result).toEqual({ written: ["devScript"] });
			expect(localConfig()).toEqual({ devScript: "bun run dev" });
		});

		it("adds the exclude entry only once", async () => {
			gitInit();
			write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
			await autoConfigureProject(project());
			rmSync(join(tmp, ".dev3"), { recursive: true });

			await autoConfigureProject(project());

			const exclude = readFileSync(join(tmp, ".git/info/exclude"), "utf-8");
			expect(exclude.split("\n").filter((line) => line === ".dev3/config.local.json")).toHaveLength(1);
		});

		it("keeps existing exclude rules and appends after a missing final newline", async () => {
			gitInit();
			write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
			writeFileSync(join(tmp, ".git/info/exclude"), "# mine\n*.log");

			await autoConfigureProject(project());

			expect(readFileSync(join(tmp, ".git/info/exclude"), "utf-8")).toBe("# mine\n*.log\n.dev3/config.local.json\n");
		});

		it.each([
			["a plain subfolder", "web"],
			["a deep subfolder", "apps/web"],
			["glob, escape and comment characters", "#a/!b/c [x]*?\\d"],
			["spaces and non-ASCII", " lead/wéb app"],
		])("ignores the local config of a project in %s of the repository", async (_label, subdir) => {
			gitInit();
			write(".gitignore", "node_modules\n");
			mkdirSync(join(tmp, subdir), { recursive: true });
			writeFileSync(join(tmp, subdir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
			writeFileSync(join(tmp, "sibling.json"), "{}");
			gitCommitAll();
			const nested = project({ path: join(tmp, subdir) });

			expect(await autoConfigureProject(nested)).toEqual({ written: ["setupScript", "devScript"] });
			await autoConfigureProject(nested);

			const configPath = `${subdir}/.dev3/config.local.json`;
			expect(g(`git check-ignore --no-index -q -- '${configPath.replaceAll("'", "'\\''")}' && echo ignored`, tmp).trim()).toBe("ignored");
			expect(gitStatus()).toBe("");
			expect(readFileSync(join(tmp, ".gitignore"), "utf-8")).toBe("node_modules\n");
			const rules = readFileSync(join(tmp, ".git/info/exclude"), "utf-8").split("\n").filter((line) => line.endsWith("config.local.json"));
			expect(rules).toHaveLength(1);
			// The rule is anchored to the subfolder, so the same file elsewhere stays visible.
			mkdirSync(join(tmp, ".dev3"));
			write(".dev3/config.local.json", "{}");
			expect(gitStatus()).toBe("?? .dev3/");
		});

		it("ignores the local config of a project inside a linked worktree", async () => {
			gitInit();
			mkdirSync(join(tmp, "web"));
			write("web/package.json", JSON.stringify({ scripts: { dev: "vite" } }));
			gitCommitAll();
			const linked = join(tmp, "linked");
			g(`git worktree add -q ${linked} -b side`, tmp);

			await autoConfigureProject(project({ path: join(linked, "web") }));

			expect(existsSync(join(linked, "web/.dev3/config.local.json"))).toBe(true);
			expect(g("git status --porcelain", linked).trim()).toBe("");
			expect(readFileSync(join(tmp, ".git/info/exclude"), "utf-8")).toContain("\nweb/.dev3/config.local.json\n");
		});

		it("never touches a project that already has a .dev3 config", async () => {
			write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
			mkdirSync(join(tmp, ".dev3"));
			write(".dev3/config.json", JSON.stringify({ devScript: "make dev" }));

			const result = await autoConfigureProject(project());

			expect(result).toEqual({ written: [], existingConfig: true });
			expect(existsSync(join(tmp, ".dev3/config.local.json"))).toBe(false);
		});

		it.each([
			["repo config is off", { useRepoConfig: false }],
			["the record already has a setup script", { setupScript: "make setup" }],
			["the record already has a dev script", { devScript: "make dev" }],
		] as const)("leaves a re-added project alone when %s", async (_label, overrides) => {
			gitInit();
			write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));

			const result = await autoConfigureProject(project(overrides));

			expect(result).toEqual({ written: [], existingConfig: true });
			expect(existsSync(join(tmp, ".dev3"))).toBe(false);
		});

		it("creates no .dev3 folder when nothing is detected", async () => {
			const result = await autoConfigureProject(project());

			expect(result).toEqual({ written: [] });
			expect(existsSync(join(tmp, ".dev3"))).toBe(false);
		});
	});
});
