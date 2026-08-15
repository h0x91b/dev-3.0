import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
	buildClaudeHooks,
	buildCodexHooks,
	mergeClaudeHooks,
	mergeCodexHooks,
	writeClaudeHooks,
	writeCodexHooks,
} from "../agent-hooks";
import type { MatcherGroup } from "../../shared/agent-hooks";
import {
	CODEX_DEV3_HOOK_COMMAND,
	DEV3_BASH_PERMISSION,
	ensureDefaultMode,
	ensureDevPermission,
	getCodexHookTargetStatus,
	TOLERATE_APP_OFFLINE_FLAG,
} from "../../shared/agent-hooks";
import { hookCliDialect } from "../../shared/dev3-cli-path";
import { buildDev3CodexHooksBlock } from "../codex-config";

const DEV3_CLI = "~/.dev3.0/bin/dev3";

describe("buildClaudeHooks", () => {
	it("returns UserPromptSubmit, tool, PermissionRequest and Stop matcher groups", () => {
		const hooks = buildClaudeHooks();

		expect(hooks).toHaveProperty("UserPromptSubmit");
		expect(hooks).toHaveProperty("PreToolUse");
		expect(hooks).toHaveProperty("PostToolUse");
		expect(hooks).toHaveProperty("PermissionRequest");
		expect(hooks).toHaveProperty("Stop");
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PostToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("UserPromptSubmit hook moves to in-progress with --if-status-not guard", () => {
		const hooks = buildClaudeHooks();
		const cmd = hooks.UserPromptSubmit[0].hooks[0].command;

		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain("--status in-progress");
		expect(cmd).toContain("--if-status-not review-by-ai");
		expect(cmd).not.toContain("review-by-user");
	});

	it("PreToolUse hook moves to in-progress with --if-status-not guard", () => {
		const hooks = buildClaudeHooks();
		const cmd = hooks.PreToolUse[0].hooks[0].command;

		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain("--status in-progress");
		expect(cmd).toContain("--if-status-not review-by-ai");
		expect(cmd).not.toContain("review-by-user");
	});

	it("PostToolUse resumes work after AskUserQuestion receives an answer", () => {
		const hooks = buildClaudeHooks();

		expect(hooks).toHaveProperty("PostToolUse");
		const cmd = hooks.PostToolUse[0].hooks[0].command;
		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain("--status in-progress");
		expect(cmd).toContain("--if-status-not review-by-ai");
	});

	it("uses correct three-level nesting (event → matcher group → hooks)", () => {
		const hooks = buildClaudeHooks();

		// Each event has an array of matcher groups
		const permGroup = hooks.PermissionRequest[0];
		expect(permGroup).toHaveProperty("hooks");
		expect(permGroup.hooks).toHaveLength(1);
		expect(permGroup.hooks[0]).toHaveProperty("type", "command");
		expect(permGroup.hooks[0]).toHaveProperty("command");
	});

	it("PermissionRequest hook moves to user-questions", () => {
		const hooks = buildClaudeHooks();
		const cmd = hooks.PermissionRequest[0].hooks[0].command;

		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain("--status user-questions");
	});

	it("Stop hook defaults to review-by-user with --if-status in-progress guard", () => {
		const hooks = buildClaudeHooks();

		expect(hooks.Stop).toHaveLength(1);
		const cmd = hooks.Stop[0].hooks[0].command;
		expect(cmd).toContain(DEV3_CLI);
		expect(cmd).toContain("--status review-by-user");
		expect(cmd).toContain("--if-status in-progress");
		expect(cmd).not.toContain("--codex-stop-hook");
	});

	it("Stop hook with review-by-ai stopTarget creates two matcher groups (primary + review)", () => {
		const hooks = buildClaudeHooks({ stopTarget: "review-by-ai" });

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
		const hooks = buildClaudeHooks({ stopTarget: "user-questions" });

		expect(hooks.Stop).toHaveLength(2);
		expect(hooks.Stop[0].hooks[0].command).toContain("--status user-questions");
		expect(hooks.Stop[1].hooks[0].command).toContain("--status review-by-user --if-status review-by-ai");
	});

	it("working hooks allow transition from review-by-user (user feedback resumes agent)", () => {
		const hooks = buildClaudeHooks();
		const cmd = hooks.UserPromptSubmit[0].hooks[0].command;

		// review-by-user must NOT be excluded — when user leaves feedback
		// and the agent resumes, the hook should move the task back to in-progress
		expect(cmd).not.toContain("review-by-user");
		expect(cmd).toContain("--if-status-not review-by-ai");
	});

	it("working hooks use --if-status-not to skip during AI review", () => {
		const hooks = buildClaudeHooks({ stopTarget: "review-by-ai" });

		const preCmd = hooks.PreToolUse[0].hooks[0].command;
		const userCmd = hooks.UserPromptSubmit[0].hooks[0].command;

		expect(preCmd).toContain("--status in-progress --if-status-not review-by-ai");
		expect(userCmd).toContain("--status in-progress --if-status-not review-by-ai");
		expect(preCmd).not.toContain("review-by-user");
		expect(userCmd).not.toContain("review-by-user");
	});

	it("all hooks use command type", () => {
		const hooks = buildClaudeHooks({ stopTarget: "review-by-ai" });

		for (const groups of Object.values(hooks)) {
			for (const group of groups) {
				for (const entry of group.hooks) {
					expect(entry.type).toBe("command");
				}
			}
		}
	});

	it("hook commands do not contain task IDs (auto-detected from worktree context)", () => {
		const hooks = buildClaudeHooks();

		for (const groups of Object.values(hooks)) {
			for (const group of groups) {
				for (const entry of group.hooks) {
					// Either "dev3 task move --status X" or a "dev3 hook <name>" adapter
					// that reads the event from stdin — never a UUID either way.
					expect(entry.command).toMatch(/task move --status|hook claude-stop-failure/);
					expect(entry.command).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
				}
			}
		}
	});

	it("StopFailure parks the task through the dev3 hook adapter, with no matcher", () => {
		const hooks = buildClaudeHooks();

		// StopFailure fires INSTEAD of Stop when an API error killed the turn, so
		// without it a rate-limited task stays in "Agent is Working" forever.
		expect(hooks.StopFailure).toHaveLength(1);
		expect(hooks.StopFailure[0].matcher).toBeUndefined();
		expect(hooks.StopFailure[0].hooks[0].command).toContain("hook claude-stop-failure");
	});

	it("every status-move Claude hook tolerates app-offline (exit 2) without blocking the agent", () => {
		// Claude Code treats a hook exit code of 2 as a *blocking* error
		// (PreToolUse blocks the tool, UserPromptSubmit erases the prompt, Stop
		// blocks stoppage). CLI_EXIT_CODE_APP_NOT_RUNNING is also 2, so when the
		// desktop app is closed the hook must swallow exactly that code — and
		// nothing else — into success. (issue: closed app wedged Edit/Bash.)
		// `dev3 hook <name>` adapters are exempt: they own the offline case inside
		// the CLI and always exit 0.
		const hooks = buildClaudeHooks({ stopTarget: "review-by-ai" });

		for (const groups of Object.values(hooks)) {
			for (const group of groups) {
				for (const entry of group.hooks) {
					if (!entry.command.includes("task move")) continue;
					expect(entry.command).toContain("|| [ $? -eq 2 ]");
					// Never the blunt `|| true`, which would also hide real failures.
					expect(entry.command).not.toContain("|| true");
				}
			}
		}
	});

	it("working hooks keep the move guard before the offline fallback", () => {
		const hooks = buildClaudeHooks();

		for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit"] as const) {
			const cmd = hooks[event][0].hooks[0].command;
			expect(cmd).toContain("--status in-progress --if-status-not review-by-ai || [ $? -eq 2 ]");
		}
	});

	it("PermissionRequest hook also tolerates app-offline", () => {
		const hooks = buildClaudeHooks();
		const cmd = hooks.PermissionRequest[0].hooks[0].command;
		expect(cmd).toContain("--status user-questions");
		expect(cmd).toContain("|| [ $? -eq 2 ]");
	});
});

describe("mergeClaudeHooks", () => {
	it("adds hooks to empty settings", () => {
		const result = mergeClaudeHooks({});

		expect(result.hooks).toBeDefined();
		const hooks = result.hooks as Record<string, MatcherGroup[]>;
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PostToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("preserves existing non-hook settings", () => {
		const existing = { permissions: { allow: ["Bash(*)"] }, someKey: 42 };
		const result = mergeClaudeHooks(existing);

		expect(result.permissions).toEqual({ allow: ["Bash(*)"] });
		expect(result.someKey).toBe(42);
		expect(result.hooks).toBeDefined();
	});

	it("preserves user-defined hooks when a dev3 hook shares the event", () => {
		const existing = {
			hooks: {
				PostToolUse: [{ hooks: [{ type: "command", command: "echo post" }] }],
			},
		};
		const result = mergeClaudeHooks(existing);
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.PostToolUse).toHaveLength(2);
		expect(hooks.PostToolUse[0].hooks[0].command).toBe("echo post");
		expect(hooks.PostToolUse[1].hooks[0].command).toContain("--status in-progress");
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
		const result = mergeClaudeHooks(existing);
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		// Original matcher groups preserved + dev3 groups appended
		expect(hooks.PermissionRequest).toHaveLength(2);
		expect(hooks.Stop).toHaveLength(2);
	});

	it("is idempotent — running twice does not duplicate dev3 hooks", () => {
		const first = mergeClaudeHooks({});
		const second = mergeClaudeHooks(first as Record<string, unknown>);
		const hooks = second.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("is idempotent with review-by-ai stopTarget (two Stop groups)", () => {
		const first = mergeClaudeHooks({}, { stopTarget: "review-by-ai" });
		const second = mergeClaudeHooks(first as Record<string, unknown>, { stopTarget: "review-by-ai" });
		const hooks = second.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.Stop).toHaveLength(2);
	});

	it("passes stopTarget through to buildClaudeHooks", () => {
		const result = mergeClaudeHooks({}, { stopTarget: "review-by-ai" });
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.Stop).toHaveLength(2);
		expect(hooks.Stop[0].hooks[0].command).toContain("--status review-by-ai");
		expect(hooks.Stop[1].hooks[0].command).toContain("--status review-by-user --if-status review-by-ai");
	});
});

describe("buildCodexHooks", () => {
	it("returns every lifecycle event needed for automatic task status sync", () => {
		const hooks = buildCodexHooks();

		expect(hooks).toHaveProperty("SessionStart");
		expect(hooks).toHaveProperty("UserPromptSubmit");
		expect(hooks).toHaveProperty("PreToolUse");
		expect(hooks).toHaveProperty("PermissionRequest");
		expect(hooks).toHaveProperty("PostToolUse");
		expect(hooks).toHaveProperty("Stop");
		expect(hooks.SessionStart).toHaveLength(1);
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.PostToolUse).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("SessionStart uses the startup|resume matcher", () => {
		const hooks = buildCodexHooks();
		const group = hooks.SessionStart[0];

		expect(group.matcher).toBe("startup|resume");
	});

	it("tool hooks cover Bash, apply_patch aliases, and MCP tools", () => {
		const hooks = buildCodexHooks();
		const matcher = "Bash|Edit|Write|^apply_patch$|^mcp__.*";

		expect(hooks.PreToolUse[0].matcher).toBe(matcher);
		expect(hooks.PermissionRequest[0].matcher).toBe(matcher);
		expect(hooks.PostToolUse[0].matcher).toBe(matcher);
	});

	it("every event calls one stable worktree-local handler", () => {
		const hooks = buildCodexHooks();

		for (const groups of Object.values(hooks)) {
			for (const group of groups) {
				expect(group.hooks).toEqual([
					{ type: "command", command: CODEX_DEV3_HOOK_COMMAND, timeout: 5 },
				]);
			}
		}
	});

	it("uses one Stop handler so concurrent hook execution cannot skip AI review", () => {
		const hooks = buildCodexHooks();

		expect(hooks.Stop).toHaveLength(1);
		expect(hooks.Stop[0].hooks[0]).toEqual({
			type: "command",
			command: CODEX_DEV3_HOOK_COMMAND,
			timeout: 5,
		});
	});
});

describe("getCodexHookTargetStatus", () => {
	it.each([
		["SessionStart", "review-by-user", true, "in-progress"],
		["UserPromptSubmit", "in-progress", false, "in-progress"],
		["PreToolUse", "user-questions", false, "in-progress"],
		["PostToolUse", "user-questions", false, "in-progress"],
		["PermissionRequest", "in-progress", false, "user-questions"],
		["Stop", "in-progress", false, "review-by-user"],
		["Stop", "in-progress", true, "review-by-ai"],
		["Stop", "review-by-ai", true, "review-by-user"],
	] as const)("maps %s from %s (auto-review=%s)", (event, current, autoReview, expected) => {
		expect(getCodexHookTargetStatus(event, current, autoReview)).toBe(expected);
	});

	it("preserves AI review while its agent is working", () => {
		expect(getCodexHookTargetStatus("PreToolUse", "review-by-ai", true)).toBeNull();
	});

	// A scratch task launches parked in user-questions with no prompt. Codex
	// fires SessionStart at startup, which must not claim the task is working —
	// only a real prompt may.
	it("leaves a task parked in user-questions when the session starts", () => {
		expect(getCodexHookTargetStatus("SessionStart", "user-questions", false)).toBeNull();
	});

	it("resumes the remembered status when the session starts after an approval", () => {
		expect(getCodexHookTargetStatus("SessionStart", "user-questions", false, "in-progress"))
			.toBe("in-progress");
	});

	it.each(["todo", "user-questions", "review-by-user"] as const)(
		"does not overwrite %s when a turn stops",
		(status) => {
			expect(getCodexHookTargetStatus("Stop", status, true)).toBeNull();
		},
	);

	it.each(["completed", "cancelled"] as const)("never reopens terminal status %s", (status) => {
		expect(getCodexHookTargetStatus("UserPromptSubmit", status, true)).toBeNull();
	});
});

describe("mergeCodexHooks", () => {
	it("adds hooks to empty settings", () => {
		const result = mergeCodexHooks({});

		expect(result.hooks).toBeDefined();
		const hooks = result.hooks as Record<string, MatcherGroup[]>;
		expect(hooks.SessionStart).toHaveLength(1);
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.PostToolUse).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("preserves existing hooks when adding dev3 to the same event", () => {
		const existing = {
			hooks: {
				PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo post" }] }],
			},
		};
		const result = mergeCodexHooks(existing);
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.PostToolUse).toHaveLength(2);
		expect(hooks.SessionStart).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("preserves non-dev3 matcher groups on the same events", () => {
		const existing = {
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo audit" }] }],
				Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
			},
		};
		const result = mergeCodexHooks(existing);
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.PreToolUse).toHaveLength(2);
		expect(hooks.Stop).toHaveLength(2);
	});

	it("is idempotent", () => {
		const first = mergeCodexHooks({});
		const second = mergeCodexHooks(first as Record<string, unknown>);
		const hooks = second.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.SessionStart).toHaveLength(1);
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.PostToolUse).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
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
		writeClaudeHooks(tmp);

		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
		expect(hooks.Stop[0].hooks[0].command).toContain("task move --status");
		expect(content.permissions.allow).toContain(DEV3_BASH_PERMISSION);
	});

	it("preserves existing settings when merging", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
		);

		writeClaudeHooks(tmp);

		const content = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
		expect(content.permissions.allow).toContain("Bash(*)");
		expect(content.permissions.allow).toContain(DEV3_BASH_PERMISSION);
		expect(content.hooks).toBeDefined();
	});

	it("writes hooks with stopTarget review-by-ai (two Stop groups)", () => {
		writeClaudeHooks(tmp, { stopTarget: "review-by-ai" });

		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.Stop).toHaveLength(2);
		expect(hooks.Stop[0].hooks[0].command).toContain("--status review-by-ai --if-status in-progress");
		expect(hooks.Stop[1].hooks[0].command).toContain("--status review-by-user --if-status review-by-ai");
	});

	it("writes working hooks with --if-status-not guard", () => {
		writeClaudeHooks(tmp, { stopTarget: "review-by-ai" });

		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.PreToolUse[0].hooks[0].command).toContain("--if-status-not review-by-ai");
		expect(hooks.PreToolUse[0].hooks[0].command).not.toContain("review-by-user");
		expect(hooks.PostToolUse[0].hooks[0].command).toContain("--if-status-not review-by-ai");
		expect(hooks.PostToolUse[0].hooks[0].command).not.toContain("review-by-user");
		expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain("--if-status-not review-by-ai");
		expect(hooks.UserPromptSubmit[0].hooks[0].command).not.toContain("review-by-user");
	});

	it("adds permission to settings.json when settings.local.json does not exist", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.json"),
			JSON.stringify({ permissions: { allow: ["Read(*)"] } }),
		);

		writeClaudeHooks(tmp);

		// Permission goes to settings.json (existing file)
		const shared = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
		expect(shared.permissions.allow).toContain("Read(*)");
		expect(shared.permissions.allow).toContain(DEV3_BASH_PERMISSION);

		// Hooks go to settings.local.json (always)
		const local = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
		expect(local.hooks).toBeDefined();
		// settings.local.json should NOT have the permission (it went to settings.json)
		expect(local.permissions).toBeUndefined();
	});

	it("adds permission to settings.local.json when both files exist", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ permissions: { allow: ["Read(*)"] } }));
		writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({ someKey: true }));

		writeClaudeHooks(tmp);

		// Permission goes to settings.local.json (takes priority)
		const local = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
		expect(local.permissions.allow).toContain(DEV3_BASH_PERMISSION);
		expect(local.someKey).toBe(true);
		expect(local.hooks).toBeDefined();

		// settings.json stays untouched
		const shared = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
		expect(shared.permissions.allow).toEqual(["Read(*)"]);
	});

	it("creates settings.local.json with permission when no settings files exist", () => {
		writeClaudeHooks(tmp);

		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(content.permissions.allow).toContain(DEV3_BASH_PERMISSION);
		expect(content.hooks).toBeDefined();
	});

	it("does not duplicate permission on repeated writes", () => {
		writeClaudeHooks(tmp);
		writeClaudeHooks(tmp);

		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const count = content.permissions.allow.filter((p: string) => p === DEV3_BASH_PERMISSION).length;
		expect(count).toBe(1);
	});

	it("overwrites corrupted JSON gracefully", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(join(claudeDir, "settings.local.json"), "NOT VALID JSON{{{");

		writeClaudeHooks(tmp);

		const content = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;
		expect(hooks.Stop).toHaveLength(1);
	});

	// A settings.local.json Claude Code wrote itself carries permissions.allow and
	// enabledMcpjsonServers and no hooks key at all — the shape a worktree ends up
	// with after the agent answers a permission or .mcp.json prompt.
	it("installs hooks into a settings.local.json Claude Code wrote itself", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			JSON.stringify({
				permissions: { allow: ["WebFetch(domain:developers.openai.com)", "Bash(gh:*)"] },
				enabledMcpjsonServers: ["local-trino", "playwright"],
			}, null, 2),
		);

		writeClaudeHooks(tmp, { permissionMode: "auto" });

		const content = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;
		expect(Object.keys(hooks)).toEqual([
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"PermissionRequest",
			"Stop",
			"StopFailure",
		]);
		expect(content.permissions.allow).toEqual([
			"WebFetch(domain:developers.openai.com)",
			"Bash(gh:*)",
			DEV3_BASH_PERMISSION,
		]);
		expect(content.permissions.defaultMode).toBe("auto");
		expect(content.enabledMcpjsonServers).toEqual(["local-trino", "playwright"]);
	});

	// Claude Code rewrites settings.local.json from its own in-memory snapshot, so
	// a snapshot taken before the hooks landed drops them. The next agent launch
	// runs setupAgentHooks again and must put them back.
	it("restores hooks after an external writer replaced the file without them", () => {
		writeClaudeHooks(tmp);
		const settingsPath = join(tmp, ".claude", "settings.local.json");

		writeFileSync(
			settingsPath,
			JSON.stringify({
				permissions: { allow: ["Bash(gh:*)"] },
				enabledMcpjsonServers: ["playwright"],
			}, null, 2),
		);

		writeClaudeHooks(tmp);

		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(content.hooks?.Stop).toHaveLength(1);
		expect(content.enabledMcpjsonServers).toEqual(["playwright"]);
	});

	it("produces identical output on repeated writes (no task-specific content)", () => {
		writeClaudeHooks(tmp);
		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const first = readFileSync(settingsPath, "utf-8");

		writeClaudeHooks(tmp);
		const second = readFileSync(settingsPath, "utf-8");

		expect(first).toBe(second);
	});

	// --- permissions.defaultMode (teammate auto-approve propagation) ---

	it("writes permissions.defaultMode into settings.local.json for a non-default mode", () => {
		writeClaudeHooks(tmp, { permissionMode: "bypassPermissions" });

		const settingsPath = join(tmp, ".claude", "settings.local.json");
		const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(content.permissions.defaultMode).toBe("bypassPermissions");
		// hooks + dev3 permission still present alongside defaultMode
		expect(content.hooks).toBeDefined();
		expect(content.permissions.allow).toContain(DEV3_BASH_PERMISSION);
	});

	it("propagates the 'auto' mode (default dev3 config) so teammates inherit it", () => {
		writeClaudeHooks(tmp, { permissionMode: "auto" });

		const content = JSON.parse(
			readFileSync(join(tmp, ".claude", "settings.local.json"), "utf-8"),
		);
		expect(content.permissions.defaultMode).toBe("auto");
	});

	it("does NOT write defaultMode when no permissionMode is given", () => {
		writeClaudeHooks(tmp);

		const content = JSON.parse(
			readFileSync(join(tmp, ".claude", "settings.local.json"), "utf-8"),
		);
		expect(content.permissions?.defaultMode).toBeUndefined();
	});

	it("does NOT write defaultMode for the 'default' mode (no-op baseline)", () => {
		writeClaudeHooks(tmp, { permissionMode: "default" });

		const content = JSON.parse(
			readFileSync(join(tmp, ".claude", "settings.local.json"), "utf-8"),
		);
		expect(content.permissions?.defaultMode).toBeUndefined();
	});

	it("keeps defaultMode in settings.local.json even when permission goes to settings.json", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		// Only settings.json exists → dev3 permission lands there, not in local.
		writeFileSync(
			join(claudeDir, "settings.json"),
			JSON.stringify({ permissions: { allow: ["Read(*)"] } }),
		);

		writeClaudeHooks(tmp, { permissionMode: "acceptEdits" });

		// defaultMode must be local-scoped (gitignored), never the committed file.
		const local = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
		expect(local.permissions.defaultMode).toBe("acceptEdits");
		const shared = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8"));
		expect(shared.permissions.defaultMode).toBeUndefined();
	});

	it("preserves an existing defaultMode-bearing file's other keys", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			JSON.stringify({ enableAllProjectMcpServers: true, permissions: { allow: ["Bash(ls:*)"] } }),
		);

		writeClaudeHooks(tmp, { permissionMode: "dontAsk" });

		const content = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
		expect(content.enableAllProjectMcpServers).toBe(true);
		expect(content.permissions.allow).toContain("Bash(ls:*)");
		expect(content.permissions.allow).toContain(DEV3_BASH_PERMISSION);
		expect(content.permissions.defaultMode).toBe("dontAsk");
	});
});

