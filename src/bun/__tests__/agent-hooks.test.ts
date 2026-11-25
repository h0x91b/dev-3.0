import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
	buildClaudeHooks,
	buildCodexHooks,
	mergeClaudeHooks,
	mergeCodexHooks,
	writeClaudeHooks,
	writeCodexHooks,
} from "../agent-hooks";
import { ensureParentClaudeMdExcluded, isDev3OwnedFolder, type MatcherGroup } from "../../shared/agent-hooks";
import { getPrimaryStopTarget, type TaskStatus } from "../../shared/types";
import {
	CODEX_DEV3_HOOK_COMMAND,
	dev3BashPermissions,
	ensureDefaultMode,
	ensureDevPermission,
	getAgentHookTargetStatus,
	isBroadDev3Rule,
	TOLERATE_APP_OFFLINE_FLAG,
	claudeSessionStartHookInstalled,
} from "../../shared/agent-hooks";
import { hookCliDialect } from "../../shared/dev3-cli-path";
import { buildDev3CodexHooksBlock } from "../codex-config";

const DEV3_CLI = "~/.dev3.0/bin/dev3";
/** One representative metadata rule from the injected allowlist. */
const DEV3_BASH_PERMISSION = "Bash(dev3 note *)";

const CLAUDE_CORE_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"] as const;
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"] as const;

function expectOneGroupPerEvent(hooks: Record<string, MatcherGroup[]>, events: readonly string[]) {
	for (const event of events) expect(hooks[event], event).toHaveLength(1);
}

describe("buildClaudeHooks", () => {
	it.each([2, 1])("an older offline CLI exit %s cannot accidentally block tool or Stop hooks", exitCode => {
		const hooks = buildClaudeHooks({ dialect: { cli: `sh -c 'exit ${exitCode}' --`, posixShell: true } });
		for (const event of ["PreToolUse", "Stop"] as const) {
			const result = spawnSync("sh", ["-c", hooks[event][0].hooks[0].command]);
			expect(result.status).toBe(exitCode === 2 ? 0 : 1);
		}
	});

	it("builds one atomic adapter group per event, with the observation-only events exact", () => {
		const hooks = buildClaudeHooks();
		expectOneGroupPerEvent(hooks, CLAUDE_CORE_EVENTS);

		// SessionStart only injects recent notes, on fresh conversations, and never moves status.
		expect(hooks.SessionStart).toEqual([{
			matcher: "startup|clear|compact",
			hooks: [{ type: "command", command: `${DEV3_CLI} hook claude-session-start`, timeout: 5 }],
		}]);
		expect(hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: `${DEV3_CLI} hook claude-prompt`, timeout: 5 }] }]);
		// PostToolUse has no hook timeout of its own.
		expect(hooks.PostToolUse[0].hooks[0].timeout).toBeUndefined();
		// Idle notifications are not questions.
		expect(hooks.Notification).toEqual([{
			matcher: "permission_prompt|elicitation_dialog",
			hooks: [{ type: "command", command: `${DEV3_CLI} hook claude-pre-tool || [ $? -eq 2 ]`, timeout: 5 }],
		}]);
		expect(hooks.Stop[0].hooks[0].command, "default stop target").toContain("--stop-target review-by-user");
		expect(hooks.SessionEnd).toEqual([{
			hooks: [{ type: "command", command: `${DEV3_CLI} hook claude-turn-ended`, timeout: 5 }],
		}]);
		// StopFailure fires INSTEAD of Stop when an API error killed the turn, so
		// without it a rate-limited task stays in "Agent is Working" forever.
		expect(hooks.StopFailure).toHaveLength(1);
		expect(hooks.StopFailure[0].matcher).toBeUndefined();
		expect(hooks.StopFailure[0].hooks[0].command).toContain("hook claude-stop-failure");
		// review-by-user must not be excluded: user feedback resumes the agent.
		expect(hooks.PreToolUse[0].hooks[0].command).not.toContain("review-by-user");
		expect(hooks.UserPromptSubmit[0].hooks[0].command).not.toContain("review-by-user");
	});

	it("Stop uses one atomic adapter carrying the configured stop target", () => {
		for (const stopTarget of ["review-by-user", "review-by-ai", "user-questions"] as const) {
			expect(buildClaudeHooks({ stopTarget }).Stop, stopTarget).toEqual([{
				hooks: [{
					type: "command",
					command: `${DEV3_CLI} hook claude-turn-ended --stop-target ${stopTarget} || [ $? -eq 2 ]`,
					timeout: 5,
				}],
			}]);
		}
	});

	it("every hook is a task-id-free command, and status hooks tolerate only app-offline", () => {
		const hooks = buildClaudeHooks({ stopTarget: "review-by-ai" });
		for (const groups of Object.values(hooks)) {
			for (const group of groups) {
				for (const entry of group.hooks) {
					expect(entry.type).toBe("command");
					expect(entry.command).toMatch(/task move --status|hook claude-stop-failure|hook claude-prompt|hook claude-session-start|hook claude-turn-ended|hook claude-post-tool|hook claude-pre-tool/);
					expect(entry.command).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
				}
			}
		}
		for (const event of ["PreToolUse", "PostToolUse", "PermissionRequest", "Stop"] as const) {
			const command = hooks[event][0].hooks[0].command;
			expect(command, event).toContain("|| [ $? -eq 2 ]");
			expect(command, event).not.toContain("|| true");
		}
	});
});

// The adapter owns one guarded transition; a primary Stop cannot also finish AI review.
function replayStop(command: string, status: TaskStatus): TaskStatus {
	const stopTarget = command.match(/--stop-target (\S+)/)?.[1] as TaskStatus;
	return getAgentHookTargetStatus("Stop", status, stopTarget) ?? status;
}

describe("Claude Stop adapter status transitions (#1803)", () => {
	const command = (autoReview: boolean) => buildClaudeHooks({ stopTarget: getPrimaryStopTarget(autoReview) }).Stop[0].hooks[0].command;

	it.each([false, true])("a reviewer finishing in review-by-ai lands in review-by-user (auto review %s)", autoReview => {
		expect(replayStop(command(autoReview), "review-by-ai")).toBe("review-by-user");
	});

	it.each([false, true])("the primary agent finishing in-progress lands in its stop target (auto review %s)", autoReview => {
		expect(replayStop(command(autoReview), "in-progress")).toBe(getPrimaryStopTarget(autoReview));
	});

	it.each([false, true])("a Stop in any other column leaves the task alone (auto review %s)", autoReview => {
		for (const status of ["todo", "user-questions", "review-by-user", "completed", "cancelled"] as const) {
			expect(replayStop(command(autoReview), status)).toBe(status);
		}
	});
});

