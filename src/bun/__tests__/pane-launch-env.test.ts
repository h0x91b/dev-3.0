import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetLaunchTaskWiringForTests,
	isTaskWiringKey,
	resetEnvFromDev3Pane,
	startedInsideDev3Pane,
	withoutLaunchTaskWiring,
} from "../pane-launch-env";
import { TmuxClient } from "../tmux/client";
import { buildTaskEnv } from "../agents";
import { buildNamedPortEnv, buildPortEnv } from "../port-pool";
import { buildAgentEnv, buildProjectTerminalEnv, buildTaskLifecycleEnv, TASK_SCOPED_ENV_KEYS } from "../rpc-handlers/shared-pure";
import { INHERITED_TASK_ENV_KEYS } from "../launch-origin";
import type { Project, Task } from "../../shared/types";

type Env = Record<string, string | undefined>;

/** A trimmed copy of what a dev3 agent pane on macOS really carries. */
function agentPaneEnv(): Env {
	return {
		HOME: "/Users/me",
		USER: "me",
		SHELL: "/bin/zsh",
		PATH: "/Users/me/.dev3.0/bin:/usr/bin:/bin",
		TMPDIR: "/var/folders/x/T/",
		LANG: "en_US.UTF-8",
		SSH_AUTH_SOCK: "/private/tmp/launchd/Listeners",
		__CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
		TERM: "tmux-256color",
		TMUX: "/private/tmp/tmux-501/dev3,86328,0",
		TMUX_PANE: "%0",
		ZDOTDIR: "/Users/me/.dev3.0/shell/zsh",
		CLAUDE_CONFIG_DIR: "/projects/a/.claude",
		CLAUDECODE: "1",
		CLAUDE_CODE_SESSION_ID: "session-a",
		CLAUDE_CODE_MESSAGING_TOKEN: "secret",
		ANTHROPIC_MODEL: "model-a",
		CODEX_HOME: "/Users/me/.dev3.0/agent-accounts/codex/a",
		AWS_PROFILE: "project-a",
		DEV3_HOME: "/Users/me/.dev3.0",
		DEV3_QA_SCOPE: "0",
		DEV3_TASK_ID: "task-a",
		DEV3_TASK_SEQ: "78-1",
		DEV3_WORKTREE_ROOT: "/projects/a",
		DEV3_PROJECT_PATH: "/projects/a",
		DEV3_BRANCH_NAME: "fix/a",
		DEV3_PORT0: "17747",
		DEV3_PORTS: "17747,17748",
	};
}

afterEach(() => {
	_resetLaunchTaskWiringForTests();
});

