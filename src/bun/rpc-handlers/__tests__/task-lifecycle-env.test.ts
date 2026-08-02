/**
 * The whole chain from a Task to a native host's world-visible name (seq 1383):
 * `buildTaskLifecycleEnv` is the only place the human task number enters the
 * task environment, and the launch env is the only thing `process-naming` reads.
 */

import { describe, expect, it } from "vitest";
import { buildTaskLifecycleEnv } from "../shared-pure";
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