describe("mergeClaudeHooks", () => {
	it("adds hooks to empty settings idempotently and passes stopTarget through", () => {
		const first = mergeClaudeHooks({});
		expectOneGroupPerEvent(first.hooks as Record<string, MatcherGroup[]>, CLAUDE_CORE_EVENTS);
		const second = mergeClaudeHooks(first as Record<string, unknown>);
		expectOneGroupPerEvent(second.hooks as Record<string, MatcherGroup[]>, CLAUDE_CORE_EVENTS);

		const ai = mergeClaudeHooks(mergeClaudeHooks({}, { stopTarget: "review-by-ai" }) as Record<string, unknown>, { stopTarget: "review-by-ai" });
		const aiStop = (ai.hooks as Record<string, MatcherGroup[]>).Stop;
		expect(aiStop).toHaveLength(1);
		expect(aiStop[0].hooks[0].command).toContain("hook claude-turn-ended --stop-target review-by-ai");
	});

	it("preserves non-hook settings and user matcher groups on events dev3 also writes", () => {
		const result = mergeClaudeHooks({
			permissions: { allow: ["Bash(*)"] },
			someKey: 42,
			hooks: {
				PostToolUse: [{ hooks: [{ type: "command", command: "echo post" }] }],
				PermissionRequest: [{ hooks: [{ type: "command", command: "echo notify" }] }],
				Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
			},
		});
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		expect(result.permissions).toEqual({ allow: ["Bash(*)"] });
		expect(result.someKey).toBe(42);
		expect(hooks.PostToolUse).toHaveLength(2);
		expect(hooks.PostToolUse[0].hooks[0].command).toBe("echo post");
		expect(hooks.PostToolUse[1].hooks[0].command).toContain("hook claude-post-tool");
		expect(hooks.PermissionRequest).toHaveLength(2);
		expect(hooks.Stop).toHaveLength(2);
		expect(hooks.Stop[0].hooks[0].command).toBe("echo done");
		expect(hooks.PreToolUse).toHaveLength(1);
	});

	it("replaces both previous Stop move groups with one atomic adapter", () => {
		const userHook = { hooks: [{ type: "command", command: "echo done" }] };
		const result = mergeClaudeHooks({ hooks: { Stop: [
			userHook,
			{ hooks: [
				{ type: "command", command: `${DEV3_CLI} task move --status review-by-ai --if-status in-progress || [ $? -eq 2 ]` },
				{ type: "command", command: `${DEV3_CLI} hook claude-turn-ended`, timeout: 5 },
			] },
			{ hooks: [{ type: "command", command: `${DEV3_CLI} task move --status review-by-user --if-status review-by-ai || [ $? -eq 2 ]` }] },
		] } }, { stopTarget: "review-by-ai" });
		const hooks = result.hooks as Record<string, MatcherGroup[]>;
		expect(hooks.Stop).toEqual([userHook, ...buildClaudeHooks({ stopTarget: "review-by-ai" }).Stop]);
	});
});

describe("buildCodexHooks", () => {
	it("returns every lifecycle event with the tool and question-tool matchers", () => {
		const hooks = buildCodexHooks();
		expectOneGroupPerEvent(hooks, CODEX_EVENTS);
		expect(hooks.SessionStart[0].matcher).toBe("startup|resume");

		const matcher = "Bash|Edit|Write|^apply_patch$|^mcp__.*|^(functions\\.)?request_user_input(_async)?$";
		for (const event of ["PreToolUse", "PermissionRequest", "PostToolUse"]) expect(hooks[event][0].matcher, event).toBe(matcher);
		for (const tool of ["request_user_input", "request_user_input_async", "functions.request_user_input_async"]) {
			for (const event of ["PreToolUse", "PostToolUse"]) {
				expect(hooks[event].some(group => new RegExp(group.matcher!).test(tool)), `${event} ${tool}`).toBe(true);
			}
		}
	});

	it("every event, including the single Stop, calls one stable worktree-local handler", () => {
		const hooks = buildCodexHooks();
		for (const [event, groups] of Object.entries(hooks)) {
			for (const group of groups) {
				expect(group.hooks, event).toEqual([
					{ type: "command", command: CODEX_DEV3_HOOK_COMMAND, timeout: event === "Interrupt" || event === "SessionEnd" ? 3 : 5 },
				]);
			}
		}
		// One Stop handler so concurrent hook execution cannot skip AI review.
		expect(hooks.Stop).toHaveLength(1);
	});
});

describe("getAgentHookTargetStatus", () => {
	it.each([
		["SessionStart", "review-by-user", true, null, "in-progress"],
		["UserPromptSubmit", "in-progress", false, null, "in-progress"],
		["PreToolUse", "user-questions", false, null, "in-progress"],
		["PermissionRequest", "in-progress", false, null, "user-questions"],
		["Stop", "in-progress", false, null, "review-by-user"],
		["Stop", "in-progress", true, null, "review-by-ai"],
		["Stop", "review-by-ai", true, null, "review-by-user"],
		// #2127: these roles leave no diff of their own, so automatic review skips them.
		["Stop", "in-progress", true, "coordinator", "review-by-user"],
		["Stop", "in-progress", true, "pr-review", "review-by-user"],
		["Stop", "in-progress", true, "board-cleanup", "review-by-user"],
	] as const)("maps %s from %s (auto-review=%s, type=%s)", (event, current, autoReview, taskType, expected) => {
		expect(getAgentHookTargetStatus(event, current, getPrimaryStopTarget(autoReview, taskType))).toBe(expected);
	});

	it("preserves AI review while its agent is working", () => {
		expect(getAgentHookTargetStatus("PreToolUse", "review-by-ai", "review-by-ai")).toBeNull();
	});

	// A scratch task launches parked in user-questions with no prompt. Codex
	// fires SessionStart at startup, which must not claim the task is working —
	// only a real prompt may, or the remembered status after an approval.
	it("a session start leaves a parked task alone unless a status was remembered", () => {
		expect(getAgentHookTargetStatus("SessionStart", "user-questions", "review-by-user")).toBeNull();
		expect(getAgentHookTargetStatus("SessionStart", "user-questions", "review-by-user", "in-progress"))
			.toBe("in-progress");
	});

	it("a turn stop does not overwrite a column the agent does not own", () => {
		for (const status of ["todo", "user-questions", "review-by-user"] as const) {
			expect(getAgentHookTargetStatus("Stop", status, "review-by-ai"), status).toBeNull();
		}
	});

	// An agent that outlived a reset must never start the fresh card again, and a
	// terminal task is never reopened.
	it("never moves a To Do or terminal task, whatever the event", () => {
		const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt", "SessionEnd"] as const;
		for (const status of ["todo", "completed", "cancelled"] as const) {
			for (const event of events) {
				expect(getAgentHookTargetStatus(event, status, "review-by-ai"), `${event} in ${status}`).toBeNull();
				expect(getAgentHookTargetStatus(event, status, "review-by-user"), `${event} in ${status}`).toBeNull();
			}
		}
	});
});

