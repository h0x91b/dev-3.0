/**
 * The whole chain from a Task to a native host's world-visible name (seq 1383):
 * `buildTaskLifecycleEnv` is the only place the human task number enters the
 * task environment, and the launch env is the only thing `process-naming` reads.
 */

import { describe, expect, it } from "vitest";
import { AGENT_ENV_DEFAULTS, TASK_SCOPED_ENV_KEYS, buildAgentEnv, buildProjectTerminalEnv, buildTaskLifecycleEnv } from "../shared-pure";
import { ENV_UNSET } from "../../../shared/agent-accounts";
import { nativeHostProcessName } from "../../native-terminal-registry/process-naming";
import type { Project, Task } from "../../../shared/types";

const project = { id: "p1", name: "dev-3.0", path: "/repo" } as Project;

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "11111111-2222-3333-4444-555555555555",
		seq: 1383,
		title: "Rotate the production secret",
		branchName: "feat/dev3-secret",
		...overrides,
	} as Task;
}

const SESSION = "dev3-task-11111111-2222-3333-4444-555555555555-pane-1";

describe("task lifecycle env — DEV3_TASK_SEQ", () => {
	it("carries the human task number", () => {
		expect(buildTaskLifecycleEnv(project, task(), "/worktree").DEV3_TASK_SEQ).toBe("1383");
	});

	it("carries a variant's suffix, which is part of its human number", () => {
		expect(buildTaskLifecycleEnv(project, task({ variantIndex: 2 }), "/worktree").DEV3_TASK_SEQ).toBe("1383-2");
	});

	it("keeps every var the env already had", () => {
		const env = buildTaskLifecycleEnv(project, task(), "/worktree", "feat/x");
		expect(env).toMatchObject({
			DEV3_PROJECT_PATH: "/repo",
			DEV3_PROJECT_NAME: "dev-3.0",
			DEV3_TASK_ID: "11111111-2222-3333-4444-555555555555",
			DEV3_TASK_TITLE: "Rotate the production secret",
			DEV3_WORKTREE_PATH: "/worktree",
			DEV3_BRANCH_NAME: "feat/x",
		});
	});

	it("is what makes a native host readable in a process viewer", () => {
		const env = buildTaskLifecycleEnv(project, task(), "/worktree");
		expect(nativeHostProcessName(SESSION, env)).toBe("dev3-terminal-host seq:1383 pane:1");
	});

	it("lets nothing else from that env reach the process name", () => {
		const env = buildTaskLifecycleEnv(project, task(), "/Users/arsenyp/.dev3.0/worktrees/slug/83bffcfd/worktree");
		const name = nativeHostProcessName(SESSION, env);
		for (const leak of ["secret", "worktrees", "arsenyp", "feat/", "11111111"]) expect(name).not.toContain(leak);
	});
});

describe("Repo terminal env — its own project, no task", () => {
	const base44 = { id: "p2", name: "base44", path: "/src/base44" } as Project;

	it("names its own project and removes every task-scoped key", () => {
		const env = buildProjectTerminalEnv(base44, { API_URL: "https://x" });
		expect(env).toMatchObject({ API_URL: "https://x", DEV3_PROJECT_PATH: "/src/base44", DEV3_PROJECT_NAME: "base44" });
		for (const key of TASK_SCOPED_ENV_KEYS) expect(env[key]).toBe(ENV_UNSET);
	});

	it("does not let repo env override the project identity", () => {
		const env = buildProjectTerminalEnv(base44, { DEV3_PROJECT_NAME: "video-edit", DEV3_TASK_SEQ: "14-1" });
		expect(env.DEV3_PROJECT_NAME).toBe("base44");
		expect(env.DEV3_TASK_SEQ).toBe(ENV_UNSET);
	});

	it("removes every task lifecycle key that is not the project's", () => {
		// A key added to buildTaskLifecycleEnv must also be cleared here, or it leaks again.
		const projectKeys = new Set(["DEV3_PROJECT_PATH", "DEV3_PROJECT_NAME"]);
		const taskKeys = Object.keys(buildTaskLifecycleEnv(project, task(), "/worktree")).filter((k) => !projectKeys.has(k));
		expect([...TASK_SCOPED_ENV_KEYS].sort()).toEqual(taskKeys.sort());
	});
});

describe("agent env — FORCE_HYPERLINK", () => {
	/** The same spread order every tmux-pty.ts launch site uses. */
	function assembled(projectEnv: Record<string, string>, extraEnv: Record<string, string> = {}) {
		return {
			...AGENT_ENV_DEFAULTS,
			...projectEnv,
			...buildTaskLifecycleEnv(project, task(), "/worktree"),
			...buildAgentEnv(extraEnv, "t1"),
		};
	}

	it("opts agents into OSC 8 hyperlink emission by default", () => {
		expect(assembled({}).FORCE_HYPERLINK).toBe("1");
	});

	it("lets project env override the opt-in", () => {
		expect(assembled({ FORCE_HYPERLINK: "0" }).FORCE_HYPERLINK).toBe("0");
	});

	it("lets per-agent-config env override both", () => {
		expect(assembled({ FORCE_HYPERLINK: "0" }, { FORCE_HYPERLINK: "1" }).FORCE_HYPERLINK).toBe("1");
	});

	it("keeps the opt-in out of buildAgentEnv, whose output outranks project env", () => {
		expect(buildAgentEnv({}, "t1")).not.toHaveProperty("FORCE_HYPERLINK");
	});
});
