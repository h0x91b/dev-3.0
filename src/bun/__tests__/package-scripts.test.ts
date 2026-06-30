import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackageScripts, detectRunner, resolveRunnerCommand } from "../package-scripts";

describe("package-scripts", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "dev3-pkg-scripts-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	describe("parsePackageScripts", () => {
		it("returns no-worktree error when path is null", () => {
			const r = parsePackageScripts(null);
			expect(r.exists).toBe(false);
			expect(r.error).toBe("no-worktree");
			expect(r.scripts).toEqual([]);
		});

		it("returns no-package-json when missing", () => {
			const r = parsePackageScripts(tmp);
			expect(r.exists).toBe(false);
			expect(r.error).toBe("no-package-json");
		});

		it("parses scripts correctly", () => {
			writeFileSync(
				join(tmp, "package.json"),
				JSON.stringify({ name: "x", scripts: { dev: "vite", test: "vitest", build: "vite build" } }),
			);
			const r = parsePackageScripts(tmp);
			expect(r.exists).toBe(true);
			expect(r.path).toBe("package.json");
			expect(r.scripts).toHaveLength(3);
			expect(r.scripts.find((s) => s.name === "dev")?.command).toBe("vite");
			expect(r.error).toBeNull();
		});

		it("filters non-string script values", () => {
			writeFileSync(
				join(tmp, "package.json"),
				JSON.stringify({ scripts: { ok: "echo ok", bad: 123, alsoBad: null } }),
			);
			const r = parsePackageScripts(tmp);
			expect(r.scripts.map((s) => s.name)).toEqual(["ok"]);
		});

		it("returns no-scripts when scripts field is missing", () => {
			writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
			const r = parsePackageScripts(tmp);
			expect(r.exists).toBe(true);
			expect(r.error).toBe("no-scripts");
			expect(r.scripts).toEqual([]);
		});

		it("returns no-scripts when scripts is empty object", () => {
			writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: {} }));
			const r = parsePackageScripts(tmp);
			expect(r.exists).toBe(true);
			expect(r.error).toBe("no-scripts");
		});

		it("returns parse-failed on invalid JSON", () => {
			writeFileSync(join(tmp, "package.json"), "{not json");
			const r = parsePackageScripts(tmp);
			expect(r.exists).toBe(false);
			expect(r.error).toMatch(/^parse-failed:/);
		});

		it("detects bun runner from bun.lockb", () => {
			writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { dev: "x" } }));
			writeFileSync(join(tmp, "bun.lockb"), "");
			const r = parsePackageScripts(tmp);
			expect(r.runner).toBe("bun");
			expect(r.runnerAutoDetected).toBe(true);
			expect(r.lockfiles).toEqual(["bun.lockb"]);
		});

		it("detects pnpm runner", () => {
			writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { dev: "x" } }));
			writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
			const r = parsePackageScripts(tmp);
			expect(r.runner).toBe("pnpm");
		});

		it("falls back to npm when no lockfile", () => {
			writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { dev: "x" } }));
			const r = parsePackageScripts(tmp);
			expect(r.runner).toBe("npm");
			expect(r.runnerAutoDetected).toBe(false);
		});

		it("flags multipleLockfiles when more than one detected", () => {
			writeFileSync(join(tmp, "package.json"), JSON.stringify({ scripts: { dev: "x" } }));
			writeFileSync(join(tmp, "bun.lockb"), "");
			writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
			const r = parsePackageScripts(tmp);
			expect(r.multipleLockfiles).toBe(true);
			expect(r.lockfiles).toEqual(["bun.lockb", "pnpm-lock.yaml"]);
			// First one wins
			expect(r.runner).toBe("bun");
		});
	});

	describe("detectRunner", () => {
		it("yarn from yarn.lock", () => {
			writeFileSync(join(tmp, "yarn.lock"), "");
			expect(detectRunner(tmp).runner).toBe("yarn");
		});
		it("npm from package-lock.json", () => {
			writeFileSync(join(tmp, "package-lock.json"), "");
			expect(detectRunner(tmp).runner).toBe("npm");
		});
		it("treats non-existent directory like no lockfiles", () => {
			const ghost = join(tmp, "ghost");
			mkdirSync(ghost);
			const r = detectRunner(ghost);
			expect(r.runner).toBe("npm");
			expect(r.autoDetected).toBe(false);
		});
	});

	describe("resolveRunnerCommand", () => {
		it("formats per runner", () => {
			expect(resolveRunnerCommand("bun", "dev")).toBe("bun run dev");
			expect(resolveRunnerCommand("pnpm", "dev")).toBe("pnpm run dev");
			expect(resolveRunnerCommand("yarn", "dev")).toBe("yarn dev");
			expect(resolveRunnerCommand("npm", "dev")).toBe("npm run dev");
		});
		it("allows colon and dot in script names", () => {
			expect(resolveRunnerCommand("bun", "test:full")).toBe("bun run test:full");
			expect(resolveRunnerCommand("bun", "build.prod")).toBe("bun run build.prod");
		});
		it("rejects shell-meta in script names", () => {
			expect(() => resolveRunnerCommand("bun", "dev; rm -rf /")).toThrow(/invalid/);
			expect(() => resolveRunnerCommand("bun", "dev`whoami`")).toThrow(/invalid/);
			expect(() => resolveRunnerCommand("bun", "dev$(echo)")).toThrow(/invalid/);
		});
	});

	// Guards the deterministic-remote-port wiring (decision 093): the repo's own
	// `dev` script must pin the dev app's remote web server to the task's first
	// pool-allocated port ($DEV3_PORT0), falling back to 0 (random) when unset so
	// a bare `bun run dev` still works. Removing this silently reverts the dev
	// QA URL to being unpredictable.
	describe("repo dev script (deterministic remote port)", () => {
		const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
		const rootPkg = JSON.parse(
			readFileSync(resolve(repoRoot, "package.json"), "utf-8"),
		) as { scripts: Record<string, string> };

		it("pins DEV3_REMOTE_PORT to $DEV3_PORT0 with a :-0 fallback", () => {
			expect(rootPkg.scripts.dev).toContain("DEV3_REMOTE_PORT=${DEV3_PORT0:-0}");
		});

		it("still sets the stable dev web-access code", () => {
			expect(rootPkg.scripts.dev).toContain("DEV3_REMOTE_STATIC_CODE=$(bun scripts/dev-web-code.ts)");
		});
	});
});