describe("mergeCodexHooks", () => {
	it("adds hooks to empty settings idempotently", () => {
		const first = mergeCodexHooks({});
		expectOneGroupPerEvent(first.hooks as Record<string, MatcherGroup[]>, CODEX_EVENTS);
		const second = mergeCodexHooks(first as Record<string, unknown>);
		expectOneGroupPerEvent(second.hooks as Record<string, MatcherGroup[]>, CODEX_EVENTS);
	});

	it("preserves non-dev3 matcher groups on the same events", () => {
		const result = mergeCodexHooks({
			hooks: {
				PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo post" }] }],
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo audit" }] }],
				Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
			},
		});
		const hooks = result.hooks as Record<string, MatcherGroup[]>;

		expect(hooks.PostToolUse).toHaveLength(2);
		expect(hooks.PreToolUse).toHaveLength(2);
		expect(hooks.Stop).toHaveLength(2);
		expect(hooks.SessionStart).toHaveLength(1);
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

	const readLocal = () => JSON.parse(readFileSync(join(tmp, ".claude", "settings.local.json"), "utf-8"));

	it("creates settings.local.json from scratch with hooks and one copy of the permission", () => {
		writeClaudeHooks(tmp);
		writeClaudeHooks(tmp);

		const content = readLocal();
		const hooks = content.hooks as Record<string, MatcherGroup[]>;
		expect(hooks.UserPromptSubmit).toHaveLength(1);
		expect(hooks.Stop).toHaveLength(1);
		expect(hooks.Stop[0].hooks[0].command).toContain("hook claude-turn-ended --stop-target review-by-user");
		expect(content.permissions.allow.filter((p: string) => p === DEV3_BASH_PERMISSION)).toHaveLength(1);
		expect(content.permissions?.defaultMode, "no permissionMode given").toBeUndefined();

		writeClaudeHooks(tmp, { permissionMode: "default" });
		expect(readLocal().permissions?.defaultMode, "'default' is the no-op baseline").toBeUndefined();
	});

	it("merges into existing settings, keeping the user's keys and writing a non-default mode", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			JSON.stringify({ enableAllProjectMcpServers: true, permissions: { allow: ["Bash(ls:*)"] } }),
		);

		writeClaudeHooks(tmp, { permissionMode: "dontAsk" });

		const content = readLocal();
		expect(content.enableAllProjectMcpServers).toBe(true);
		expect(content.permissions.allow).toContain("Bash(ls:*)");
		expect(content.permissions.allow).toContain(DEV3_BASH_PERMISSION);
		expect(content.permissions.defaultMode).toBe("dontAsk");
		expect(content.hooks).toBeDefined();
	});

	it("writes the review-by-ai Stop adapter and adapter-based working hooks", () => {
		writeClaudeHooks(tmp, { stopTarget: "review-by-ai" });

		const hooks = readLocal().hooks as Record<string, MatcherGroup[]>;
		expect(hooks.Stop).toHaveLength(1);
		expect(hooks.Stop[0].hooks[0].command).toContain("hook claude-turn-ended --stop-target review-by-ai");
		for (const [event, adapter] of [["PreToolUse", "hook claude-pre-tool"], ["PostToolUse", "hook claude-post-tool"], ["UserPromptSubmit", "hook claude-prompt"]]) {
			expect(hooks[event][0].hooks[0].command, event).toContain(adapter);
			expect(hooks[event][0].hooks[0].command, event).not.toContain("review-by-user");
		}
	});

	it("never writes the committed settings.json — hooks, permission and defaultMode go to settings.local.json", () => {
		const claudeDir = join(tmp, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		const shared = JSON.stringify({ permissions: { allow: ["Read(*)"] } });
		writeFileSync(join(claudeDir, "settings.json"), shared);

		writeClaudeHooks(tmp, { permissionMode: "acceptEdits" });
		expect(readFileSync(join(claudeDir, "settings.json"), "utf-8"), "only settings file").toBe(shared);
		let local = readLocal();
		expect(local.hooks).toBeDefined();
		expect(local.permissions.defaultMode).toBe("acceptEdits");
		expect(local.permissions.allow).toContain(DEV3_BASH_PERMISSION);

		writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({ someKey: true }));
		writeClaudeHooks(tmp);
		expect(readFileSync(join(claudeDir, "settings.json"), "utf-8"), "both files exist").toBe(shared);
		local = readLocal();
		expect(local.permissions.allow).toContain(DEV3_BASH_PERMISSION);
		expect(local.someKey).toBe(true);
		expect(local.hooks).toBeDefined();
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

		const content = readLocal();
		const hooks = content.hooks as Record<string, MatcherGroup[]>;
		expect(Object.keys(hooks)).toEqual([
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"PostToolUseFailure",
			"SubagentStop",
			"TeammateIdle",
			"PermissionRequest",
			"Notification",
			"Stop",
			"SessionEnd",
			"StopFailure",
		]);
		expect(content.permissions.allow).toEqual([
			"WebFetch(domain:developers.openai.com)",
			"Bash(gh:*)",
			...dev3BashPermissions(),
		]);
		// The default dev3 'auto' mode propagates so teammates inherit it.
		expect(content.permissions.defaultMode).toBe("auto");
		expect(content.enabledMcpjsonServers).toEqual(["local-trino", "playwright"]);
	});
});

