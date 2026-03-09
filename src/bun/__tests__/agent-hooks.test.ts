import { describe, it, expect } from "vitest";
import { buildClaudeHooks, mergeClaudeHooks } from "../agent-hooks";

const TASK_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const DEV3_CLI = "~/.dev3.0/bin/dev3";

describe("buildClaudeHooks", () => {
	it("returns PermissionRequest and Stop hooks with embedded task ID", () => {
		const hooks = buildClaudeHooks(TASK_ID);

		expect(hooks).toHaveProperty("PermissionRequest");
		expect(hooks).toHaveProperty("Stop");
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("PermissionRequest hook moves to user-questions", () => {
		const hooks = buildClaudeHooks(TASK_ID);
		const cmd = hooks.PermissionRequest[0].command;

		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain(TASK_ID);
		expect(cmd).toContain("--status user-questions");
	});

	it("Stop hook moves to review-by-user with --if-status guard", () => {
		const hooks = buildClaudeHooks(TASK_ID);
		const cmd = hooks.Stop[0].command;

		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain(TASK_ID);
		expect(cmd).toContain("--status review-by-user");
		expect(cmd).toContain("--if-status in-progress");
	});

	it("all hooks use command type", () => {
		const hooks = buildClaudeHooks(TASK_ID);

		for (const entries of Object.values(hooks)) {
			for (const entry of entries) {
				expect(entry.type).toBe("command");
			}
		}
	});
});

describe("mergeClaudeHooks", () => {
	it("adds hooks to empty settings", () => {
		const result = mergeClaudeHooks({}, TASK_ID);

		expect(result.hooks).toBeDefined();
		const hooks = result.hooks as Record<string, unknown[]>;
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("preserves existing non-hook settings", () => {
		const existing = { permissions: { allow: ["Bash(*)"] }, someKey: 42 };
		const result = mergeClaudeHooks(existing, TASK_ID);

		expect(result.permissions).toEqual({ allow: ["Bash(*)"] });
		expect(result.someKey).toBe(42);
		expect(result.hooks).toBeDefined();
	});

	it("preserves existing hooks on unrelated events", () => {
		const existing = {
			hooks: {
				PreToolUse: [{ type: "command", command: "echo pre" }],
			},
		};
		const result = mergeClaudeHooks(existing, TASK_ID);
		const hooks = result.hooks as Record<string, unknown[]>;

		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("preserves non-dev3 hooks on the same events", () => {
		const existing = {
			hooks: {
				PermissionRequest: [{ type: "command", command: "echo notify" }],
				Stop: [{ type: "command", command: "echo done" }],
			},
		};
		const result = mergeClaudeHooks(existing, TASK_ID);
		const hooks = result.hooks as Record<string, unknown[]>;

		// Original hooks preserved + dev3 hooks appended
		expect(hooks.PermissionRequest).toHaveLength(2);
		expect(hooks.Stop).toHaveLength(2);
	});

	it("is idempotent — running twice does not duplicate dev3 hooks", () => {
		const first = mergeClaudeHooks({}, TASK_ID);
		const second = mergeClaudeHooks(first as Record<string, unknown>, TASK_ID);
		const hooks = second.hooks as Record<string, unknown[]>;

		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("replaces dev3 hooks from a different task ID", () => {
		const first = mergeClaudeHooks({}, "old-task-id");
		const second = mergeClaudeHooks(first as Record<string, unknown>, "new-task-id");
		const hooks = second.hooks as Record<string, { command: string }[]>;

		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.PermissionRequest[0].command).toContain("new-task-id");
		expect(hooks.PermissionRequest[0].command).not.toContain("old-task-id");
	});
});