describe("ensureDefaultMode", () => {
	it("sets permissions.defaultMode on an empty object", () => {
		const result = ensureDefaultMode({}, "bypassPermissions");
		expect((result.permissions as Record<string, unknown>).defaultMode).toBe("bypassPermissions");
	});

	it("preserves existing permission allow/deny lists", () => {
		const result = ensureDefaultMode(
			{ permissions: { allow: ["Bash(git:*)"], deny: ["Read(secret)"] } },
			"acceptEdits",
		);
		const perms = result.permissions as Record<string, unknown>;
		expect(perms.allow).toEqual(["Bash(git:*)"]);
		expect(perms.deny).toEqual(["Read(secret)"]);
		expect(perms.defaultMode).toBe("acceptEdits");
	});

	it("is idempotent and overwrites a stale mode", () => {
		const once = ensureDefaultMode({}, "plan");
		const twice = ensureDefaultMode(once, "auto");
		expect((twice.permissions as Record<string, unknown>).defaultMode).toBe("auto");
	});
});

describe("writeCodexHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "agent-hooks-codex-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("creates a worktree-local hooks file from scratch", () => {
		writeCodexHooks(tmp);

		const hooksPath = join(tmp, ".codex", "hooks.json");
		const content = JSON.parse(readFileSync(hooksPath, "utf-8"));
		const hooks = content.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.SessionStart).toHaveLength(1);
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.PreToolUse).toHaveLength(1);
		expect(hooks.PermissionRequest).toHaveLength(1);
		expect(hooks.PostToolUse).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
	});

	it("preserves existing non-hook settings when merging", () => {
		mkdirSync(join(tmp, ".codex"), { recursive: true });
		writeFileSync(join(tmp, ".codex", "hooks.json"), JSON.stringify({ version: 1 }));

		writeCodexHooks(tmp);

		const content = JSON.parse(readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8"));
		expect(content.version).toBe(1);
		expect(content.hooks).toBeDefined();
	});

	it("replaces a corrupted generated worktree hooks file", () => {
		mkdirSync(join(tmp, ".codex"), { recursive: true });
		writeFileSync(join(tmp, ".codex", "hooks.json"), "NOT VALID JSON{{{");

		writeCodexHooks(tmp);

		expect(JSON.parse(readFileSync(join(tmp, ".codex", "hooks.json"), "utf-8"))).toHaveProperty("hooks.Stop");
	});

	it("produces identical output on repeated writes", () => {
		writeCodexHooks(tmp);
		const hooksPath = join(tmp, ".codex", "hooks.json");
		const first = readFileSync(hooksPath, "utf-8");

		writeCodexHooks(tmp);
		const second = readFileSync(hooksPath, "utf-8");

		expect(first).toBe(second);
	});
});