describe("ensureDefaultMode", () => {
	it("sets the mode, keeps allow/deny lists and overwrites a stale mode", () => {
		const result = ensureDefaultMode(
			{ permissions: { allow: ["Bash(git:*)"], deny: ["Read(secret)"] } },
			"acceptEdits",
		);
		const perms = result.permissions as Record<string, unknown>;
		expect(perms.allow).toEqual(["Bash(git:*)"]);
		expect(perms.deny).toEqual(["Read(secret)"]);
		expect(perms.defaultMode).toBe("acceptEdits");

		const twice = ensureDefaultMode(ensureDefaultMode({}, "plan"), "auto");
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

	it("creates a worktree-local hooks file from scratch, identically on repeated writes", () => {
		writeCodexHooks(tmp);
		const hooksPath = join(tmp, ".codex", "hooks.json");
		const first = readFileSync(hooksPath, "utf-8");
		expectOneGroupPerEvent(JSON.parse(first).hooks, CODEX_EVENTS);

		writeCodexHooks(tmp);
		expect(readFileSync(hooksPath, "utf-8")).toBe(first);
	});

	it("merges into existing settings and replaces a corrupted generated file", () => {
		const hooksPath = join(tmp, ".codex", "hooks.json");
		mkdirSync(join(tmp, ".codex"), { recursive: true });
		writeFileSync(hooksPath, JSON.stringify({ version: 1 }));
		writeCodexHooks(tmp);
		const content = JSON.parse(readFileSync(hooksPath, "utf-8"));
		expect(content.version).toBe(1);
		expect(content.hooks).toBeDefined();

		writeFileSync(hooksPath, "NOT VALID JSON{{{");
		writeCodexHooks(tmp);
		expect(JSON.parse(readFileSync(hooksPath, "utf-8"))).toHaveProperty("hooks.Stop");
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

	it("renders the exact Claude and Codex command strings, with no Windows flag, as the default dialect", () => {
		const hooks = buildClaudeHooks({ stopTarget: "review-by-ai", dialect: posix });

		expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe(`${DEV3_CLI} hook claude-prompt`);
		expect(hooks.PreToolUse[0].hooks[0].command).toBe(`${DEV3_CLI} hook claude-pre-tool || [ $? -eq 2 ]`);
		expect(hooks.PostToolUse[0].hooks[0].command).toBe(`${DEV3_CLI} hook claude-post-tool || [ $? -eq 2 ]`);
		expect(hooks.PermissionRequest[0].hooks[0].command).toBe(
			`${DEV3_CLI} hook claude-permission || ${DEV3_CLI} task move --status user-questions || [ $? -eq 2 ]`,
		);
		expect(hooks.Stop[0].hooks[0].command).toBe(
			`${DEV3_CLI} hook claude-turn-ended --stop-target review-by-ai || [ $? -eq 2 ]`,
		);
		expect(buildCodexHooks({ dialect: posix }).Stop[0].hooks[0].command).toBe(
			`sh -c '[ -z "$DEV3_TASK_ID" ] || exec ~/.dev3.0/bin/dev3 hook codex'`,
		);

		for (const command of everyCommand(hooks)) {
			expect(command).not.toContain(TOLERATE_APP_OFFLINE_FLAG);
		}

		expect(hooks).toEqual(buildClaudeHooks({ stopTarget: "review-by-ai" }));
		expect(buildCodexHooks({ dialect: posix })).toEqual(buildCodexHooks());
	});
});

describe("Windows hook output", () => {
	it("renders the exact Claude and Codex command strings", () => {
		const hooks = buildClaudeHooks({ stopTarget: "review-by-ai", dialect: WIN_SPACES });
		const cli = WIN_SPACES.cli;
		expect(cli).toBe('"C:/Users/John Doe/.dev3.0/bin/dev3.exe"');

		expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe(`${cli} hook claude-prompt`);
		expect(hooks.PreToolUse[0].hooks[0].command).toBe(`${cli} hook claude-pre-tool --tolerate-app-offline`);
		expect(hooks.PostToolUse[0].hooks[0].command).toBe(`${cli} hook claude-post-tool --tolerate-app-offline`);
		expect(hooks.PermissionRequest[0].hooks[0].command).toBe(`${cli} hook claude-permission --tolerate-app-offline`);
		expect(hooks.Stop[0].hooks[0].command).toBe(
			`${cli} hook claude-turn-ended --stop-target review-by-ai --tolerate-app-offline`,
		);
		// No tolerance flag on Codex — the subcommand always exits 0.
		expect(buildCodexHooks({ dialect: WIN_SPACES }).Stop[0].hooks[0].command).toBe(`${cli} hook codex`);
	});

	it("starts every command with an absolute dev3.exe and emits no tilde, shell operator or redirect", () => {
		const shellFree = [
			...everyCommand(buildClaudeHooks({ stopTarget: "review-by-ai", dialect: WIN_SPACES })),
			...everyCommand(buildCodexHooks({ dialect: WIN_SPACES })),
		];
		expect(shellFree.length).toBeGreaterThan(6);
		for (const command of shellFree) {
			for (const forbidden of ["~", "&&", "||", ";", "$?", "2>&1"]) expect(command, forbidden).not.toContain(forbidden);
		}

		const plain = [
			...everyCommand(buildClaudeHooks({ stopTarget: "review-by-ai", dialect: WIN_PLAIN })),
			...everyCommand(buildCodexHooks({ dialect: WIN_PLAIN })),
		];
		for (const command of plain) {
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

	it("replaces dev3 entries written by a POSIX dev3 or the bare-backslash spelling an earlier build wrote", () => {
		const preToolCommands = (existing: Record<string, unknown>) =>
			(mergeClaudeHooks(existing, { dialect: WIN_SPACES }) as { hooks: Record<string, MatcherGroup[]> })
				.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));

		const fromPosix = preToolCommands({
			hooks: {
				PreToolUse: [
					{ hooks: [{ type: "command", command: `${DEV3_CLI} task move --status in-progress` }] },
					{ hooks: [{ type: "command", command: "echo mine" }] },
				],
			},
		});
		expect(fromPosix).toContain("echo mine");
		expect(fromPosix.some((c) => c.includes("dev3.exe"))).toBe(true);
		expect(fromPosix.some((c) => c.includes("~/.dev3.0/bin/dev3"))).toBe(false);

		// Bash ate the separators of that earlier spelling.
		const broken = "C:\\Users\\John Doe\\.dev3.0\\bin\\dev3.exe task move --status in-progress";
		const fromBackslash = preToolCommands({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: broken }] }] } });
		expect(fromBackslash).not.toContain(broken);
		expect(fromBackslash.every((c) => !c.includes("\\"))).toBe(true);
		expect(fromBackslash.some((c) => c.startsWith(WIN_SPACES.cli))).toBe(true);
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
		"SessionStart",
		"UserPromptSubmit",
		"PreToolUse",
		"PostToolUse",
		"PostToolUseFailure",
		"SubagentStop",
		"TeammateIdle",
		"PermissionRequest",
		"Notification",
		"Stop",
		"SessionEnd",
		"StopFailure",
	];

	it("installs every dev3 event whatever malformed shape the root, hooks or an event holds", () => {
		const slotCases: [string, unknown][] = [
			["hooks is an array", { hooks: [{ type: "command", command: "x" }] }],
			["hooks is a string", { hooks: "nope" }],
			["hooks is null", { hooks: null }],
			["hooks is a number", { hooks: 7 }],
			["an event holds a matcher group instead of an array", { hooks: { PreToolUse: { hooks: [] } } }],
			["an event holds a string", { hooks: { PreToolUse: "x" } }],
			["an event holds null", { hooks: { Stop: null } }],
		];
		for (const [label, existing] of slotCases) {
			expect(hookEvents(mergeClaudeHooks(existing as Record<string, unknown>)), label).toEqual(expect.arrayContaining(DEV3_EVENTS));
		}

		// Exact key lists: no numeric keys leak from a spread string or array.
		const exactCases: [string, unknown][] = [
			["hooks is a spread string", { hooks: "nope" }],
			["hooks is a spread array", { hooks: ["a", "b"] }],
			["the root is null", null],
			["the root is an array", [1, 2, 3]],
			["the root is a number", 42],
			["the root is a string", "settings"],
		];
		for (const [label, existing] of exactCases) {
			expect(hookEvents(mergeClaudeHooks(existing as unknown as Record<string, unknown>)), label).toEqual(DEV3_EVENTS);
		}
	});

	it("keeps user and malformed entries it does not own while appending dev3's", () => {
		const userHook = { hooks: [{ type: "command", command: ".claude/hooks/auto-approve.sh" }] };
		const nextToBroken = mergeClaudeHooks({
			hooks: { PreToolUse: [userHook], Stop: "broken" },
		}) as { hooks: Record<string, MatcherGroup[]> };
		expect(nextToBroken.hooks.PreToolUse[0]).toEqual(userHook);
		expect(nextToBroken.hooks.Stop).toHaveLength(1);

		const unrelated = mergeClaudeHooks({ hooks: { ConfigChange: "whatever" } }) as { hooks: Record<string, unknown> };
		expect(unrelated.hooks.ConfigChange, "unrelated malformed event").toBe("whatever");

		// Nothing here mentions dev3, so all three survive, and dev3 is appended.
		const badGroups = mergeClaudeHooks({
			hooks: { PreToolUse: [null, "x", { hooks: "not-an-array" }] },
		}) as { hooks: Record<string, unknown[]> };
		expect(badGroups.hooks.PreToolUse, "malformed groups").toHaveLength(4);

		const badCommand = mergeClaudeHooks({
			hooks: { Stop: [{ hooks: [{ type: "command", command: 42 }] }, { hooks: [null] }] },
		}) as { hooks: Record<string, unknown[]> };
		expect(badCommand.hooks.Stop, "non-string command").toHaveLength(3);
	});

	it("replaces an old dev3 hook stored in the legacy flat format", () => {
		const merged = mergeClaudeHooks({
			hooks: { Stop: [{ type: "command", command: `${DEV3_CLI} task move --status review-by-user` }] },
		}) as { hooks: Record<string, unknown[]> };

		expect(merged.hooks.Stop).toHaveLength(1);
	});
});

describe("dev3BashPermissions — metadata subcommands, every spelling the agent may type", () => {
	const POSIX = { cli: "~/.dev3.0/bin/dev3", posixShell: true };
	const WINDOWS = { cli: '"C:/Users/dev/.dev3.0/bin/dev3.exe"', posixShell: false };

	// The skill and hook text dev3 generates spells the CLI as an absolute path,
	// while the protocol tells the agent to type a bare `dev3`. Claude Code matches
	// the literal command text, so both spellings carry the same allowlist.
	it("covers metadata subcommands in the bare CLI, the POSIX path and the quoted Windows dev3.exe", () => {
		const rules = dev3BashPermissions(POSIX);
		for (const rule of ["Bash(dev3 current)", "Bash(dev3 task *)", "Bash(dev3 pane logs *)",
			"Bash(~/.dev3.0/bin/dev3 current)", "Bash(~/.dev3.0/bin/dev3 note *)"]) {
			expect(rules).toContain(rule);
		}
		expect(dev3BashPermissions(WINDOWS)).toContain('Bash("C:/Users/dev/.dev3.0/bin/dev3.exe" task *)');

		const bareOnly = dev3BashPermissions({ cli: "dev3", posixShell: true });
		expect(bareOnly.every((rule) => rule.startsWith("Bash(dev3 "))).toBe(true);
		expect(new Set(bareOnly).size).toBe(bareOnly.length);
	});

	// Issue #2043: any of these approved here skips the harness's own check on
	// a command the agent could not have run directly.
	it("never approves an executing command (#2043)", () => {
		const executing = [
			"dev3 pane run",
			"dev3 __pane-run",
			"dev3 dev-server start",
			"dev3 dev-server restart",
			"dev3 agent spawn",
			"dev3 automations run",
			"dev3 automations create",
			"dev3 remote",
			"dev3 local",
			"dev3 update",
			"dev3 projects clone",
			"dev3 doctor",
		];
		for (const dialect of [POSIX, WINDOWS]) {
			const rules = dev3BashPermissions(dialect);
			for (const command of executing) {
				const cli = command.replace(/^dev3/, dialect.cli);
				for (const spelled of [command, cli]) {
					expect(rules, spelled).not.toContain(`Bash(${spelled})`);
					expect(rules, spelled).not.toContain(`Bash(${spelled} *)`);
				}
			}
			expect(rules.some((rule) => rule === "Bash(dev3:*)" || rule === `Bash(${dialect.cli} *)`)).toBe(false);
		}
	});

	it("keeps a ` *` word boundary so `pr` cannot reach `projects`", () => {
		const rules = dev3BashPermissions(POSIX);
		expect(rules).toContain("Bash(dev3 pr *)");
		expect(rules.some((rule) => /:\*\)$/.test(rule) || /[^ ]\*\)$/.test(rule))).toBe(false);
	});

	it("writes the rules once, however often the hooks are re-asserted", () => {
		const first = ensureDevPermission({}, POSIX);
		const second = ensureDevPermission(ensureDevPermission(first, POSIX), POSIX) as {
			permissions: { allow: string[] };
		};
		expect(second.permissions.allow).toEqual(dev3BashPermissions(POSIX));
	});

	it("takes the broad whole-CLI rule an older dev3 wrote back out, keeping the user's own rules", () => {
		const legacy = { permissions: { allow: ["Bash(gh:*)", "Bash(dev3:*)", "Bash(~/.dev3.0/bin/dev3 *)", "Bash(dev3 pane run *)"] } };
		const result = ensureDevPermission(legacy, POSIX) as { permissions: { allow: string[] } };
		expect(result.permissions.allow).not.toContain("Bash(dev3:*)");
		expect(result.permissions.allow).not.toContain("Bash(~/.dev3.0/bin/dev3 *)");
		// A narrow rule the user added themselves is an explicit opt-in and stays.
		expect(result.permissions.allow.slice(0, 2)).toEqual(["Bash(gh:*)", "Bash(dev3 pane run *)"]);
	});
});

