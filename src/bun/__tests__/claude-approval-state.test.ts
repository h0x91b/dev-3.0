import { describe, expect, it, vi } from "vitest";
import { CLAUDE_BACKGROUND_STALE_MS, ClaudeApprovalState } from "../claude-approval-state";

const parent = { sessionId: "s" };
const child = { sessionId: "s", agentId: "reader" };

describe("ClaudeApprovalState", () => {
	it("does not revive a todo, completed or cancelled task", () => {
		for (const status of ["todo", "completed", "cancelled"] as const) {
			const state = new ClaudeApprovalState();
			expect(state.apply("t", status, "PermissionRequest", child), status).toBeNull();
			expect(state.apply("t", status, "PreToolUse", child), status).toBeNull();
		}
	});

	it("keeps another agent's wait visible on a new parent prompt, but clears the parent's own", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child);
		expect(state.apply("t", "user-questions", "UserPromptSubmit", parent)).toBe("user-questions");

		// The parent's own cancelled wait, by contrast, clears.
		const own = new ClaudeApprovalState();
		own.apply("t", "in-progress", "PermissionRequest", parent);
		expect(own.apply("t", "user-questions", "UserPromptSubmit", parent)).toBe("in-progress");
	});

	it("remembers a parent that stops while its child awaits approval", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child);
		expect(state.stopParent("t", "user-questions", "s", "review-by-user")).toBe("user-questions");
		expect(state.apply("t", "user-questions", "SubagentStop", child)).toBe("review-by-user");
		// Unowned semantic questions are preserved when the parent stops.
		expect(new ClaudeApprovalState().stopParent("t", "user-questions", "s", "review-by-user")).toBeNull();
	});

	it("keeps working until every child of a stopped parent finishes, and finishes a paused AI reviewer", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PreToolUse", child);
		expect(state.stopParent("t", "in-progress", "s", "review-by-ai")).toBe("in-progress");
		expect(state.apply("t", "in-progress", "SubagentStop", child)).toBe("review-by-ai");

		// A paused AI reviewer finishes after its child stops.
		const reviewer = new ClaudeApprovalState();
		reviewer.apply("t", "review-by-ai", "PermissionRequest", child);
		expect(reviewer.stopParent("t", "user-questions", "s", "review-by-ai")).toBe("user-questions");
		expect(reviewer.apply("t", "user-questions", "SubagentStop", child)).toBe("review-by-user");
	});

	it("scopes session cleanup to that conversation, and state to its task", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child);
		state.apply("t", "user-questions", "PermissionRequest", { sessionId: "other", agentId: "reader" });
		state.endSession("t", "s");
		expect(state.apply("t", "user-questions", "PreToolUse", parent)).toBe("user-questions");
		expect(state.apply("t", "user-questions", "PostToolUse", { sessionId: "other", agentId: "reader" })).toBe("in-progress");

		// Other tasks are not interfered with either.
		const tasks = new ClaudeApprovalState();
		tasks.apply("t", "in-progress", "PermissionRequest", parent);
		expect(tasks.apply("other", "review-by-user", "PreToolUse", child)).toBe("in-progress");
		expect(tasks.apply("t", "user-questions", "PreToolUse", child)).toBe("user-questions");
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

	it("never expires a background agent that waits on an approval, nor arms expiry while the parent works", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", child, 0);
		state.stopParent("t", "user-questions", "s", "review-by-user");
		expect(state.nextExpiry("t")).toBeNull();
		expect(state.expireStale("t", "user-questions", 10 * CLAUDE_BACKGROUND_STALE_MS)).toBeNull();
		expect(state.apply("t", "user-questions", "SubagentStop", child)).toBe("review-by-user");

		// Nor is expiry armed while the parent is still working.
		const working = new ClaudeApprovalState();
		working.apply("t", "in-progress", "PreToolUse", child, 0);
		expect(working.nextExpiry("t")).toBeNull();
		expect(working.expireStale("t", "in-progress", 10 * CLAUDE_BACKGROUND_STALE_MS)).toBeNull();
	});

	it("clears a parent's own wait on a failed call without claiming the idle agent is working", () => {
		const state = new ClaudeApprovalState();
		state.apply("t", "in-progress", "PermissionRequest", parent);
		expect(state.apply("t", "user-questions", "PostToolUseFailure", parent)).toBeNull();
		expect(state.apply("t", "review-by-user", "PostToolUseFailure", parent)).toBeNull();
		expect(state.apply("t", "user-questions", "PreToolUse", parent)).toBe("in-progress");

		// A background agent whose own wait ends in a failed call resumes.
		const bg = new ClaudeApprovalState();
		bg.apply("t", "in-progress", "PermissionRequest", child);
		expect(bg.apply("t", "user-questions", "PostToolUseFailure", child)).toBe("in-progress");
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