// ---------------------------------------------------------------------------
// Platform dialects: the POSIX strings are frozen (older dev3 builds read the
// same worktree files), Windows must be shell-free and tilde-free.
// ---------------------------------------------------------------------------

const WIN_SPACES = hookCliDialect({
	platform: "win32",
	execDir: "C:\\Program Files\\dev3\\bin",
	homeDir: "C:\\Users\\John Doe",
	exists: () => false,
});

const WIN_PLAIN = hookCliDialect({
	platform: "win32",
	execDir: "C:\\dev3",
	homeDir: "C:\\Users\\dev",
	exists: () => false,
});

function everyCommand(hooks: Record<string, MatcherGroup[]>): string[] {
	return Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((h) => h.command)));
}

describe("POSIX hook output (byte-identical contract)", () => {
	const posix = hookCliDialect({ platform: "darwin" });

	it("renders the exact Claude command strings", () => {
		const hooks = buildClaudeHooks({ stopTarget: "review-by-ai", dialect: posix });
		const working = `${DEV3_CLI} task move --status in-progress --if-status-not review-by-ai || [ $? -eq 2 ]`;

		expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe(working);
		expect(hooks.PreToolUse[0].hooks[0].command).toBe(working);
		expect(hooks.PostToolUse[0].hooks[0].command).toBe(working);
		expect(hooks.PermissionRequest[0].hooks[0].command).toBe(
			`${DEV3_CLI} task move --status user-questions || [ $? -eq 2 ]`,
		);
		expect(hooks.Stop[0].hooks[0].command).toBe(
			`${DEV3_CLI} task move --status review-by-ai --if-status in-progress || [ $? -eq 2 ]`,
		);
		expect(hooks.Stop[1].hooks[0].command).toBe(
			`${DEV3_CLI} task move --status review-by-user --if-status review-by-ai || [ $? -eq 2 ]`,
		);
	});

	it("renders the exact Codex handler command", () => {
		expect(buildCodexHooks({ dialect: posix }).Stop[0].hooks[0].command).toBe("~/.dev3.0/bin/dev3 hook codex");
	});

	it("never carries the Windows tolerance flag", () => {
		for (const command of everyCommand(buildClaudeHooks({ stopTarget: "review-by-ai", dialect: posix }))) {
			expect(command).not.toContain(TOLERATE_APP_OFFLINE_FLAG);
		}
	});

	it("is what the default (this machine) dialect produces", () => {
		expect(buildClaudeHooks({ stopTarget: "review-by-ai", dialect: posix })).toEqual(
			buildClaudeHooks({ stopTarget: "review-by-ai" }),
		);
		expect(buildCodexHooks({ dialect: posix })).toEqual(buildCodexHooks());
	});
});