describe("isBroadDev3Rule", () => {
	it("recognizes whole-CLI rules in every spelling and leaves narrow or foreign rules alone", () => {
		for (const rule of [
			"Bash(dev3:*)",
			"Bash(dev3 *)",
			"Bash(~/.dev3.0/bin/dev3 *)",
			'Bash("C:/Users/dev/.dev3.0/bin/dev3.exe" *)',
			'Bash("C:\\Users\\dev\\.dev3.0\\bin\\dev3.exe" *)',
		]) {
			expect(isBroadDev3Rule(rule), rule).toBe(true);
		}
		for (const rule of ["Bash(dev3 note *)", "Bash(dev3 pane run *)", "Bash(gh:*)", "Bash(*)", "Read(dev3)", 42]) {
			expect(isBroadDev3Rule(rule), String(rule)).toBe(false);
		}
	});
});

describe("ensureDevPermission / ensureDefaultMode with malformed settings", () => {
	it("writes a clean allow list over any malformed permissions slot and never throws", () => {
		const cases: [string, Record<string, unknown>, string[]][] = [
			["permissions is a string", { permissions: "all" }, ["allow"]],
			["permissions is an array", { permissions: ["a"] }, ["allow"]],
			["permissions is null", { permissions: null }, ["allow"]],
			["permissions is a number", { permissions: 1 }, ["allow"]],
			["allow is not an array", { permissions: { allow: "Bash(gh:*)" } }, ["allow"]],
		];
		for (const [label, settings, keys] of cases) {
			const result = ensureDevPermission(settings) as { permissions: Record<string, unknown> };
			expect(Object.keys(result.permissions), label).toEqual(keys);
			expect(result.permissions.allow, label).toEqual(dev3BashPermissions());
		}
		for (const root of [null, []]) {
			expect(() => ensureDevPermission(root as unknown as Record<string, unknown>)).not.toThrow();
			expect(() => ensureDefaultMode(root as unknown as Record<string, unknown>, "auto")).not.toThrow();
		}
	});

	it("keeps sibling permission keys", () => {
		const result = ensureDevPermission({
			permissions: { allow: ["Bash(gh:*)"], deny: ["Bash(rm:*)"], defaultMode: "auto" },
		}) as { permissions: Record<string, unknown> };

		expect(result.permissions.deny).toEqual(["Bash(rm:*)"]);
		expect(result.permissions.defaultMode).toBe("auto");
		expect(result.permissions.allow).toEqual(["Bash(gh:*)", ...dev3BashPermissions()]);
	});
});