describe("startedInsideDev3Pane", () => {
	it("recognises a task pane, a Repo terminal and a pane with only TMUX on the dev3 socket", () => {
		expect(startedInsideDev3Pane({ DEV3_TASK_ID: "task-a" })).toBe(true);
		expect(startedInsideDev3Pane({ DEV3_PROJECT_PATH: "/projects/a" })).toBe(true);
		expect(startedInsideDev3Pane({ TMUX: "/private/tmp/tmux-501/dev3,1,0" })).toBe(true);
	});

	it("ignores the user's own tmux, a blank task id and a plain terminal", () => {
		expect(startedInsideDev3Pane({ TMUX: "/private/tmp/tmux-501/default,1,0" })).toBe(false);
		expect(startedInsideDev3Pane({ DEV3_TASK_ID: " " })).toBe(false);
		expect(startedInsideDev3Pane({ HOME: "/Users/me", CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" })).toBe(false);
	});
});

describe("resetEnvFromDev3Pane", () => {
	it("keeps only the OS base and dev3's own keys when started inside a pane", () => {
		const env = agentPaneEnv();

		const removed = resetEnvFromDev3Pane(env, "darwin");

		expect(Object.keys(env).sort()).toEqual([
			"DEV3_BRANCH_NAME", "DEV3_HOME", "DEV3_PORT0", "DEV3_PORTS", "DEV3_PROJECT_PATH", "DEV3_QA_SCOPE",
			"DEV3_TASK_ID", "DEV3_TASK_SEQ", "DEV3_WORKTREE_ROOT",
			"HOME", "LANG", "PATH", "SHELL", "SSH_AUTH_SOCK", "TMPDIR", "USER", "__CF_USER_TEXT_ENCODING",
		]);
		expect(removed).toEqual(expect.arrayContaining([
			"CLAUDE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN",
			"ANTHROPIC_MODEL", "CODEX_HOME", "AWS_PROFILE", "TMUX", "TMUX_PANE", "TERM", "ZDOTDIR",
		]));
	});

	it("leaves the env of an app started outside dev3 untouched", () => {
		const env: Env = { HOME: "/Users/me", CLAUDE_CONFIG_DIR: "/Users/me/.claude-work", AWS_PROFILE: "mine" };

		expect(resetEnvFromDev3Pane(env, "darwin")).toEqual([]);
		expect(env).toEqual({ HOME: "/Users/me", CLAUDE_CONFIG_DIR: "/Users/me/.claude-work", AWS_PROFILE: "mine" });
		expect(withoutLaunchTaskWiring({ DEV3_PORT0: "1" })).toEqual({ DEV3_PORT0: "1" });
	});

	it("does nothing on Windows, which has no dev3 tmux panes", () => {
		const env = agentPaneEnv();

		expect(resetEnvFromDev3Pane(env, "win32")).toEqual([]);
		expect(env).toEqual(agentPaneEnv());
	});
});

describe("withoutLaunchTaskWiring", () => {
	it("drops the launching task's keys but keeps dev3's launch settings and later values", () => {
		resetEnvFromDev3Pane(agentPaneEnv(), "darwin");

		expect(withoutLaunchTaskWiring({ HOME: "/Users/me", DEV3_HOME: "/Users/me/.dev3.0", DEV3_QA_SCOPE: "0", DEV3_TASK_ID: "task-a", DEV3_PORT0: "17747", DEV3_PROJECT_PATH: "/projects/a", DEV3_WORKTREE_ROOT: "/projects/a", DEV3_BRANCH_NAME: "fix/a", DEV3_PORTS: "17747,17748", DEV3_TASK_SEQ: "78-1" }))
			.toEqual({ HOME: "/Users/me", DEV3_HOME: "/Users/me/.dev3.0", DEV3_QA_SCOPE: "0", DEV3_TASK_ID: undefined, DEV3_PORT0: undefined, DEV3_PROJECT_PATH: undefined, DEV3_WORKTREE_ROOT: undefined, DEV3_BRANCH_NAME: undefined, DEV3_PORTS: undefined, DEV3_TASK_SEQ: undefined });
	});

	it("drops the artifact template mode, so an off project does not switch every other project off", () => {
		resetEnvFromDev3Pane({ ...agentPaneEnv(), DEV3_ARTIFACT_TEMPLATE: "off", DEV3_ARTIFACT_TEMPLATE_DIR: "/projects/a/.dev3/artifact" }, "darwin");

		const env = withoutLaunchTaskWiring({ DEV3_ARTIFACT_TEMPLATE: "off", DEV3_ARTIFACT_TEMPLATE_DIR: "/projects/a/.dev3/artifact" });

		expect(env).toEqual({ DEV3_ARTIFACT_TEMPLATE: undefined, DEV3_ARTIFACT_TEMPLATE_DIR: undefined });
	});

	it("keeps a wiring key a caller set to a new value after the launch", () => {
		resetEnvFromDev3Pane(agentPaneEnv(), "darwin");

		expect(withoutLaunchTaskWiring({ DEV3_TASK_ID: "task-b", DEV3_PORT0: "18000", DEV3_TASK_SEQ: "78-1" }))
			.toEqual({ DEV3_TASK_ID: "task-b", DEV3_PORT0: "18000", DEV3_TASK_SEQ: undefined });
	});

		/** Runs `body` with the launching task's keys in process.env, as in an app started from a pane. */
	async function withTaskEnv(body: () => Promise<void>): Promise<void> {
		const keys = { DEV3_TASK_ID: "task-a", DEV3_PORT0: "17747", DEV3_WORKTREE_ROOT: "/projects/a" };
		const before = Object.fromEntries(Object.keys(keys).map((key) => [key, process.env[key]]));
		Object.assign(process.env, keys);
		try {
			await body();
		} finally {
			for (const [key, value] of Object.entries(before)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	function expectNoTaskWiring(env: Env): void {
		// Undefined, so the spawn wrapper's process.env merge unsets the key instead of keeping it.
		for (const key of ["DEV3_TASK_ID", "DEV3_PORT0", "DEV3_WORKTREE_ROOT"]) {
			expect(key in env).toBe(true);
			expect(env[key]).toBeUndefined();
		}
	}

	function fakeClient() {
		const seen: Env[] = [];
		const ensureServer = vi.fn((opts: { env: Env }) => { seen.push({ ...opts.env }); });
		const spawn = vi.fn().mockReturnValue({ pid: 1, kill: vi.fn(), stdout: "", stderr: "", exited: Promise.resolve(0) });
		const client = new TmuxClient({ cwdExists: () => true, spawn: spawn as never, ensureServer: ensureServer as never });
		return { client, seen, spawnEnv: (call = 0) => (spawn.mock.calls[call][1] as { env: Env }).env };
	}

	it("reaches the launchd server and the tmux command of a detached session", async () => {
		resetEnvFromDev3Pane(agentPaneEnv(), "darwin");
		const { client, seen, spawnEnv } = fakeClient();

		await withTaskEnv(async () => { await client.newSessionDetached({ sessionName: "s", cwd: "/tmp", socket: "probe" }); });

		expectNoTaskWiring(seen[0]);
		expectNoTaskWiring(spawnEnv());
	});

	it("reaches the tmux client of an attached session even with its own process env", async () => {
		resetEnvFromDev3Pane(agentPaneEnv(), "darwin");
		const { client, seen, spawnEnv } = fakeClient();

		await withTaskEnv(async () => {
			client.spawnAttachedSession({
				sessionName: "s", configFile: "/tmp/c.conf", cwd: "/tmp", socket: "probe",
				terminal: { cols: 80, rows: 24, data: () => {} },
				processEnv: { TERM: "xterm-256color", HOME: "/Users/me" },
			});
		});

		expectNoTaskWiring(seen[0]);
		expectNoTaskWiring(spawnEnv());
		expect(spawnEnv().TERM).toBe("xterm-256color");
	});
});

describe("Linux desktop session keys", () => {
	it("keeps the desktop-session keys that GTK and input-method children need", () => {
		const env: Env = {
			DEV3_TASK_ID: "task-a", DISPLAY: ":0", XAUTHORITY: "/run/user/1000/.Xauthority", GDK_BACKEND: "x11",
			GTK_IM_MODULE: "ibus", QT_IM_MODULE: "ibus", XMODIFIERS: "@im=ibus", container: "systemd-nspawn", INVOCATION_ID: "stale",
		};

		resetEnvFromDev3Pane(env, "linux");

		expect(Object.keys(env).sort()).toEqual([
			"DEV3_TASK_ID", "DISPLAY", "GDK_BACKEND", "GTK_IM_MODULE", "QT_IM_MODULE", "XAUTHORITY", "XMODIFIERS", "container",
		]);
	});
});

describe("isTaskWiringKey", () => {
	const project = { id: "p", name: "a", path: "/projects/a" } as Project;
	const task = { id: "task-a", seq: 78, title: "Fix a", branchName: "fix/a" } as Task;

	it("counts every DEV3_ key the pane env builders write as wiring", () => {
		const builtEnvs = [
			buildTaskEnv(project, "Fix a", "task-a", "/w"),
			buildAgentEnv({}, "task-a"),
			buildTaskLifecycleEnv(project, task, "/w", "fix/a"),
			buildProjectTerminalEnv(project, {}),
			buildPortEnv([17747, 17748, 17749]),
			buildNamedPortEnv({ api: 17750 }),
		];
		// Written inline at their call sites: artifact template, dev server pane, lean protocol, pane id.
		const inlineKeys = ["DEV3_ARTIFACT_TEMPLATE", "DEV3_ARTIFACT_TEMPLATE_DIR", "DEV3_DEV_SERVER", "DEV3_WORKTREE_ROOT", "DEV3_LEAN_PROTOCOL", "DEV3_PANE_ID"];
		const keys = [
			...builtEnvs.flatMap((env) => Object.keys(env)), ...inlineKeys, ...TASK_SCOPED_ENV_KEYS, ...INHERITED_TASK_ENV_KEYS,
		].filter((key) => key.startsWith("DEV3_"));

		expect(keys.length).toBeGreaterThan(10);
		expect(keys.filter((key) => !isTaskWiringKey(key))).toEqual([]);
	});

	it("treats an unknown DEV3_ key as wiring and keeps the app-wide ones", () => {
		expect(isTaskWiringKey("DEV3_SOMETHING_ADDED_LATER")).toBe(true);
		for (const key of ["DEV3_HOME", "DEV3_LOG_DIR", "DEV3_QA_SCOPE", "DEV3_FRESH_START", "DEV3_REMOTE_PORT", "DEV3_NATIVE_HOST_RUNTIME"]) {
			expect(isTaskWiringKey(key)).toBe(false);
		}
		expect(isTaskWiringKey("CLAUDE_CONFIG_DIR")).toBe(false);
	});
});
