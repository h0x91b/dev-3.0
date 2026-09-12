import { describe, expect, it } from "vitest";
import { CodexQuestionState } from "../codex-question-state";

describe("CodexQuestionState", () => {
	it("serializes overlapping hooks and recovers after a failed move", async () => {
		const state = new CodexQuestionState();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const order: string[] = [];
		const first = state.run("task", async () => { await gate; order.push("question"); });
		const second = state.run("task", async () => { order.push("stop"); });
		await state.run("other", async () => { order.push("other"); });
		expect(order).toEqual(["other"]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["other", "question", "stop"]);
		const failed = state.run("task", async () => { throw new Error("offline"); });
		const retry = state.run("task", async () => "retried");
		await expect(failed).rejects.toThrow("offline");
		await expect(retry).resolves.toBe("retried");
	});

	it("waits for every blocking call and isolates sessions", () => {
		const state = new CodexQuestionState();
		state.apply("task", "one", "PreToolUse", "review-by-ai", "request_user_input", "a");
		state.apply("task", "one", "PreToolUse", "user-questions", "request_user_input", "b");
		expect(state.apply("other-task", "two", "PostToolUse", "in-progress", "Bash").pending).toBe(false);
		expect(state.apply("task", "one", "PostToolUse", "user-questions", "request_user_input", "a").pending).toBe(true);
		expect(state.apply("task", "one", "PostToolUse", "user-questions", "request_user_input", "b"))
			.toEqual({ pending: false, resumeStatus: "review-by-ai" });
	});

	it("keeps one pane from clearing another pane's pending questions", () => {
		const state = new CodexQuestionState();
		state.apply("task", "one", "PostToolUse", "in-progress", "request_user_input_async");
		expect(state.apply("task", "two", "UserPromptSubmit", "user-questions").pending).toBe(true);
		expect(state.apply("task", "two", "Stop", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "UserPromptSubmit", "user-questions"))
			.toEqual({ pending: false, resumeStatus: "in-progress" });
	});

	it("keeps unanswered cards after a partial answer and deduplicates hook delivery", () => {
		const state = new CodexQuestionState();
		for (let delivery = 0; delivery < 2; delivery++) {
			state.apply("task", "one", "PostToolUse", "in-progress", "request_user_input_async", "batch", ["first", "second"]);
		}
		expect(state.apply("task", "one", "UserPromptSubmit", "user-questions", undefined, undefined, undefined, "first").pending).toBe(true);
		expect(state.apply("task", "one", "Stop", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "UserPromptSubmit", "user-questions", undefined, undefined, undefined, "second"))
			.toEqual({ pending: false, resumeStatus: "in-progress" });
	});

	it("does not mistake starting an async tool for a successfully queued question", () => {
		const state = new CodexQuestionState();
		expect(state.apply("task", "one", "PreToolUse", "in-progress", "request_user_input_async").pending).toBe(false);
		expect(state.apply("task", "one", "Stop", "in-progress").pending).toBe(false);
	});

	it("cleans up failed blocking tools at Stop without dropping async questions", () => {
		const state = new CodexQuestionState();
		state.apply("task", "one", "PreToolUse", "in-progress", "request_user_input", "a");
		expect(state.apply("task", "one", "Stop", "user-questions"))
			.toEqual({ pending: false, resumeStatus: "in-progress" });
		state.apply("task", "one", "PostToolUse", "in-progress", "functions.request_user_input_async");
		state.apply("task", "one", "PreToolUse", "user-questions", "request_user_input", "b");
		expect(state.apply("task", "one", "Stop", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "SessionStart", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "UserPromptSubmit", "user-questions"))
			.toEqual({ pending: false, resumeStatus: "in-progress" });
	});

	it("drops interrupted blocking calls and clears async waits when their session exits", () => {
		const state = new CodexQuestionState();
		state.apply("task", "one", "PreToolUse", "in-progress", "request_user_input");
		expect(state.apply("task", "one", "Interrupt", "user-questions").pending).toBe(false);
		state.apply("task", "one", "PostToolUse", "in-progress", "request_user_input_async");
		expect(state.apply("task", "one", "Interrupt", "user-questions").pending).toBe(true);
		expect(state.apply("task", "one", "SessionEnd", "user-questions").pending).toBe(false);
	});

	it.each(["completed", "cancelled"] as const)("forgets questions for %s tasks", (status) => {
		const state = new CodexQuestionState();
		state.apply("task", "one", "PostToolUse", "in-progress", "request_user_input_async");
		expect(state.apply("task", "one", "PreToolUse", status, "request_user_input").pending).toBe(false);
		expect(state.apply("task", "one", "PostToolUse", "in-progress", "Bash").pending).toBe(false);
	});
});
