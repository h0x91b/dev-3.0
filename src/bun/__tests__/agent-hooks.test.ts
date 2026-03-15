import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildClaudeHooks, mergeClaudeHooks, writeClaudeHooks } from "../agent-hooks";
import type { MatcherGroup } from "../../shared/agent-hooks";

const TASK_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const DEV3_CLI = "~/.dev3.0/bin/dev3";

describe("buildClaudeHooks", () => {
	it("returns UserPromptSubmit, PreToolUse, PermissionRequest and Stop matcher groups", () => {
		const hooks = buildClaudeHooks(TASK_ID);

		expect(hooks).toHaveProperty("UserPromptSubmit");
		expect(hooks).toHaveProperty("PreToolUse");
		expect(hooks).toHaveProperty("PermissionRequest");
		expect(hooks).toHaveProperty("Stop");
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("UserPromptSubmit hook moves to in-progress with --if-status-not guard", () => {
		const hooks = buildClaudeHooks(TASK_ID);
		const cmd = hooks.UserPromptSubmit[0].hooks[0].command;

		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain(TASK_ID);
		expect(cmd).toContain("--status in-progress");
		expect(cmd).toContain("--if-status-not review-by-ai");
		expect(cmd).not.toContain("review-by-user");
	});

	it("PreToolUse hook moves to in-progress with --if-status-not guard", () => {
		const hooks = buildClaudeHooks(TASK_ID);
		const cmd = hooks.PreToolUse[0].hooks[0].command;

		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain(TASK_ID);
		expect(cmd).toContain("--status in-progress");
		expect(cmd).toContain("--if-status-not review-by-ai");
		expect(cmd).not.toContain("review-by-user");
	});

	it("uses correct three-level nesting (event → matcher group → hooks)", () => {
		const hooks = buildClaudeHooks(TASK_ID);

		// Each event has an array of matcher groups
		const permGroup = hooks.PermissionRequest[0];
		expect(permGroup).toHaveProperty("hooks");
		expect(permGroup.hooks).toHaveLength(1);
		expect(permGroup.hooks[0]).toHaveProperty("type", "command");
		expect(permGroup.hooks[0]).toHaveProperty("command");
	});

	it("PermissionRequest hook moves to user-questions", () => {
		const hooks = buildClaudeHooks(TASK_ID);
		const cmd = hooks.PermissionRequest[0].hooks[0].command;

		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain(TASK_ID);
		expect(cmd).toContain("--status user-questions");
	});

	it("Stop hook defaults to review-by-user with --if-status in-progress guard", () => {
		const hooks = buildClaudeHooks(TASK_ID);

		expect(hooks.Stop).toHaveLength(1);
		const cmd = hooks.Stop[0].hooks[0].command;
		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain(TASK_ID);
		expect(cmd).toContain("--status review-by-user");
		expect(cmd).toContain("--if-status in-progress");
	});

	it("Stop hook with review-by-ai stopTarget creates two matcher groups (primary + review)", () => {
		const hooks = buildClaudeHooks(TASK_ID, { stopTarget: "review-by-ai" });

		// Two Stop groups: primary agent → review-by-ai, review agent → review-by-user
		expect(hooks.Stop).toHaveLength(2);

		const primaryCmd = hooks.Stop[0].hooks[0].command;
		expect(primaryCmd).toContain("--status review-by-ai");
		expect(primaryCmd).toContain("--if-status in-progress");

		const reviewCmd = hooks.Stop[1].hooks[0].command;
		expect(reviewCmd).toContain("--status review-by-user");
		expect(reviewCmd).toContain("--if-status review-by-ai");
	});

	it("Stop hook with custom non-review-by-user stopTarget also creates two groups", () => {
		const hooks = buildClaudeHooks(TASK_ID, { stopTarget: "user-questions" });

		expect(hooks.Stop).toHaveLength(2);
		expect(hooks.Stop[0].hooks[0].command).toContain("--status user-questions");
		expect(hooks.Stop[1].hooks[0].command).toContain("--status review-by-user --if-status review-by-ai");
	});

	it("working hooks allow transition from review-by-user (user feedback resumes agent)", () => {
		const hooks = buildClaudeHooks(TASK_ID);
		const cmd = hooks.UserPromptSubmit[0].hooks[0].command;

		// review-by-user must NOT be excluded — when user leaves feedback
		// and the agent resumes, the hook should move the task back to in-progress
		expect(cmd).not.toContain("review-by-user");
		expect(cmd).toContain("--if-status-not review-by-ai");
	});

	it("working hooks use --if-status-not to skip during AI review", () => {
		const hooks = buildClaudeHooks(TASK_ID, { stopTarget: "review-by-ai" });

		const preCmd = hooks.PreToolUse[0].hooks[0].command;
		const userCmd = hooks.UserPromptSubmit[0].hooks[0].command;

		expect(preCmd).toContain("--status in-progress --if-status-not review-by-ai");
		expect(userCmd).toContain("--status in-progress --if-status-not review-by-ai");
		expect(preCmd).not.toContain("review-by-user");
		expect(userCmd).not.toContain("review-by-user");
	});

	it("all hooks use command type", () => {
		const hooks = buildClaudeHooks(TASK_ID, { stopTarget: "review-by-ai" });

		for (const groups of Object.values(hooks)) {
			for (const group of groups) {
				for (const entry of group.hooks) {
					expect(entry.type).toBe("command");
				}
			}
		}
	});
});

describe("mergeClaudeHooks", () => {
	it("adds hooks to empty settings", () => {
		const result = mergeClaudeHooks({}, TASK_ID);

		expect(result.hooks).toBeDefined();
		const hooks = result.hooks as Record<string, MatcherGroup[]>;
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
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
				PostToolUse: [{ hooks: [{ type: "command", command: "echo post" }] }],
			},
		};
		const result = mergeClaudeHooks(existing, TASK_ID);
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.PostToolUse).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("preserves non-dev3 matcher groups on the same events", () => {
		const existing = {
			hooks: {
				PermissionRequest: [{ hooks: [{ type: "command", command: "echo notify" }] }],
				Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
			},
		};
		const result = mergeClaudeHooks(existing, TASK_ID);
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		// Original matcher groups preserved + dev3 groups appended
		expect(hooks.PermissionRequest).toHaveLength(2);
		expect(hooks.Stop).toHaveLength(2);
	});

	it("is idempotent — running twice does not duplicate dev3 hooks", () => {
		const first = mergeClaudeHooks({}, TASK_ID);
		const second = mergeClaudeHooks(first as Record<string, unknown>, TASK_ID);
		const hooks = second.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("is idempotent with review-by-ai stopTarget (two Stop groups)", () => {
		const first = mergeClaudeHooks({}, TASK_ID, { stopTarget: "review-by-ai" });
		const second = mergeClaudeHooks(first as Record<string, unknown>, TASK_ID, { stopTarget: "review-by-ai" });
		const hooks = second.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.Stop).toHaveLength(2);
	});

	it("passes stopTarget through to buildClaudeHooks", () => {
		const result = mergeClaudeHooks({}, TASK_ID, { stopTarget: "review-by-ai" });
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.Stop).toHaveLength(2);
		expect(hooks.Stop[0].hooks[0].command).toContain("--status review-by-ai");
		expect(hooks.Stop[1].hooks[0].command).toContain("--status review-by-user --if-status review-by-ai");
	});

	it("replaces dev3 hooks from a different task ID", () => {
		const first = mergeClaudeHooks({}, "old-task-id");
		const second = mergeClaudeHooks(first as Record<string, unknown>, "new-task-id");
		const hooks = second.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.PermissionRequest[0].hooks[0].command).toContain("new-task-id");
		expect(hooks.PermissionRequest[0].hooks[0].command).not.toContain("old-task-id");
	});
});

