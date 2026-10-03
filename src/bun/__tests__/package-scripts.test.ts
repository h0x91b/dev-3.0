import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackageScripts, detectRunner, resolveRunnerCommand } from "../package-scripts";
import { devPlan, devRunEnv, devShell, headlessCommand, headlessRunEnv, linuxHasWebkit, qaScopeMode } from "../../../scripts/dev";

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

		// The wiring moved out of the package script itself: env-var prefixes,
		// `$(...)` and `${VAR:-0}` are POSIX shell syntax PowerShell cannot run, so
		// `dev` now delegates to scripts/dev.ts. The GUARANTEE is unchanged and is
		// asserted against the orchestrator instead of a shell string.
		it("routes dev/start through the shell-free orchestrator", () => {
			expect(rootPkg.scripts.dev).toBe("bun scripts/dev.ts");
			expect(rootPkg.scripts.start).toBe("bun scripts/dev.ts --start");
			expect(rootPkg.scripts.dev).not.toMatch(/[&|;$]/);
		});

		it("pins DEV3_REMOTE_PORT to $DEV3_PORT0 with a 0 fallback", () => {
			expect(devRunEnv("dev", { staticCode: null, port0: "31337" }).DEV3_REMOTE_PORT).toBe("31337");
			expect(devRunEnv("dev", { staticCode: null, port0: undefined }).DEV3_REMOTE_PORT).toBe("0");
		});

		it("still sets the stable dev web-access code", () => {
			expect(devRunEnv("dev", { staticCode: "stable-code", port0: "0" }).DEV3_REMOTE_STATIC_CODE)
				.toBe("stable-code");
			expect(devPlan("dev", "bun").some((s) => s.command.includes("scripts/build-cli.ts"))).toBe(true);
		});
	});

	// Electrobun's Linux window needs a display and WebKitGTK. Without them the dev
	// loop serves the UI headless instead of failing, so `dev3 dev-server start`
	// works on WSL, SSH and container hosts.
	describe("repo dev script (headless fallback)", () => {
		const webkit = () => true;
		const noWebkit = () => false;
		const desktopEnv = { DISPLAY: ":0" };

		it("keeps the desktop window where it can open", () => {
			expect(devShell([], desktopEnv, "linux", webkit).shell).toBe("desktop");
			expect(devShell([], {}, "darwin", noWebkit).shell).toBe("desktop");
			expect(devShell([], {}, "win32", noWebkit).shell).toBe("desktop");
		});

		it("goes headless on Linux without a display or without WebKitGTK", () => {
			expect(devShell([], {}, "linux", webkit)).toEqual({ shell: "headless", reason: "no DISPLAY or WAYLAND_DISPLAY" });
			expect(devShell([], { WAYLAND_DISPLAY: "wayland-0" }, "linux", noWebkit).shell).toBe("headless");
		});

		it("goes headless on request on any platform", () => {
			expect(devShell(["--headless"], {}, "darwin", webkit).shell).toBe("headless");
			expect(devShell([], { ...desktopEnv, DEV3_DEV_HEADLESS: "1" }, "linux", webkit).shell).toBe("headless");
		});

		it("finds WebKitGTK only by its 4.1 soname", () => {
			expect(linuxHasWebkit((path) => path === "/usr/lib64/libwebkit2gtk-4.1.so.0")).toBe(true);
			expect(linuxHasWebkit((path) => path.endsWith("libwebkit2gtk-4.0.so.37"))).toBe(false);
		});

		it("builds the renderer and workers but no desktop bundle", () => {
			const flat = devPlan("dev", "bun", "headless").map((s) => s.command.join(" "));
			expect(flat).toContain("bun node_modules/vite/bin/vite.js build");
			expect(flat.filter((c) => c.includes("--outdir dist/workers"))).toHaveLength(2);
			expect(flat.some((c) => c.includes("electrobun") || c.includes("scripts/build-cli.ts"))).toBe(false);
		});

		// A compiled dist/dev3 reads as an install to the managed-CLI guard and would
		// overwrite the shared ~/.dev3.0/bin/dev3; a bun process is refused that write.
		it("runs the server from source, never the compiled CLI", () => {
			expect(headlessCommand("/opt/bun")).toEqual(["/opt/bun", "src/cli/main.ts", "remote", "--no-detach"]);
		});

		it("overrides the installed server's inherited port and views dir", () => {
			const env = headlessRunEnv("/repo", undefined);
			expect(env).toMatchObject({ DEV3_REMOTE_PORT: "0", DEV3_REMOTE_HOST: "127.0.0.1", DEV3_REMOTE_NO_TUNNEL: "1" });
			expect(env.DEV3_VIEWS_DIR).toBe(join("/repo", "dist"));
			expect(env.DEV3_VIEWS_DIR_AUTO).toBe("");
			expect(headlessRunEnv("/repo", "14279").DEV3_REMOTE_PORT).toBe("14279");
		});

		it("defaults headless to the throwaway board, with DEV3_QA_SCOPE=0 as the way out", () => {
			expect(qaScopeMode([], {}, "seeded")).toBe("seeded");
			expect(qaScopeMode([], { DEV3_QA_SCOPE: "0" }, "seeded")).toBeNull();
			expect(qaScopeMode([], { DEV3_QA_SCOPE: "virgin" }, "seeded")).toBe("virgin");
			expect(qaScopeMode([], {})).toBeNull();
		});
	});
});
