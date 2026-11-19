import { describe, expect, it } from "vitest";
import { ClaudeApprovalState } from "../claude-approval-state";

const parent = { sessionId: "s" };
const child = { sessionId: "s", agentId: "reader" };

describe("ClaudeApprovalState", () => {
	it.each(["todo", "completed", "cancelled"] as const)("does not revive a %s task", status => {
		const state = new ClaudeApprovalState();
		expect(state.apply("t", status, "PermissionRequest", child)).toBeNull();
		expect(state.apply("t", status, "PreToolUse", child)).toBeNull();
	});

	it("keeps another agent's wait visible when the parent submits a new prompt", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child);
		expect(state.apply("t", "user-questions", "UserPromptSubmit", parent)).toBe("user-questions");
	});

	it("clears the parent's own cancelled wait on a new prompt", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", parent);
		expect(state.apply("t", "user-questions", "UserPromptSubmit", parent)).toBe("in-progress");
	});

	it("remembers a parent that stops while its child awaits approval", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child);
		expect(state.stopParent("t", "user-questions", "s", "review-by-user")).toBe("user-questions");
		expect(state.apply("t", "user-questions", "SubagentStop", child)).toBe("review-by-user");
	});

	it("keeps working until every child of a stopped parent finishes", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PreToolUse", child);
		expect(state.stopParent("t", "in-progress", "s", "review-by-ai")).toBe("in-progress");
		expect(state.apply("t", "in-progress", "SubagentStop", child)).toBe("review-by-ai");
	});

	it("finishes a paused AI reviewer after its child stops", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "review-by-ai", "PermissionRequest", child);
		expect(state.stopParent("t", "user-questions", "s", "review-by-ai")).toBe("user-questions");
		expect(state.apply("t", "user-questions", "SubagentStop", child)).toBe("review-by-user");
	});

	it("preserves unowned semantic questions when the parent stops", () => {
		const state = new ClaudeApprovalState();
		expect(state.stopParent("t", "user-questions", "s", "review-by-user")).toBeNull();
	});

	it("scopes session cleanup to that conversation", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child);
		state.apply("t", "user-questions", "PermissionRequest", { sessionId: "other", agentId: "reader" });
		state.endSession("t", "s");
		expect(state.apply("t", "user-questions", "PreToolUse", parent)).toBe("user-questions");
		expect(state.apply("t", "user-questions", "PostToolUse", { sessionId: "other", agentId: "reader" })).toBe("in-progress");
	});

	it("does not interfere with other tasks", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", parent);
		expect(state.apply("other", "review-by-user", "PreToolUse", child)).toBe("in-progress");
		expect(state.apply("t", "user-questions", "PreToolUse", child)).toBe("user-questions");
	});

	it("restores AI review after multiple owners resume", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "review-by-ai", "PermissionRequest", parent);
		state.apply("t", "user-questions", "Notification", child);
		state.apply("t", "user-questions", "PostToolUse", parent);
		expect(state.apply("t", "user-questions", "PreToolUse", child)).toBe("review-by-ai");
	});

	it("serializes asynchronous moves and recovers the queue after a failure", async () => {
		const state = new ClaudeApprovalState();
		const calls: string[] = [];
		let release!: () => void;
		const barrier = new Promise<void>(resolve => { release = resolve; });
		const first = state.run("t", async () => { await barrier; calls.push("wait"); throw new Error("offline"); });
		const failed = expect(first).rejects.toThrow("offline");
		const next = state.run("t", async () => { calls.push("resume"); });
		release();
		await Promise.all([failed, next]);
		expect(calls).toEqual(["wait", "resume"]);
	});

	it("retains a waiting owner when its resume status cannot be saved", async () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child);
		await expect(state.run("t", async () => {
			state.apply("t", "user-questions", "PostToolUse", child);
			throw new Error("offline");
		})).rejects.toThrow("offline");
		expect(state.apply("t", "user-questions", "PreToolUse", parent)).toBe("user-questions");
		expect(state.apply("t", "user-questions", "PostToolUse", child)).toBe("in-progress");
	});
});