describe("worktree config writes refuse to follow a symlink", () => {
	let tmp: string;
	let kit: string;
	const KIT_CONTENT = JSON.stringify({ permissions: { allow: ["Read(*)"] } });

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "dev3-hooks-symlink-"));
		kit = mkdtempSync(join(tmpdir(), "dev3-hooks-kit-"));
		writeFileSync(join(kit, "settings.json"), KIT_CONTENT);
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		rmSync(kit, { recursive: true, force: true });
	});

	it("leaves a symlinked settings.json alone and writes settings.local.json", () => {
		mkdirSync(join(tmp, ".claude"));
		symlinkSync(join(kit, "settings.json"), join(tmp, ".claude", "settings.json"));

		const result = writeClaudeHooks(tmp, { permissionMode: "auto" });

		expect(result).toEqual({ written: true, skippedSymlink: null });
		expect(readFileSync(join(kit, "settings.json"), "utf-8")).toBe(KIT_CONTENT);
		const local = JSON.parse(readFileSync(join(tmp, ".claude", "settings.local.json"), "utf-8"));
		expect(local.permissions.allow).toContain(DEV3_BASH_PERMISSION);
	});

	it("skips a symlinked settings.local.json and reports the link", () => {
		mkdirSync(join(tmp, ".claude"));
		const link = join(tmp, ".claude", "settings.local.json");
		symlinkSync(join(kit, "settings.json"), link);

		expect(writeClaudeHooks(tmp)).toEqual({ written: false, skippedSymlink: link });
		expect(readFileSync(join(kit, "settings.json"), "utf-8")).toBe(KIT_CONTENT);
	});

	it("skips when the .claude directory itself is a symlink", () => {
		symlinkSync(kit, join(tmp, ".claude"));

		expect(writeClaudeHooks(tmp)).toEqual({ written: false, skippedSymlink: join(tmp, ".claude") });
		expect(existsSync(join(kit, "settings.local.json"))).toBe(false);
	});

	it("skips a dangling .claude symlink instead of throwing", () => {
		symlinkSync(join(kit, "missing"), join(tmp, ".claude"));

		expect(writeClaudeHooks(tmp).skippedSymlink).toBe(join(tmp, ".claude"));
	});

	it("skips a symlinked .codex directory for Codex hooks", () => {
		symlinkSync(kit, join(tmp, ".codex"));

		expect(writeCodexHooks(tmp)).toBe(join(tmp, ".codex"));
		expect(existsSync(join(kit, "hooks.json"))).toBe(false);
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
		expect(content.permissions.allow).toEqual(["Bash(gh:*)", ...dev3BashPermissions()]);
	});

	it("installs hooks over a file whose hooks key is the wrong shape", () => {
		writeFileSync(
			settingsPath(),
			JSON.stringify({ enabledMcpjsonServers: ["playwright"], hooks: { PreToolUse: {} } }),
		);

		writeClaudeHooks(tmp);

		const content = read();
		// The status move, plus the file claim a folder outside the dev3 home gets.
		expect(content.hooks.PreToolUse).toHaveLength(2);
		expect(content.enabledMcpjsonServers).toEqual(["playwright"]);
	});

	it("installs hooks over invalid JSON, a non-object, or an empty file", () => {
		for (const [label, raw] of [["invalid JSON", "NOT VALID JSON{{{"], ["non-object", "[1,2,3]"], ["empty", ""]]) {
			writeFileSync(settingsPath(), raw);
			writeClaudeHooks(tmp);
			const content = read();
			expect(content.hooks?.Stop, label).toHaveLength(1);
			expect(content["0"], label).toBeUndefined();
		}
	});

	it("does not write the dev3 permission into a malformed shared settings.json", () => {
		writeFileSync(join(tmp, ".claude", "settings.json"), "null");

		writeClaudeHooks(tmp);

		expect(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8")).toBe("null");
		expect(read().permissions.allow).toEqual(dev3BashPermissions());
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

	it("reports a write on the first install and leaves the file untouched on the second", () => {
		expect(writeClaudeHooks(tmp).written).toBe(true);
		const before = readFileSync(settingsPath(), "utf-8");
		const mtime = statSync(settingsPath()).mtimeMs;

		expect(writeClaudeHooks(tmp).written).toBe(false);

		expect(statSync(settingsPath()).mtimeMs).toBe(mtime);
		expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
	});

	// Claude Code rewrites settings.local.json from its own in-memory snapshot, so
	// a snapshot taken before the hooks landed drops them. The next agent launch
	// must put them back.
	it("writes again once an external rewrite dropped the hooks, or the stop target changes", () => {
		writeClaudeHooks(tmp);
		writeFileSync(settingsPath(), JSON.stringify({ permissions: { allow: ["Bash(gh:*)"] }, enabledMcpjsonServers: ["playwright"] }));

		expect(writeClaudeHooks(tmp).written).toBe(true);
		const content = JSON.parse(readFileSync(settingsPath(), "utf-8"));
		expect(content.hooks?.Stop).toHaveLength(1);
		expect(content.enabledMcpjsonServers).toEqual(["playwright"]);

		expect(writeClaudeHooks(tmp, { stopTarget: "review-by-ai" }).written, "stop target change").toBe(true);
	});

	it("settles on the second run when a shared settings.json is present", () => {
		mkdirSync(join(tmp, ".claude"), { recursive: true });
		const shared = JSON.stringify({ permissions: { allow: [] } });
		writeFileSync(join(tmp, ".claude", "settings.json"), shared);

		expect(writeClaudeHooks(tmp).written).toBe(true);
		expect(writeClaudeHooks(tmp).written).toBe(false);
		expect(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8")).toBe(shared);
	});
});

describe("generated hook commands stay instance-neutral", () => {
	// Instance targeting is for a HUMAN shell. If it ever leaked into these
	// strings, every task's status hooks would route into one guest dev-server —
	// #910/#920 reproduced by construction. The strings also sit in worktrees that
	// older builds read, where an unknown flag is not even parseable.
	it("never carries --instance or the armed dev3-self shim, and keeps the frozen bin/dev3 path", () => {
		const commands = [CODEX_DEV3_HOOK_COMMAND, ...everyCommand(buildClaudeHooks()), ...everyCommand(buildCodexHooks())];
		for (const command of commands) {
			expect(command).not.toContain("--instance");
			expect(command).not.toContain("dev3-self");
			expect(command).toContain("dev3");
		}
		expect(CODEX_DEV3_HOOK_COMMAND).toContain("~/.dev3.0/bin/dev3");
	});
});

describe("claudeSessionStartHookInstalled", () => {
	let tmp = "";
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "dev3-session-start-hook-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("sees the hook writeClaudeHooks installs, not someone else's SessionStart", () => {
		expect(claudeSessionStartHookInstalled(tmp)).toBe(false);
		mkdirSync(join(tmp, ".claude"));
		writeFileSync(join(tmp, ".claude", "settings.local.json"), JSON.stringify({
			hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
		}));
		expect(claudeSessionStartHookInstalled(tmp), "foreign SessionStart").toBe(false);
		writeClaudeHooks(tmp);
		expect(claudeSessionStartHookInstalled(tmp)).toBe(true);
	});
});

