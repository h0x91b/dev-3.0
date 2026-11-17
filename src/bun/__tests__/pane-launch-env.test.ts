import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetLaunchTaskWiringForTests,
	resetEnvFromDev3Pane,
	startedInsideDev3Pane,
	withoutLaunchTaskWiring,
} from "../pane-launch-env";
import { TmuxClient } from "../tmux/client";

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

		expect(withoutLaunchTaskWiring({ HOME: "/Users/me", DEV3_HOME: "/h", DEV3_QA_SCOPE: "0", DEV3_TASK_ID: "task-a", DEV3_PORT0: "17747", DEV3_PROJECT_PATH: "/p", DEV3_WORKTREE_ROOT: "/w", DEV3_BRANCH_NAME: "b", DEV3_PORTS: "x", DEV3_TASK_SEQ: "1" }))
			.toEqual({ HOME: "/Users/me", DEV3_HOME: "/h", DEV3_QA_SCOPE: "0" });
	});

	it("is what TmuxClient hands to a tmux server it starts", async () => {
		resetEnvFromDev3Pane(agentPaneEnv(), "darwin");
		const seen: Env[] = [];
		const ensureServer = vi.fn((opts: { env: Env }) => { seen.push({ ...opts.env }); });
		const spawn = vi.fn().mockReturnValue({ pid: 1, kill: vi.fn(), stdout: "", stderr: "", exited: Promise.resolve(0) });
		const client = new TmuxClient({ cwdExists: () => true, spawn: spawn as never, ensureServer: ensureServer as never });
		const before = { ...process.env };
		process.env.DEV3_TASK_ID = "task-a";
		process.env.DEV3_PORT0 = "17747";
		try {
			await client.newSessionDetached({ sessionName: "s", cwd: "/tmp", socket: "probe" });
		} finally {
			for (const key of ["DEV3_TASK_ID", "DEV3_PORT0"]) {
				if (before[key] === undefined) delete process.env[key];
				else process.env[key] = before[key];
			}
		}

		const env = seen[0];
		expect(env.DEV3_TASK_ID).toBeUndefined();
		expect(env.DEV3_PORT0).toBeUndefined();
		expect(env.PATH).toBe(process.env.PATH);
	});
});