describe("Windows hook output", () => {
	it("renders the exact Claude command strings", () => {
		const hooks = buildClaudeHooks({ stopTarget: "review-by-ai", dialect: WIN_SPACES });
		const cli = WIN_SPACES.cli;
		expect(cli).toBe('"C:/Users/John Doe/.dev3.0/bin/dev3.exe"');
		const working = `${cli} task move --status in-progress --if-status-not review-by-ai --tolerate-app-offline`;

		expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe(working);
		expect(hooks.PreToolUse[0].hooks[0].command).toBe(working);
		expect(hooks.PostToolUse[0].hooks[0].command).toBe(working);
		expect(hooks.PermissionRequest[0].hooks[0].command).toBe(
			`${cli} task move --status user-questions --tolerate-app-offline`,
		);
		expect(hooks.Stop[0].hooks[0].command).toBe(
			`${cli} task move --status review-by-ai --if-status in-progress --tolerate-app-offline`,
		);
		expect(hooks.Stop[1].hooks[0].command).toBe(
			`${cli} task move --status review-by-user --if-status review-by-ai --tolerate-app-offline`,
		);
	});

	it("renders the exact Codex handler command (no tolerance flag — the subcommand always exits 0)", () => {
		expect(buildCodexHooks({ dialect: WIN_SPACES }).Stop[0].hooks[0].command).toBe(
			`${WIN_SPACES.cli} hook codex`,
		);
	});

	it("emits no tilde, no shell operators and no redirects in either hook map", () => {
		const commands = [
			...everyCommand(buildClaudeHooks({ stopTarget: "review-by-ai", dialect: WIN_SPACES })),
			...everyCommand(buildCodexHooks({ dialect: WIN_SPACES })),
		];
		expect(commands.length).toBeGreaterThan(6);

		for (const command of commands) {
			expect(command).not.toContain("~");
			expect(command).not.toContain("&&");
			expect(command).not.toContain("||");
			expect(command).not.toContain(";");
			expect(command).not.toContain("$?");
			expect(command).not.toContain("2>&1");
		}
	});

	it("starts every command with an absolute path to dev3.exe", () => {
		const commands = [
			...everyCommand(buildClaudeHooks({ stopTarget: "review-by-ai", dialect: WIN_PLAIN })),
			...everyCommand(buildCodexHooks({ dialect: WIN_PLAIN })),
		];

		for (const command of commands) {
			const [binary] = command.split(" ");
			expect(binary).toBe('"C:/Users/dev/.dev3.0/bin/dev3.exe"');
			// Quoted, forward-slashed, and still an absolute drive path: bash strips a
			// bare backslash, so the drive letter must be followed by "/" here.
			const bare = binary.replaceAll('"', "");
			expect(bare.endsWith("dev3.exe")).toBe(true);
			expect(isAbsolute(bare) || /^[A-Za-z]:\//.test(bare)).toBe(true);
		}
	});

	it("keeps the Codex hook command free of tildes and shell operators", () => {
		// The command lands in a TOML file and is executed by codex directly, with
		// no shell to expand `~` or honour `||` — a Windows hook has neither.
		const block = buildDev3CodexHooksBlock({ dialect: WIN_SPACES });

		// TOML basic strings escape the backslashes; the decoded command is absolute.
		expect(block).toContain(JSON.stringify(`${WIN_SPACES.cli} hook codex`));
		expect(block).not.toContain("~");
		expect(block).not.toContain("||");
		expect(block).not.toContain("&&");
		expect(block).not.toContain("$?");
		expect(block).not.toContain("2>&1");
	});

	it("still recognizes and replaces dev3 entries written by a POSIX dev3", () => {
		const existing = {
			hooks: {
				PreToolUse: [
					{ hooks: [{ type: "command", command: `${DEV3_CLI} task move --status in-progress` }] },
					{ hooks: [{ type: "command", command: "echo mine" }] },
				],
			},
		};

		const merged = mergeClaudeHooks(existing, { dialect: WIN_SPACES }) as {
			hooks: Record<string, MatcherGroup[]>;
		};
		const commands = merged.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));

		expect(commands).toContain("echo mine");
		expect(commands.some((c) => c.includes("dev3.exe"))).toBe(true);
		expect(commands.some((c) => c.includes("~/.dev3.0/bin/dev3"))).toBe(false);
	});

	it("replaces the bare-backslash spelling an earlier build wrote (bash ate the separators)", () => {
		const broken = "C:\\Users\\John Doe\\.dev3.0\\bin\\dev3.exe task move --status in-progress";
		const existing = {
			hooks: { PreToolUse: [{ hooks: [{ type: "command", command: broken }] }] },
		};

		const merged = mergeClaudeHooks(existing, { dialect: WIN_SPACES }) as {
			hooks: Record<string, MatcherGroup[]>;
		};
		const commands = merged.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));

		expect(commands).not.toContain(broken);
		expect(commands.every((c) => !c.includes("\\"))).toBe(true);
		expect(commands.some((c) => c.startsWith(WIN_SPACES.cli))).toBe(true);
	});
});

