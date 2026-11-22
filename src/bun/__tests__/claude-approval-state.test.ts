import { describe, expect, it, vi } from "vitest";
import { CLAUDE_BACKGROUND_STALE_MS, ClaudeApprovalState } from "../claude-approval-state";

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

	it("lets a stopped parent reach review once a background agent that never reports its stop goes stale", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PreToolUse", child, 1_000);
		state.apply("t", "in-progress", "UserPromptSubmit", parent, 2_000);
		expect(state.stopParent("t", "in-progress", "s", "review-by-user")).toBe("in-progress");
		expect(state.nextExpiry("t")).toBe(1_000 + CLAUDE_BACKGROUND_STALE_MS);
		expect(state.expireStale("t", "in-progress", 1_000 + CLAUDE_BACKGROUND_STALE_MS - 1)).toBeNull();
		expect(state.expireStale("t", "in-progress", 1_000 + CLAUDE_BACKGROUND_STALE_MS)).toBe("review-by-user");
		expect(state.nextExpiry("t")).toBeNull();
	});

	it("keeps a background agent that is still active past the stale window of a quiet one", () => {
		const state = new ClaudeApprovalState();
		const busy = { sessionId: "s", agentId: "writer" };
		state.apply("t", "in-progress", "PreToolUse", child, 0);
		state.stopParent("t", "in-progress", "s", "review-by-ai");
		state.apply("t", "in-progress", "PostToolUse", busy, CLAUDE_BACKGROUND_STALE_MS - 10);
		expect(state.expireStale("t", "in-progress", CLAUDE_BACKGROUND_STALE_MS)).toBeNull();
		expect(state.nextExpiry("t")).toBe(2 * CLAUDE_BACKGROUND_STALE_MS - 10);
		expect(state.apply("t", "in-progress", "SubagentStop", busy)).toBe("review-by-ai");
	});

	it("never expires a background agent that waits on an approval", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child, 0);
		state.stopParent("t", "user-questions", "s", "review-by-user");
		expect(state.nextExpiry("t")).toBeNull();
		expect(state.expireStale("t", "user-questions", 10 * CLAUDE_BACKGROUND_STALE_MS)).toBeNull();
		expect(state.apply("t", "user-questions", "SubagentStop", child)).toBe("review-by-user");
	});

	it("does not arm expiry while the parent is still working", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PreToolUse", child, 0);
		expect(state.nextExpiry("t")).toBeNull();
		expect(state.expireStale("t", "in-progress", 10 * CLAUDE_BACKGROUND_STALE_MS)).toBeNull();
	});

	it("clears a parent's own wait on a failed call without claiming the idle agent is working", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", parent);
		expect(state.apply("t", "user-questions", "PostToolUseFailure", parent)).toBeNull();
		expect(state.apply("t", "review-by-user", "PostToolUseFailure", parent)).toBeNull();
		expect(state.apply("t", "user-questions", "PreToolUse", parent)).toBe("in-progress");
	});

	it("resumes a background agent whose own wait ends in a failed call", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child);
		expect(state.apply("t", "user-questions", "PostToolUseFailure", child)).toBe("in-progress");
	});

	it("forgetTask drops every owner and cancels the pending expiry timer", () => {
		vi.useFakeTimers();
		try {
			const state = new ClaudeApprovalState();
			const fire = vi.fn();
			state.apply("t", "in-progress", "PermissionRequest", { sessionId: "old" });
			state.armExpiry("t", 1_000, fire);
			state.forgetTask("t");
			vi.advanceTimersByTime(2_000);
			expect(fire).not.toHaveBeenCalled();
			expect(state.apply("t", "user-questions", "PreToolUse", { sessionId: "new" })).toBe("in-progress");
		} finally { vi.useRealTimers(); }
	});
});
