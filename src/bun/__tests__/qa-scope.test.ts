import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qaFixtureProject, qaScopeEnv, qaScopeResetHint, qaScopeRoot, qaTmuxSocketDir, seedQaScope, stopQaScopeTmux } from "../../../scripts/qa-scope";
import { DEFAULT_TMUX_SOCKET } from "../tmux/constants";
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

	it("redirects the data root, logs and tmux server, and nothing else", () => {
		expect(Object.keys(qaScopeEnv("/tmp/scope")).sort()).toEqual(["DEV3_HOME", "DEV3_LOG_DIR", "TMUX_TMPDIR"]);
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

	it("gives the instance its own tmux server, so its panes never join the real app's", () => {
		const scope = qaScopeEnv("/tmp/scope");
		expect(scope.TMUX_TMPDIR).toBe("/tmp/scope/t");
		const env = devRunEnv("dev", { staticCode: null, port0: undefined, qaScope: scope });
		expect(env.TMUX_TMPDIR).toBe("/tmp/scope/t");
	});

	it("keeps the scoped tmux socket path under the macOS limit", () => {
		// A typical macOS os.tmpdir(), a five-digit uid and the app's own socket name.
		const root = qaScopeRoot("/repo/worktree", "seeded", "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T");
		const env = qaScopeEnv(root);
		expect(`${qaTmuxSocketDir(env, 99999)}/${DEFAULT_TMUX_SOCKET}`.length).toBeLessThan(104);
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
		// tmux creates only its own `tmux-<uid>` dir and needs TMUX_TMPDIR to exist.
		expect(existsSync(env.TMUX_TMPDIR)).toBe(true);
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

describe("QA scope tmux lifecycle", () => {
	it("kills every server in the scoped socket dir, and only there", () => {
		const env = seedQaScope(testScopedPath("qa-tmux-stop"), "virgin");
		const dir = qaTmuxSocketDir(env);
		mkdirSync(dir, { recursive: true });
		for (const name of ["dev3", "dev3-live-test-1"]) writeFileSync(join(dir, name), "");
		const calls: string[][] = [];
		expect(stopQaScopeTmux(env, (command) => calls.push(command), "darwin").sort()).toEqual(["dev3", "dev3-live-test-1"]);
		expect(calls.map((command) => command.slice(1)).sort()).toEqual([
			["-S", join(dir, "dev3"), "kill-server"],
			["-S", join(dir, "dev3-live-test-1"), "kill-server"],
		]);
	});

	it("uses the scoped app's tmux shim when it wrote one, so client and server versions match", () => {
		const env = seedQaScope(testScopedPath("qa-tmux-shim"), "virgin");
		mkdirSync(qaTmuxSocketDir(env), { recursive: true });
		writeFileSync(join(qaTmuxSocketDir(env), "dev3"), "");
		const calls: string[][] = [];
		stopQaScopeTmux(env, (command) => calls.push(command), "darwin");
		expect(calls[0][0]).toBe("tmux");
		mkdirSync(join(env.DEV3_HOME, "bin"), { recursive: true });
		writeFileSync(join(env.DEV3_HOME, "bin", "tmux"), "");
		calls.length = 0;
		stopQaScopeTmux(env, (command) => calls.push(command), "darwin");
		expect(calls[0][0]).toBe(join(env.DEV3_HOME, "bin", "tmux"));
	});

	it("does nothing when no server ever started, or on Windows", () => {
		const env = seedQaScope(testScopedPath("qa-tmux-none"), "virgin");
		const calls: string[][] = [];
		expect(stopQaScopeTmux(env, (command) => calls.push(command), "darwin")).toEqual([]);
		expect(stopQaScopeTmux(env, (command) => calls.push(command), "win32")).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("puts kill-server before rm -rf in the reset hint", () => {
		const env = qaScopeEnv("/tmp/scope");
		const hint = qaScopeResetHint("/tmp/scope", env);
		expect(hint).toMatch(/-S \/tmp\/scope\/t\/tmux-\d+\/dev3 kill-server; rm -rf \/tmp\/scope$/);
	});
});