// A settings file is hand-edited and also rewritten by the agent itself, so any
// slot can hold a shape the merge does not expect. None of these may throw: the
// caller (applyAgentHooksToCommand) swallows the error and launches the agent
// with no hooks at all, which looks exactly like "dev3 hooks did not fire".
describe("mergeClaudeHooks with malformed settings", () => {
	const hookEvents = (result: unknown) =>
		Object.keys((result as { hooks: Record<string, unknown> }).hooks);
	const DEV3_EVENTS = [
		"UserPromptSubmit",
		"PreToolUse",
		"PostToolUse",
		"PermissionRequest",
		"Stop",
		"StopFailure",
	];

	it.each([
		["hooks is an array", { hooks: [{ type: "command", command: "x" }] }],
		["hooks is a string", { hooks: "nope" }],
		["hooks is null", { hooks: null }],
		["hooks is a number", { hooks: 7 }],
		["an event holds a matcher group instead of an array", { hooks: { PreToolUse: { hooks: [] } } }],
		["an event holds a string", { hooks: { PreToolUse: "x" } }],
		["an event holds null", { hooks: { Stop: null } }],
	])("installs every dev3 event when %s", (_label, existing) => {
		const merged = mergeClaudeHooks(existing as Record<string, unknown>);
		expect(hookEvents(merged)).toEqual(expect.arrayContaining(DEV3_EVENTS));
	});

	it("does not leak numeric keys from a spread string or array", () => {
		for (const existing of [{ hooks: "nope" }, { hooks: ["a", "b"] }]) {
			const merged = mergeClaudeHooks(existing as Record<string, unknown>);
			expect(hookEvents(merged)).toEqual(DEV3_EVENTS);
		}
	});

	it.each([
		["the root is null", null],
		["the root is an array", [1, 2, 3]],
		["the root is a number", 42],
		["the root is a string", "settings"],
	])("installs hooks when %s", (_label, existing) => {
		const merged = mergeClaudeHooks(existing as unknown as Record<string, unknown>);
		expect(hookEvents(merged)).toEqual(DEV3_EVENTS);
	});

	it("keeps a user hook on an event dev3 also writes, even next to a broken sibling", () => {
		const userHook = { hooks: [{ type: "command", command: ".claude/hooks/auto-approve.sh" }] };
		const merged = mergeClaudeHooks({
			hooks: { PreToolUse: [userHook], Stop: "broken" },
		}) as { hooks: Record<string, MatcherGroup[]> };

		expect(merged.hooks.PreToolUse[0]).toEqual(userHook);
		expect(merged.hooks.Stop).toHaveLength(1);
	});

	it("leaves an unrelated event alone even when its value is malformed", () => {
		const merged = mergeClaudeHooks({
			hooks: { SessionEnd: "whatever" },
		}) as { hooks: Record<string, unknown> };

		expect(merged.hooks.SessionEnd).toBe("whatever");
	});

	it("drops a malformed group without dropping the rest of the event", () => {
		const merged = mergeClaudeHooks({
			hooks: { PreToolUse: [null, "x", { hooks: "not-an-array" }] },
		}) as { hooks: Record<string, unknown[]> };

		// Nothing here mentions dev3, so all three survive, and dev3 is appended.
		expect(merged.hooks.PreToolUse).toHaveLength(4);
	});

	it("tolerates a non-string command inside an otherwise valid group", () => {
		const merged = mergeClaudeHooks({
			hooks: { Stop: [{ hooks: [{ type: "command", command: 42 }] }, { hooks: [null] }] },
		}) as { hooks: Record<string, unknown[]> };

		expect(merged.hooks.Stop).toHaveLength(3);
	});

	it("replaces an old dev3 hook stored in the legacy flat format", () => {
		const merged = mergeClaudeHooks({
			hooks: { Stop: [{ type: "command", command: `${DEV3_CLI} task move --status review-by-user` }] },
		}) as { hooks: Record<string, unknown[]> };

		expect(merged.hooks.Stop).toHaveLength(1);
	});
});

