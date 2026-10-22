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

		it("adds the exclude entry only once", async () => {
			gitInit();
			write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
			await autoConfigureProject(project());
			rmSync(join(tmp, ".dev3"), { recursive: true });

			await autoConfigureProject(project());

			const exclude = readFileSync(join(tmp, ".git/info/exclude"), "utf-8");
			expect(exclude.split("\n").filter((line) => line === ".dev3/config.local.json")).toHaveLength(1);
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
