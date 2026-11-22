import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const moveTask = vi.fn();
const resolveTaskFromParams = vi.fn();
vi.mock("../rpc-handlers", () => ({ moveTask: (...args: unknown[]) => moveTask(...args) }));
vi.mock("../cli-socket/task-resolution", () => ({ resolveTaskFromParams: (...args: unknown[]) => resolveTaskFromParams(...args) }));
vi.mock("../cli-socket/shared", () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

import { CLAUDE_BACKGROUND_STALE_MS, claudeApprovals } from "../claude-approval-state";
import { applyClaudeHookStatus, scheduleClaudeBackgroundExpiry } from "../cli-socket/claude-hook-status";

let status = "in-progress";
const ctx = {} as Parameters<typeof applyClaudeHookStatus>[1];

beforeEach(() => {
	vi.useFakeTimers();
	status = "in-progress";
	resolveTaskFromParams.mockImplementation(async () => ({ task: { id: "t1", projectId: "p1", status, customColumnId: null } }));
	moveTask.mockImplementation(async (params: { newStatus: string }) => {
		status = params.newStatus;
		return { id: "t1", projectId: "p1", status };
	});
});
afterEach(() => {
	claudeApprovals.endSession("t1", "s");
	scheduleClaudeBackgroundExpiry("t1", "p1");
	vi.useRealTimers();
	moveTask.mockReset();
});

describe("Claude background expiry timer", () => {
	it("moves a stopped parent's card to review once its silent background agent goes stale", async () => {
		await applyClaudeHookStatus({ taskId: "t1", event: "PreToolUse", sessionId: "s", agentId: "reader" }, ctx);
		await claudeApprovals.run("t1", async () => {
			expect(claudeApprovals.stopParent("t1", "in-progress", "s", "review-by-user")).toBe("in-progress");
		});
		scheduleClaudeBackgroundExpiry("t1", "p1");

		await vi.advanceTimersByTimeAsync(CLAUDE_BACKGROUND_STALE_MS - 1_000);
		expect(moveTask).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(moveTask).toHaveBeenCalledWith({ taskId: "t1", projectId: "p1", newStatus: "review-by-user", ifStatus: "in-progress" });
		expect(claudeApprovals.nextExpiry("t1")).toBeNull();
	});

	it("re-arms from the newest activity instead of expiring an agent that keeps working", async () => {
		await applyClaudeHookStatus({ taskId: "t1", event: "PreToolUse", sessionId: "s", agentId: "reader" }, ctx);
		await claudeApprovals.run("t1", async () => { claudeApprovals.stopParent("t1", "in-progress", "s", "review-by-user"); });
		scheduleClaudeBackgroundExpiry("t1", "p1");

		await vi.advanceTimersByTimeAsync(CLAUDE_BACKGROUND_STALE_MS - 1_000);
		await applyClaudeHookStatus({ taskId: "t1", event: "PostToolUse", sessionId: "s", agentId: "reader" }, ctx);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(moveTask).not.toHaveBeenCalledWith(expect.objectContaining({ newStatus: "review-by-user" }));

		await applyClaudeHookStatus({ taskId: "t1", event: "SubagentStop", sessionId: "s", agentId: "reader" }, ctx);
		expect(moveTask).toHaveBeenLastCalledWith({ taskId: "t1", projectId: "p1", newStatus: "review-by-user", ifStatus: "in-progress" });
	});
});