describe("ensureDevPermission / ensureDefaultMode with malformed settings", () => {
	it.each([
		["permissions is a string", { permissions: "all" }],
		["permissions is an array", { permissions: ["a"] }],
		["permissions is null", { permissions: null }],
		["permissions is a number", { permissions: 1 }],
	])("writes a clean permissions object when %s", (_label, settings) => {
		const result = ensureDevPermission(settings as Record<string, unknown>) as {
			permissions: Record<string, unknown>;
		};
		expect(Object.keys(result.permissions)).toEqual(["allow"]);
		expect(result.permissions.allow).toEqual([DEV3_BASH_PERMISSION]);
	});

	it("replaces a non-array allow rather than throwing", () => {
		const result = ensureDevPermission({ permissions: { allow: "Bash(gh:*)" } }) as {
			permissions: { allow: string[] };
		};
		expect(result.permissions.allow).toEqual([DEV3_BASH_PERMISSION]);
	});

	it("keeps sibling permission keys", () => {
		const result = ensureDevPermission({
			permissions: { allow: ["Bash(gh:*)"], deny: ["Bash(rm:*)"], defaultMode: "auto" },
		}) as { permissions: Record<string, unknown> };

		expect(result.permissions.deny).toEqual(["Bash(rm:*)"]);
		expect(result.permissions.defaultMode).toBe("auto");
		expect(result.permissions.allow).toEqual(["Bash(gh:*)", DEV3_BASH_PERMISSION]);
	});

	it.each([
		["the root is null", null],
		["the root is an array", []],
	])("does not throw when %s", (_label, settings) => {
		expect(() => ensureDevPermission(settings as unknown as Record<string, unknown>)).not.toThrow();
		expect(() => ensureDefaultMode(settings as unknown as Record<string, unknown>, "auto")).not.toThrow();
	});
});

