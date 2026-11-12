import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../../shared/types";
import { tmuxRestartImpact } from "../tmux-restart-impact";

function task(id: string, status: TaskStatus, extra: Partial<Task> = {}): Task {
	return { id, seq: 7, variantIndex: null, title: `Task ${id}`, status, ...extra } as Task;
}

describe("tmuxRestartImpact", () => {
	const working = task("aaaaaaaa-1111", "in-progress", { customTitle: "Fix the login race" });
	const reviewing = task("bbbbbbbb-2222", "review-by-ai", { seq: 12, variantIndex: 2 });
	const idle = task("cccccccc-3333", "user-questions");
	const noTerminal = task("dddddddd-4444", "in-progress");

	it("counts task terminals apart from every other session", () => {
		const impact = tmuxRestartImpact(
			["dev3-aaaaaaaa", "dev3-cccccccc", "dev3-pt-eeeeeeee", "dev3-dev-aaaaaaaa", "dev3-cl-ffffffff", "scratch"],
			[],
		);
		expect(impact).toEqual({ taskTerminals: 2, otherSessions: 4, working: [] });
	});

	it("lists only agents that are mid-turn in a live terminal", () => {
		const impact = tmuxRestartImpact(
			["dev3-aaaaaaaa", "dev3-bbbbbbbb", "dev3-cccccccc"],
			[{ project: { name: "dev-3.0" }, tasks: [working, reviewing, idle, noTerminal] }],
		);
		expect(impact.working).toEqual([
			{ taskId: working.id, seqLabel: "7", title: "Fix the login race", projectName: "dev-3.0" },
			{ taskId: reviewing.id, seqLabel: "12-2", title: "Task bbbbbbbb-2222", projectName: "dev-3.0" },
		]);
	});
});