describe("Claude hooks outside a dev3-owned folder", () => {
	const posix = hookCliDialect({ platform: "darwin" });
	let tmp: string;
	let savedHome: string | undefined;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "dev3-hooks-folder-"));
		savedHome = process.env.DEV3_HOME;
		process.env.DEV3_HOME = join(tmp, "dev3home");
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.DEV3_HOME;
		else process.env.DEV3_HOME = savedHome;
		rmSync(tmp, { recursive: true, force: true });
	});

	function readCommands(folder: string): string[] {
		const settings = JSON.parse(readFileSync(join(folder, ".claude", "settings.local.json"), "utf-8"));
		return everyCommand(settings.hooks);
	}

	it("guards every command written into a project folder and leaves worktree hooks unguarded", () => {
		const project = join(tmp, "project");
		mkdirSync(project);
		writeClaudeHooks(project);
		const commands = readCommands(project);
		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) expect(command.startsWith('[ -z "$DEV3_TASK_ID" ] || ')).toBe(true);

		const worktree = join(process.env.DEV3_HOME!, "worktrees", "slug", "id", "worktree");
		mkdirSync(worktree, { recursive: true });
		writeClaudeHooks(worktree);
		for (const command of readCommands(worktree)) expect(command, "worktree").not.toContain("DEV3_TASK_ID");
	});

	it("replaces stale unguarded dev3 hooks instead of stacking guarded ones beside them", () => {
		const folder = join(tmp, "project");
		mkdirSync(join(folder, ".claude"), { recursive: true });
		writeFileSync(join(folder, ".claude", "settings.local.json"), JSON.stringify({ hooks: buildClaudeHooks() }));
		writeClaudeHooks(folder);
		const settings = JSON.parse(readFileSync(join(folder, ".claude", "settings.local.json"), "utf-8"));
		expect(settings.hooks).toEqual(buildClaudeHooks({ requireTaskEnv: true, fileLeases: true }));
	});

	it("keeps Windows commands bare", () => {
		const windows = hookCliDialect({ platform: "win32" });
		expect(buildClaudeHooks({ dialect: windows, requireTaskEnv: true })).toEqual(buildClaudeHooks({ dialect: windows }));
	});

	it("in a real shell, skips the CLI outside a dev3 pane and tolerates only the app-offline exit inside one", () => {
		function runGuarded(taskId: string | undefined, exitCode: number): { status: number | null; ran: boolean } {
			const marker = join(tmp, "ran");
			rmSync(marker, { force: true });
			const fake = join(tmp, "dev3");
			writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\nexit ${exitCode}\n`, { mode: 0o755 });
			const command = buildClaudeHooks({ dialect: { ...posix, cli: fake }, requireTaskEnv: true })
				.PermissionRequest[0].hooks[0].command;
			const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
			if (taskId) env.DEV3_TASK_ID = taskId;
			const result = spawnSync("sh", ["-c", command], { env });
			return { status: result.status, ran: existsSync(marker) };
		}

		expect(runGuarded(undefined, 1), "outside a pane").toEqual({ status: 0, ran: false });
		expect(runGuarded("task-1", 2)).toEqual({ status: 0, ran: true });
		expect(runGuarded("task-1", 1).status).toBe(1);
	});
});

describe("ensureParentClaudeMdExcluded", () => {
	it("adds the main checkout's memory files once and keeps the user's own entries", () => {
		const first = ensureParentClaudeMdExcluded({ claudeMdExcludes: ["/x/CLAUDE.md"] }, "/home/u/acme");
		expect(first.claudeMdExcludes).toEqual([
			"/x/CLAUDE.md",
			"/home/u/acme/CLAUDE.md",
			"/home/u/acme/CLAUDE.local.md",
			"/home/u/acme/.claude/CLAUDE.md",
		]);
		expect(ensureParentClaudeMdExcluded(first, "/home/u/acme")).toBe(first);
	});

	it("keeps the parent .claude/CLAUDE.md loadable when that folder is the Claude config dir", () => {
		const stale = { claudeMdExcludes: ["/home/u/acme/CLAUDE.md", "/home/u/acme/CLAUDE.local.md", "/home/u/acme/.claude/CLAUDE.md"] };
		const fixed = ensureParentClaudeMdExcluded(stale, "/home/u/acme", { parentIsClaudeHome: true });
		expect(fixed.claudeMdExcludes).toEqual(["/home/u/acme/CLAUDE.md", "/home/u/acme/CLAUDE.local.md"]);
		expect(ensureParentClaudeMdExcluded(fixed, "/home/u/acme", { parentIsClaudeHome: true })).toBe(fixed);
	});
});

describe("writeClaudeHooks in an in-project worktree", () => {
	let project: string;
	let worktree: string;
	const excludes = () => JSON.parse(readFileSync(join(worktree, ".claude", "settings.local.json"), "utf-8")).claudeMdExcludes;

	beforeEach(() => {
		project = mkdtempSync(join(tmpdir(), "agent-hooks-inproject-"));
		worktree = join(project, ".dev3", "worktrees", "abcd1234", "worktree");
		mkdirSync(worktree, { recursive: true });
		mkdirSync(join(project, ".claude"), { recursive: true });
	});
	afterEach(() => rmSync(project, { recursive: true, force: true }));

	it("excludes the parent .claude/CLAUDE.md until that folder becomes Claude's config dir", () => {
		writeClaudeHooks(worktree);
		expect(excludes(), "plain project folder").toContain(`${project}/.claude/CLAUDE.md`);

		writeFileSync(join(project, ".claude", ".claude.json"), "{}");
		writeClaudeHooks(worktree);
		expect(excludes()).toEqual([`${project}/CLAUDE.md`, `${project}/CLAUDE.local.md`]);
	});
});

describe("isDev3OwnedFolder", () => {
	const env = { DEV3_HOME: "/home/u/.dev3.0" };

	it("owns home worktrees, ops folders and in-project task dirs, never their roots or a project folder", () => {
		expect(isDev3OwnedFolder("/home/u/.dev3.0/worktrees/p/abcd1234/worktree", env)).toBe(true);
		expect(isDev3OwnedFolder("/home/u/.dev3.0/ops/board/abcd1234/work", env)).toBe(true);
		expect(isDev3OwnedFolder("/home/u/acme/.dev3/worktrees/abcd1234/worktree", env)).toBe(true);
		expect(isDev3OwnedFolder("/home/u/acme", env)).toBe(false);
		expect(isDev3OwnedFolder("/home/u/.dev3.0/worktrees", env)).toBe(false);
		expect(isDev3OwnedFolder("/home/u/acme/.dev3/worktrees", env)).toBe(false);
		expect(isDev3OwnedFolder("/mnt/e/Projects/photos", env)).toBe(false);
	});
});
