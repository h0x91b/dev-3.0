import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qaFixtureProject, qaScopeEnv, qaScopeRoot, seedQaScope } from "../../../scripts/qa-scope";
import { devRunEnv, qaScopeMode } from "../../../scripts/dev";
import { testScopedPath } from "../../../test-scoped-path";

describe("QA scope selection", () => {
	it("stays off unless explicitly asked", () => {
		expect(qaScopeMode([], {})).toBeNull();
		expect(qaScopeMode(["--start"], {})).toBeNull();
		expect(qaScopeMode([], { DEV3_QA_SCOPE: "0" })).toBeNull();
	});

	it("accepts the flag and the env var, in both modes", () => {
		expect(qaScopeMode(["--qa"], {})).toBe("seeded");
		expect(qaScopeMode(["--qa=seeded"], {})).toBe("seeded");
		expect(qaScopeMode(["--qa=virgin"], {})).toBe("virgin");
		expect(qaScopeMode([], { DEV3_QA_SCOPE: "1" })).toBe("seeded");
		expect(qaScopeMode([], { DEV3_QA_SCOPE: "virgin" })).toBe("virgin");
	});

	it("refuses an unknown mode instead of silently picking one", () => {
		expect(() => qaScopeMode(["--qa=readonly"], {})).toThrow(/unknown QA scope mode/);
	});

	it("gives seeded and virgin separate roots, so a fixture cannot leak into a first-run", () => {
		const seeded = qaScopeRoot("/repo/worktree", "seeded", "/tmp");
		const virgin = qaScopeRoot("/repo/worktree", "virgin", "/tmp");
		expect(seeded).not.toBe(virgin);
		expect(qaScopeRoot("/repo/other", "seeded", "/tmp")).not.toBe(seeded);
		// Stable across calls: a restart must reuse the same board.
		expect(qaScopeRoot("/repo/worktree", "seeded", "/tmp")).toBe(seeded);
	});

	it("redirects the data root and logs, and nothing else", () => {
		expect(Object.keys(qaScopeEnv("/tmp/scope")).sort()).toEqual(["DEV3_HOME", "DEV3_LOG_DIR"]);
		// HOME staying real is load-bearing: the agent's dev3 CLI and git read it.
		expect(qaScopeEnv("/tmp/scope")).not.toHaveProperty("HOME");
	});

	it("carries the scope into the app's launch environment for both entry points", () => {
		const scope = { DEV3_HOME: "/tmp/scope/home/.dev3.0", DEV3_LOG_DIR: "/tmp/scope/logs" };
		for (const mode of ["dev", "start"] as const) {
			const env = devRunEnv(mode, { staticCode: null, port0: undefined, qaScope: scope });
			expect(env.DEV3_HOME).toBe(scope.DEV3_HOME);
			expect(env.DEV3_LOG_DIR).toBe(scope.DEV3_LOG_DIR);
		}
	});

	it("leaves DEV3_HOME unset when no scope was requested", () => {
		const env = devRunEnv("dev", { staticCode: null, port0: "1234" });
		expect(env).not.toHaveProperty("DEV3_HOME");
	});
});

describe("QA scope seeding", () => {
	it("virgin mode creates the root and leaves it genuinely empty", () => {
		const root = testScopedPath("qa-virgin");
		const env = seedQaScope(root, "virgin");
		expect(existsSync(env.DEV3_HOME)).toBe(true);
		expect(existsSync(join(env.DEV3_HOME, "projects.json"))).toBe(false);
		expect(existsSync(join(root, "fixture-repo"))).toBe(false);
	});

	it("seeded mode writes one throwaway project and no tasks", () => {
		const root = testScopedPath("qa-seeded");
		const commands: string[][] = [];
		const env = seedQaScope(root, "seeded", "2026-08-21T00:00:00.000Z", (command) => commands.push(command));
		const projects = JSON.parse(readFileSync(join(env.DEV3_HOME, "projects.json"), "utf-8"));
		expect(projects).toHaveLength(1);
		expect(projects[0].path).toBe(join(root, "fixture-repo"));
		// No tasks file at all — nothing to raise a completion dialog about.
		expect(existsSync(join(env.DEV3_HOME, "data"))).toBe(false);
		// The fixture repo is a real git repo, initialised on `main` and committed to,
		// so the project's defaultBaseBranch resolves.
		expect(commands[0]).toEqual(["git", "init", "--initial-branch=main"]);
		expect(commands[commands.length - 1]).toEqual(["git", "commit", "-m", "QA fixture"]);
	});

	it("is idempotent: a second run keeps the board that is already there", () => {
		const root = testScopedPath("qa-idempotent");
		const env = seedQaScope(root, "seeded");
		const projectsFile = join(env.DEV3_HOME, "projects.json");
		const edited = JSON.parse(readFileSync(projectsFile, "utf-8"));
		edited[0].name = "renamed by the user";
		writeFileSync(projectsFile, JSON.stringify(edited));

		seedQaScope(root, "seeded");
		expect(JSON.parse(readFileSync(projectsFile, "utf-8"))[0].name).toBe("renamed by the user");
	});

	it("names a project the app can actually load", () => {
		const project = qaFixtureProject("/tmp/repo", "2026-08-21T00:00:00.000Z");
		expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(project.defaultBaseBranch).toBe("main");
		// No dev script: a QA fixture must not be able to spawn a second app instance.
		expect(project.devScript).toBe("");
	});
});
