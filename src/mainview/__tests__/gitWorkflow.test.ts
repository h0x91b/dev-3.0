import { describe, expect, it } from "vitest";
import { gitWorkflowSwitchBlocker, hasGitWorkflow } from "../../shared/types";

describe("hasGitWorkflow", () => {
	it("is on for a git project unless switched off", () => {
		expect(hasGitWorkflow({})).toBe(true);
		expect(hasGitWorkflow({ kind: "git" })).toBe(true);
		expect(hasGitWorkflow({ kind: "git", gitWorkflow: false })).toBe(false);
	});

	it("is always off for an Operations board", () => {
		expect(hasGitWorkflow({ kind: "virtual" })).toBe(false);
		expect(hasGitWorkflow({ kind: "virtual", gitWorkflow: true })).toBe(false);
	});
});

describe("gitWorkflowSwitchBlocker", () => {
	const idle = { status: "todo" as const, worktreePath: null };

	it("allows the switch when no task holds a folder", () => {
		expect(gitWorkflowSwitchBlocker({}, [idle, { status: "completed", worktreePath: null }])).toBeNull();
	});

	it("counts tasks that run, prepare or tear down", () => {
		const blocker = gitWorkflowSwitchBlocker({}, [
			{ status: "in-progress", worktreePath: "/wt/a" },
			{ status: "todo", worktreePath: null, preparing: true },
			{ status: "todo", worktreePath: null, runtimeState: { runtime: "tearing-down" } as never },
			idle,
		]);
		expect(blocker).toEqual({ reason: "live-tasks", count: 3 });
	});

	it("ignores a finished task that kept its folder path", () => {
		expect(gitWorkflowSwitchBlocker({}, [{ status: "completed", worktreePath: "/ops/a" }])).toBeNull();
	});

	it("never lets an Operations board switch", () => {
		expect(gitWorkflowSwitchBlocker({ kind: "virtual" }, [])).toEqual({ reason: "virtual" });
	});
});