describe("writeClaudeHooks with a hostile file on disk", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "dev3-hooks-hostile-"));
		mkdirSync(join(tmp, ".claude"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const settingsPath = () => join(tmp, ".claude", "settings.local.json");
	const read = () => JSON.parse(readFileSync(settingsPath(), "utf-8"));

	it("survives a UTF-8 byte-order mark and keeps the user's keys", () => {
		writeFileSync(
			settingsPath(),
			"﻿" + JSON.stringify({ permissions: { allow: ["Bash(gh:*)"] } }),
		);

		writeClaudeHooks(tmp);

		const content = read();
		expect(content.hooks?.Stop).toHaveLength(1);
		expect(content.permissions.allow).toEqual(["Bash(gh:*)", DEV3_BASH_PERMISSION]);
	});

	it("installs hooks over a file whose hooks key is the wrong shape", () => {
		writeFileSync(
			settingsPath(),
			JSON.stringify({ enabledMcpjsonServers: ["playwright"], hooks: { PreToolUse: {} } }),
		);

		writeClaudeHooks(tmp);

		const content = read();
		expect(content.hooks.PreToolUse).toHaveLength(1);
		expect(content.enabledMcpjsonServers).toEqual(["playwright"]);
	});

	it("installs hooks over a file that parses to a non-object", () => {
		writeFileSync(settingsPath(), "[1,2,3]");

		writeClaudeHooks(tmp);

		const content = read();
		expect(content.hooks?.Stop).toHaveLength(1);
		expect(content["0"]).toBeUndefined();
	});

	it("installs hooks over an empty file", () => {
		writeFileSync(settingsPath(), "");

		writeClaudeHooks(tmp);

		expect(read().hooks?.Stop).toHaveLength(1);
	});

	it("does not write the dev3 permission into a malformed shared settings.json", () => {
		writeFileSync(join(tmp, ".claude", "settings.json"), "null");

		writeClaudeHooks(tmp);

		const shared = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"));
		expect(shared.permissions.allow).toEqual([DEV3_BASH_PERMISSION]);
		expect(read().hooks?.Stop).toHaveLength(1);
	});
});