describe("writeClaudeHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "agent-hooks-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("creates .claude dir and settings file from scratch", () => {
		writeClaudeHooks(tmp, TASK_ID);

		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
		expect(hooks.Stop[0].hooks[0].command).toContain(TASK_ID);
	});

	it("preserves existing settings when merging", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
		);

		writeClaudeHooks(tmp, TASK_ID);

		const content = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
		expect(content.permissions).toEqual({ allow: ["Bash(*)"] });
		expect(content.hooks).toBeDefined();
	});

	it("writes hooks with stopTarget review-by-ai (two Stop groups)", () => {
		writeClaudeHooks(tmp, TASK_ID, { stopTarget: "review-by-ai" });

		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.Stop).toHaveLength(2);
		expect(hooks.Stop[0].hooks[0].command).toContain("--status review-by-ai --if-status in-progress");
		expect(hooks.Stop[1].hooks[0].command).toContain("--status review-by-user --if-status review-by-ai");
	});

	it("writes working hooks with --if-status-not guard", () => {
		writeClaudeHooks(tmp, TASK_ID, { stopTarget: "review-by-ai" });

		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.PreToolUse[0].hooks[0].command).toContain("--if-status-not review-by-ai");
		expect(hooks.PreToolUse[0].hooks[0].command).not.toContain("review-by-user");
		expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain("--if-status-not review-by-ai");
		expect(hooks.UserPromptSubmit[0].hooks[0].command).not.toContain("review-by-user");
	});

	it("overwrites corrupted JSON gracefully", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(join(claudeDir, "settings.local.json"), "NOT VALID JSON{{{");

		writeClaudeHooks(tmp, TASK_ID);

		const content = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;
		expect(hooks.Stop).toHaveLength(1);
	});
});