// Claude Code holds settings.local.json open, so the periodic re-assertion in
// agent-hooks-refresh.ts must not churn its mtime when nothing changed.
describe("writeClaudeHooks write suppression", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "dev3-hooks-idem-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const settingsPath = () => join(tmp, ".claude", "settings.local.json");

	it("reports a write on the first install and none on the second", () => {
		expect(writeClaudeHooks(tmp)).toBe(true);
		expect(writeClaudeHooks(tmp)).toBe(false);
	});

	it("leaves the file untouched when nothing changed", () => {
		writeClaudeHooks(tmp);
		const before = statSync(settingsPath()).mtimeMs;

		writeClaudeHooks(tmp);

		expect(statSync(settingsPath()).mtimeMs).toBe(before);
	});

	it("writes again once an external rewrite dropped the hooks", () => {
		writeClaudeHooks(tmp);
		writeFileSync(settingsPath(), JSON.stringify({ permissions: { allow: ["Bash(gh:*)"] } }));

		expect(writeClaudeHooks(tmp)).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath(), "utf-8")).hooks?.Stop).toHaveLength(1);
	});

	it("writes again when the stop target changes", () => {
		writeClaudeHooks(tmp, { stopTarget: "review-by-user" });
		expect(writeClaudeHooks(tmp, { stopTarget: "review-by-ai" })).toBe(true);
	});

	// With only a shared settings.json present, the permission lands there and the
	// hooks create settings.local.json. From the second run on, the local file
	// exists and owns the permission too, so that run still writes — the third is
	// the first quiet one.
	it("settles after the shared settings.json hands the permission over to the local one", () => {
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		writeFileSync(join(tmp, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: [] } }));

		expect(writeClaudeHooks(tmp)).toBe(true);
		expect(writeClaudeHooks(tmp)).toBe(true);
		expect(writeClaudeHooks(tmp)).toBe(false);

		const shared = JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8"));
		expect(shared.permissions.allow).toEqual([DEV3_BASH_PERMISSION]);
	});
});
