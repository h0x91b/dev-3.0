import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentCommand, supportsResume, supportsPreAssignedSessionId, buildResumeCommand, skillInvocationPrefix, mergeMcpApproval, mergeWithDefaults, applyBinaryPathOverride, applyLayoutResync, migrateOldFormat, applyModelOverride, applyProviderModel, resolveLaunchConfig, claudeModelFamily, __setCodexProfileV2Override, type TemplateContext } from "../agents";
import type { AgentConfiguration, CodingAgent } from "../../shared/types";
import { DEFAULT_AGENTS } from "../../shared/types";
import { ENV_UNSET } from "../../shared/agent-accounts";
import { setCurrentUiTheme } from "../theme-state";

const makeAgent = (overrides?: Partial<CodingAgent>): CodingAgent => ({
	id: "test-agent",
	name: "Test",
	baseCommand: "claude",
	configurations: [],
	defaultConfigId: "default",
	...overrides,
});

const makeConfig = (overrides?: Partial<AgentConfiguration>): AgentConfiguration => ({
	id: "default",
	name: "Default",
	model: "sonnet",
	...overrides,
});

const makeCtx = (overrides?: Partial<TemplateContext>): TemplateContext => ({
	taskTitle: "Fix bug",
	taskDescription: "Fix the login bug",
	projectName: "my-project",
	projectPath: "/path/to/project",
	worktreePath: "/path/to/worktree",
	...overrides,
});

beforeEach(() => {
	setCurrentUiTheme("dark");
	// Default to legacy (pre-0.131) profile semantics so codex theme tests are
	// deterministic regardless of the Codex version installed on the machine.
	__setCodexProfileV2Override(false);
});

afterEach(() => {
	__setCodexProfileV2Override(null);
});

describe("skillInvocationPrefix", () => {
	it.each([
		["codex", "$"],
		["/opt/homebrew/bin/codex", "$"],
		["claude", "/"],
		["agent", "/"],
		["gemini", "/"],
		["opencode", "/"],
		["", "/"],
	])("%s → %s", (command, expected) => {
		expect(skillInvocationPrefix(command)).toBe(expected);
	});
});

describe("supportsResume", () => {
	it.each([
		["claude", true],
		["codex", true],
		["gemini", true],
		["agent", true],
		["opencode", true],
		["/usr/local/bin/claude", true],
		["/opt/homebrew/bin/opencode", true],
		["bash", false],
		["aider", false],
		["my-custom-agent", false],
	])("%s → %s", (cmd, expected) => {
		expect(supportsResume(cmd)).toBe(expected);
	});
});

describe("resolveAgentCommand — resume", () => {
	// ---- Claude ----
	it("Claude: adds --continue and skips prompt when resume=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig(),
			makeCtx({ taskDescription: "Some task description" }),
			{ resume: true },
		);

		expect(cmd).toContain("--continue");
		expect(cmd).not.toContain("Some task description");
	});

	it("Claude: includes prompt normally when resume is not set", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig(),
			makeCtx({ taskDescription: "Some task description" }),
		);

		expect(cmd).not.toContain("--continue");
		expect(cmd).toContain("Some task description");
	});

	it("Claude: skips appendPrompt when resume=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig({ appendPrompt: "Extra instructions: {{TASK_TITLE}}" }),
			makeCtx({ taskDescription: "" }),
			{ resume: true },
		);

		expect(cmd).toContain("--continue");
		expect(cmd).not.toContain("Extra instructions");
	});

	it("Claude: still includes --append-system-prompt when resume=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig(),
			makeCtx(),
			{ resume: true },
		);

		expect(cmd).toContain("--append-system-prompt");
	});

	// ---- Codex ----
	it("Codex: uses 'codex resume --last' subcommand when resume=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true },
		);

		expect(cmd).toMatch(/^codex resume --last/);
		expect(cmd).not.toContain("Some task");
	});

	it("Codex: ignores unsupported generic config flags during resume", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({
				model: "gpt-5",
				permissionMode: "bypassPermissions",
				effort: "high",
				maxBudgetUsd: 10,
			}),
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true },
		);

		expect(cmd).toMatch(/^codex resume --last/);
		expect(cmd).toContain("--model gpt-5");
		expect(cmd).not.toContain("--permission-mode");
		expect(cmd).not.toContain("--effort");
		expect(cmd).not.toContain("--max-budget-usd");
	});

	it("Codex: normal command when resume is not set", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toMatch(/^codex/);
		expect(cmd).not.toMatch(/^codex resume/);
		expect(cmd).toContain("Some task");
	});

	it("Claude: quotes model names containing shell metacharacters", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig({ model: "claude-opus-4-8[1m]" }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("--model 'claude-opus-4-8[1m]'");
		expect(cmd).not.toContain("--model claude-opus-4-8[1m]");
	});

	it("omits --model when a third-party provider is selected for the launch", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig({ model: "claude-opus-4-8[1m]" }),
			makeCtx({ taskDescription: "Some task" }),
			{ llmProvider: "bedrock" },
		);
		// On Bedrock the model comes from injected ANTHROPIC_MODEL, not --model.
		expect(cmd).not.toContain("--model");
	});

	it("Codex on Bedrock: keeps --model and appends the model_provider routing args", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: "openai.gpt-5.6-sol" }),
			makeCtx({ taskDescription: "Some task" }),
			{ llmProvider: "bedrock-codex" },
		);
		// Codex has no model env var: the model rides the (rewritten) --model flag
		// and the backend is selected via a -c config override.
		expect(cmd).toContain("--model openai.gpt-5.6-sol");
		expect(cmd).toContain(`-c 'model_provider="amazon-bedrock"'`);
	});

	it("keeps --model when no provider is selected (native default)", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig({ model: "claude-opus-4-8[1m]" }),
			makeCtx({ taskDescription: "Some task" }),
		);
		expect(cmd).toContain("--model 'claude-opus-4-8[1m]'");
	});

	it("Codex: injects the dev3 protocol via -c developer_instructions, not the prompt", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
		);

		// Protocol is delivered as a developer-role message via config override.
		// The value is a JSON-stringified TOML basic string, so inner double
		// quotes appear escaped (shell="/bin/bash" → shell=\"/bin/bash\").
		expect(cmd).toContain("-c 'developer_instructions=");
		expect(cmd).toContain("Task Lifecycle Protocol");
		expect(cmd).toContain("Never call `dev3 task move` for normal lifecycle transitions");
		expect(cmd).not.toContain("task move --status in-progress");
		expect(cmd).toContain('shell=\\"/bin/bash\\"');
		expect(cmd).toContain("user-questions");
		// The user prompt stays clean — no skill body appended to it.
		expect(cmd).toContain("-- 'Some task'");
	});

	it("Codex: resume also carries -c developer_instructions", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true },
		);

		expect(cmd).toMatch(/^codex resume --last/);
		expect(cmd).toContain("-c 'developer_instructions=");
	});

	it("Codex: skipSystemPrompt suppresses -c developer_instructions", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
			{ skipSystemPrompt: true },
		);

		expect(cmd).not.toContain("developer_instructions");
		expect(cmd).not.toContain("Task Lifecycle Protocol");
	});

	it("Codex: uses dracula theme when dev3 UI theme is dark", () => {
		setCurrentUiTheme("dark");

		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["-p", "dev3"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("-p dev3-dark");
		expect(cmd).not.toContain("-p dev3 ");
		expect(cmd).toContain(`-c 'tui.theme="dracula"'`);
	});

	it("Codex: uses github theme when dev3 UI theme is light", () => {
		setCurrentUiTheme("light");

		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["-p", "dev3"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("-p dev3-light");
		expect(cmd).not.toContain("-p dev3 ");
		expect(cmd).toContain(`-c 'tui.theme="github"'`);
	});

	it("Codex: preserves unrelated config overrides when injecting the theme", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({
				model: undefined,
				additionalArgs: ["-p", "dev3", "-c", 'model_reasoning_effort="high"'],
			}),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain(`-c model_reasoning_effort="high" -c 'tui.theme="dracula"'`);
	});

	it("Codex: appends the dev3 theme after a conflicting user override", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({
				model: undefined,
				additionalArgs: ["-p", "dev3", "-c", 'tui.theme="nord"'],
			}),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd.indexOf('tui.theme="nord"')).toBeLessThan(cmd.indexOf('tui.theme="dracula"'));
	});

	it("Codex: leaves custom profile names untouched", () => {
		setCurrentUiTheme("light");

		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["-p", "my-custom-profile"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("-p my-custom-profile");
		expect(cmd).not.toContain("-p dev3-light");
	});

	it("Codex: rewrites -p to --profile-v2 on profile-v2 Codex (dark)", () => {
		setCurrentUiTheme("dark");
		__setCodexProfileV2Override(true);

		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["-p", "dev3"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("--profile-v2 dev3-dark");
		expect(cmd).not.toContain("-p dev3-dark");
		expect(cmd).not.toContain("-p dev3 ");
	});

	it("Codex: rewrites --profile to --profile-v2 on profile-v2 Codex (light)", () => {
		setCurrentUiTheme("light");
		__setCodexProfileV2Override(true);

		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["--profile", "dev3"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("--profile-v2 dev3-light");
		expect(cmd).not.toContain("--profile dev3-light");
	});

	it("Codex: leaves custom profile names untouched on profile-v2 Codex", () => {
		setCurrentUiTheme("dark");
		__setCodexProfileV2Override(true);

		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["-p", "my-custom-profile"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("-p my-custom-profile");
		expect(cmd).not.toContain("--profile-v2");
	});

	it("Codex: never emits --profile-v2 on newer codex that removed it (issue #611)", () => {
		setCurrentUiTheme("dark");
		// false => launch flag is the post-rename `--profile`, so the user's `-p`
		// must be kept as-is and `--profile-v2` must never appear (it aborts codex).
		__setCodexProfileV2Override(false);

		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined, additionalArgs: ["-p", "dev3"] }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("-p dev3-dark");
		expect(cmd).not.toContain("--profile-v2");
	});

	// ---- Gemini ----
	it("Gemini: adds --resume latest when resume=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "gemini" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true },
		);

		expect(cmd).toContain("--resume latest");
		expect(cmd).not.toContain("Some task");
	});

	it("Gemini: normal command when resume is not set", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "gemini" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).not.toContain("--resume");
		expect(cmd).toContain("Some task");
	});

	// ---- Cursor Agent ----
	it("Cursor Agent: adds --continue when resume=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "agent" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true },
		);

		expect(cmd).toContain("--continue");
		expect(cmd).not.toContain("Some task");
	});

	it("Cursor Agent: normal command when resume is not set", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "agent" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).not.toContain("--continue");
		// Cursor injects generic DEV3_SYSTEM_PROMPT (skill body) via prompt (no hooks)
		expect(cmd).toContain("Task Lifecycle Protocol");
		expect(cmd).toContain("dev3 task move");
	});

	// ---- skipSystemPrompt ----
	it("Claude: skips --append-system-prompt when skipSystemPrompt=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig(),
			makeCtx(),
			{ skipSystemPrompt: true },
		);

		expect(cmd).not.toContain("--append-system-prompt");
		expect(cmd).not.toContain("Task Lifecycle Protocol");
	});

	it("Claude: includes --append-system-prompt by default", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig(),
			makeCtx(),
		);

		expect(cmd).toContain("--append-system-prompt");
	});

	it("Claude: includes --append-system-prompt when skipSystemPrompt=false", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig(),
			makeCtx(),
			{ skipSystemPrompt: false },
		);

		expect(cmd).toContain("--append-system-prompt");
	});

	// ---- OpenCode ----
	it("OpenCode: adds --continue when resume=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({ model: "anthropic/claude-opus-4-6" }),
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true },
		);

		expect(cmd).toContain("--continue");
		expect(cmd).not.toContain("Some task");
	});

	it("OpenCode: uses --prompt flag for prompt (not positional)", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({ model: "anthropic/claude-opus-4-6" }),
			makeCtx({ taskDescription: "Fix the login bug" }),
		);

		expect(cmd).toContain("--prompt");
		expect(cmd).toContain("Fix the login bug");
		expect(cmd).toContain("--model anthropic/claude-opus-4-6");
	});

	it("OpenCode: injects generic system prompt (not Claude hooks variant)", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("--prompt");
		expect(cmd).toContain("Task Lifecycle Protocol");
		expect(cmd).toContain("dev3 task move");
		// Generic skill body uses manual status management, not the hooks variant
		expect(cmd).not.toContain("Hooks automatically manage task status");
	});

	it("OpenCode: does not emit --permission-mode, --effort, or --max-budget-usd", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({
				model: "anthropic/claude-opus-4-6",
				permissionMode: "bypassPermissions",
				effort: "high",
				maxBudgetUsd: 10,
			}),
			makeCtx(),
		);

		expect(cmd).not.toContain("--permission-mode");
		expect(cmd).not.toContain("--effort");
		expect(cmd).not.toContain("--max-budget-usd");
	});

	it("OpenCode: does not emit --append-system-prompt", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig(),
			makeCtx(),
		);

		expect(cmd).not.toContain("--append-system-prompt");
	});

	it("OpenCode: passes additionalArgs (e.g. --agent sisyphus)", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({ model: "anthropic/claude-opus-4-6", additionalArgs: ["--agent", "sisyphus"] }),
			makeCtx({ taskDescription: "Build feature" }),
		);

		expect(cmd).toContain("--agent sisyphus");
		expect(cmd).toContain("--model anthropic/claude-opus-4-6");
		expect(cmd).toContain("--prompt");
	});

	// ---- Unsupported agents ----
	it("does not add resume flags for unsupported agents", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "aider" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true },
		);

		expect(cmd).not.toContain("--continue");
		expect(cmd).not.toContain("--resume");
		expect(cmd).not.toContain("resume --last");
		// Unsupported agent still gets the prompt (no resume behavior)
		expect(cmd).toContain("Some task");
	});
});

describe("resolveAgentCommand — empty description (scratch task) opens interactive window", () => {
	// Regression: scratch tasks force an empty description (task-lifecycle.ts).
	// Codex/Cursor/OpenCode have no --append-system-prompt, so the system prompt
	// used to be injected as the positional prompt — which the agent then
	// auto-ran as turn 1. With an empty prompt it must NOT be injected, so the
	// agent opens an empty interactive window (matching Claude).

	it("Codex: empty description → no positional prompt; protocol still arrives via -c", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "" }),
		);

		// No positional prompt — codex opens an empty interactive window …
		expect(cmd).not.toMatch(/ -- /);
		// … but the protocol is still delivered out-of-band (developer message),
		// which is exactly what scratch tasks were missing with prompt-append.
		expect(cmd).toContain("-c 'developer_instructions=");
		expect(cmd).toContain("Task Lifecycle Protocol");
		expect(cmd).toContain(`-c 'tui.theme="dracula"'`);
	});

	it("Cursor Agent: empty description → no positional prompt, no system prompt injected", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "agent" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "" }),
		);

		expect(cmd).not.toContain("Task Lifecycle Protocol");
		expect(cmd).not.toMatch(/ -- /);
	});

	it("OpenCode: empty description → no --prompt, no system prompt injected", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "" }),
		);

		expect(cmd).not.toContain("Task Lifecycle Protocol");
		expect(cmd).not.toContain("--prompt");
	});

	it("Codex: non-empty description still injects description + system prompt", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Fix the login bug" }),
		);

		expect(cmd).toContain("Fix the login bug");
		expect(cmd).toContain("Task Lifecycle Protocol");
	});
});

describe("resolveAgentCommand — positional prompt separator (-- guard)", () => {
	// Regression: GitHub #570. Task descriptions starting with "---" (markdown
	// frontmatter, horizontal rules) were treated as long options by the
	// agent CLI (commander/clap/yargs) and the agent process exited immediately
	// with "error: unknown option '---…'". A literal "--" before the positional
	// prompt terminates option parsing.

	it.each(["claude", "codex", "gemini", "agent"])(
		"%s: emits `-- <prompt>` so a '---'-prefixed description is not parsed as a flag",
		(baseCmd) => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: baseCmd }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "---hello frontmatter" }),
			baseCmd === "claude" ? { sessionId: "11111111-1111-1111-1111-111111111111" } : undefined,
		);

		// Codex / Cursor agents append skill bodies onto the prompt, so we
		// match the prefix `-- '---hello frontmatter` (no closing quote).
		expect(cmd).toContain("-- '---hello frontmatter");
		// The prompt token must not be at the head of args where it could be
		// scanned as an option — it must come strictly after the "--" guard.
		const dashDashIdx = cmd.indexOf(" -- '");
		const promptIdx = cmd.indexOf("'---hello frontmatter");
		expect(dashDashIdx).toBeGreaterThan(0);
		expect(promptIdx).toBeGreaterThan(dashDashIdx);
		},
	);

	it("OpenCode: uses --prompt <value>, so no -- separator is added (value form is unambiguous)", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "---hello frontmatter" }),
		);

		expect(cmd).toContain("--prompt");
		expect(cmd).toContain("'---hello frontmatter");
		expect(cmd).not.toMatch(/ -- '/);
	});

	it("Claude: -- guard is still present for plain descriptions (no regression for normal prompts)", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Fix the login bug" }),
		);

		expect(cmd).toContain("-- 'Fix the login bug'");
	});

	it("does not add -- when resuming (no positional prompt is emitted on resume)", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "---hello frontmatter" }),
			{ resume: true, sessionId: "11111111-1111-1111-1111-111111111111" },
		);

		expect(cmd).not.toContain("---hello frontmatter");
		expect(cmd).not.toMatch(/ -- '/);
	});
});

describe("resolveAgentCommand — sessionId", () => {
	it("Claude: injects --session-id for fresh launch", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig(),
			makeCtx(),
			{ sessionId: "abc-123" },
		);

		expect(cmd).toContain("--session-id abc-123");
		expect(cmd).not.toContain("--resume");
	});

	it("Gemini: injects --session-id for fresh launch (PR #26060)", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "gemini" }),
			makeConfig({ model: undefined }),
			makeCtx(),
			{ sessionId: "gem-fresh" },
		);

		expect(cmd).toContain("--session-id gem-fresh");
		expect(cmd).not.toContain("--resume");
	});

	it("Claude: uses --resume <id> when both resume and sessionId", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig(),
			makeCtx(),
			{ resume: true, sessionId: "abc-123" },
		);

		expect(cmd).toContain("--resume abc-123");
		expect(cmd).not.toContain("--session-id");
		expect(cmd).not.toContain("--continue");
	});

	it("Claude: falls back to --continue when resume without sessionId", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "claude" }),
			makeConfig(),
			makeCtx(),
			{ resume: true },
		);

		expect(cmd).toContain("--continue");
		expect(cmd).not.toContain("--session-id");
	});

	it("Gemini: uses --resume <id> when both resume and sessionId", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "gemini" }),
			makeConfig({ model: undefined }),
			makeCtx(),
			{ resume: true, sessionId: "gem-456" },
		);

		expect(cmd).toContain("--resume gem-456");
		expect(cmd).not.toContain("latest");
	});

	it("Codex: uses session id in resume subcommand", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx(),
			{ resume: true, sessionId: "cdx-789" },
		);

		expect(cmd).toMatch(/^codex resume cdx-789/);
		expect(cmd).not.toContain("--last");
	});

	it("Cursor Agent: injects --resume <id> for fresh launch (creates new thread)", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "agent" }),
			makeConfig({ model: undefined }),
			makeCtx(),
			{ sessionId: "abc-123" },
		);

		expect(cmd).toContain("--resume abc-123");
		expect(cmd).not.toContain("--session-id");
	});

	it("Cursor Agent: uses --resume <id> when both resume and sessionId", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "agent" }),
			makeConfig({ model: undefined }),
			makeCtx(),
			{ resume: true, sessionId: "abc-123" },
		);

		expect(cmd).toContain("--resume abc-123");
		expect(cmd).not.toContain("--continue");
	});

	it("does not inject session id for unsupported agents", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx(),
			{ sessionId: "abc-123" },
		);

		expect(cmd).not.toContain("--session-id");
		expect(cmd).not.toContain("--resume");
	});
});

describe("supportsPreAssignedSessionId", () => {
	it.each([
		["claude", true],
		["agent", true],
		["/usr/local/bin/claude", true],
		["gemini", true],
		["codex", false],
		["bash", false],
		["opencode", false],
	])("%s → %s", (cmd, expected) => {
		expect(supportsPreAssignedSessionId(cmd)).toBe(expected);
	});
});

describe("buildResumeCommand", () => {
	it("Claude: --resume <id> with sessionId", () => {
		expect(buildResumeCommand("claude", "sid-1")).toBe("claude --resume sid-1");
	});

	it("Claude: --continue without sessionId", () => {
		expect(buildResumeCommand("claude")).toBe("claude --continue");
	});

	it("Codex: resume <id> with sessionId", () => {
		expect(buildResumeCommand("codex", "sid-2")).toBe("codex resume sid-2");
	});

	it("Codex: resume --last without sessionId", () => {
		expect(buildResumeCommand("codex")).toBe("codex resume --last");
	});

	it("Gemini: --resume <id> with sessionId", () => {
		expect(buildResumeCommand("gemini", "sid-3")).toBe("gemini --resume sid-3");
	});

	it("Gemini: --resume latest without sessionId", () => {
		expect(buildResumeCommand("gemini")).toBe("gemini --resume latest");
	});

	it("Cursor Agent: --resume <id> with sessionId", () => {
		expect(buildResumeCommand("agent", "sid-4")).toBe("agent --resume sid-4");
	});

	it("Cursor Agent: --continue without sessionId", () => {
		expect(buildResumeCommand("agent")).toBe("agent --continue");
	});

	it("OpenCode: --session <id> with sessionId", () => {
		expect(buildResumeCommand("opencode", "sid-6")).toBe("opencode --session sid-6");
	});

	it("OpenCode: --continue without sessionId", () => {
		expect(buildResumeCommand("opencode")).toBe("opencode --continue");
	});

	it("unsupported agent returns null", () => {
		expect(buildResumeCommand("aider")).toBeNull();
		expect(buildResumeCommand("bash")).toBeNull();
	});

	it("works with full paths", () => {
		expect(buildResumeCommand("/usr/local/bin/claude", "sid-5")).toBe("/usr/local/bin/claude --resume sid-5");
	});
});

describe("applyBinaryPathOverride", () => {
	let dir: string;
	let claudePath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dev3-agents-test-"));
		claudePath = join(dir, "claude");
		writeFileSync(claudePath, "#!/bin/sh\n", { mode: 0o755 });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("applies the cached path when it names the same binary", () => {
		const agent = makeAgent({ baseCommand: "claude" });
		const result = applyBinaryPathOverride(agent, { "test-agent": claudePath });
		expect(result.baseCommand).toBe(claudePath);
	});

	it("ignores a cached path once the base command was edited to another binary", () => {
		const agent = makeAgent({ baseCommand: "claude-codex" });
		const result = applyBinaryPathOverride(agent, { "test-agent": claudePath });
		expect(result.baseCommand).toBe("claude-codex");
	});

	it("ignores a cached path that no longer exists", () => {
		const agent = makeAgent({ baseCommand: "claude" });
		const result = applyBinaryPathOverride(agent, { "test-agent": join(dir, "gone") });
		expect(result.baseCommand).toBe("claude");
	});

	it("applies a user-chosen path whose file name differs from the base command", () => {
		const wrapper = join(dir, "claude-wrapper");
		writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
		const agent = makeAgent({ baseCommand: "claude" });
		const result = applyBinaryPathOverride(agent, undefined, { "test-agent": wrapper });
		expect(result.baseCommand).toBe(wrapper);
	});

	it("prefers the user's path over the auto-cached one", () => {
		const wrapper = join(dir, "claude-wrapper");
		writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
		const agent = makeAgent({ baseCommand: "claude" });
		const result = applyBinaryPathOverride(agent, { "test-agent": claudePath }, { "test-agent": wrapper });
		expect(result.baseCommand).toBe(wrapper);
	});

	// The reported bug: pointing built-in Claude at a differently named binary
	// re-guessed the CLI from the new file name, turning it into an unknown agent
	// that lost resume, hooks and the dev3 protocol. The user only said WHERE the
	// binary is, never that it is a different agent.
	it("keeps the agent's CLI identity when the path renames the binary", () => {
		const wrapper = join(dir, "my-claude");
		writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
		const agent = makeAgent({ baseCommand: "claude" });
		const result = applyBinaryPathOverride(agent, undefined, { "test-agent": wrapper });
		expect(result.baseCommand).toBe(wrapper);
		expect(result.agentFamily).toBe("claude");
		expect(supportsResume(result.baseCommand, result.agentFamily)).toBe(true);
		expect(supportsPreAssignedSessionId(result.baseCommand, result.agentFamily)).toBe(true);
	});

	it("never overrides a family the user declared explicitly", () => {
		const wrapper = join(dir, "my-claude");
		writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
		const agent = makeAgent({ baseCommand: "claude", agentFamily: "none" });
		expect(applyBinaryPathOverride(agent, undefined, { "test-agent": wrapper }).agentFamily).toBe("none");
	});

	it("leaves the family unset when the original command was unrecognized too", () => {
		// Pinning "none" here would be worse than today: the path's own name still
		// deserves its chance (e.g. a custom agent pointed at the real `claude`).
		const real = join(dir, "claude");
		const agent = makeAgent({ baseCommand: "some-wrapper" });
		const result = applyBinaryPathOverride(agent, undefined, { "test-agent": real });
		expect(result.agentFamily).toBeUndefined();
		expect(supportsResume(result.baseCommand, result.agentFamily)).toBe(true);
	});
});

// A custom executable for Claude Code must run through the very same code as
// `claude` itself — the whole point of declaring the family.
describe("a declared family reaches the launch command", () => {
	it("resumes instead of re-sending the task description", () => {
		const agent = makeAgent({ baseCommand: "my-claude", agentFamily: "claude" });
		const cmd = resolveAgentCommand(agent, makeConfig(), makeCtx(), { resume: true, sessionId: "sess-1" });
		expect(cmd).toContain("my-claude --resume sess-1");
		expect(cmd).not.toContain("Fix the login bug");
	});

	it("mints a session id on a fresh launch, so there is something to resume", () => {
		const agent = makeAgent({ baseCommand: "my-claude", agentFamily: "claude" });
		expect(resolveAgentCommand(agent, makeConfig(), makeCtx(), { sessionId: "fresh-1" }))
			.toContain("--session-id fresh-1");
		expect(buildResumeCommand("my-claude", "sess-1", "claude")).toBe("my-claude --resume sess-1");
	});

	it("injects the dev3 protocol and the bypass switch, like plain claude does", () => {
		const agent = makeAgent({ baseCommand: "my-claude", agentFamily: "claude" });
		const cmd = resolveAgentCommand(agent, makeConfig(), makeCtx());
		expect(cmd).toContain("--append-system-prompt");
		expect(cmd).toContain("--allow-dangerously-skip-permissions");
	});

	it("still applies the Claude-only model override", () => {
		const config = makeConfig({ model: "claude-opus-5[1m]" });
		const agent = makeAgent({ baseCommand: "my-claude", agentFamily: "claude" });
		const result = resolveLaunchConfig(config, agent, "my-claude", { ANTHROPIC_DEFAULT_OPUS_MODEL: "pinned-opus" });
		expect(result?.model).toBe("pinned-opus");
	});

	it("leaves an undeclared custom binary on the generic path", () => {
		const agent = makeAgent({ baseCommand: "my-claude" });
		const cmd = resolveAgentCommand(agent, makeConfig(), makeCtx(), { resume: true, sessionId: "sess-1" });
		expect(cmd).not.toContain("--resume");
		expect(cmd).toContain("Fix the login bug");
	});
});

// `hooksIntegration` declared a wrapper's HOOK family only; `agentFamily` now
// governs the whole adapter. Same three values, wider reach — carried over in
// place so a user who already declared his wrapper gains resume for free.
describe("migrateOldFormat — hooksIntegration becomes agentFamily", () => {
	it("carries the declared family over and drops the old key", () => {
		const [agent] = migrateOldFormat([
			{ id: "a", name: "Wrapper", baseCommand: "my-claude", configurations: [], hooksIntegration: "claude" },
		]) as any[];
		expect(agent.agentFamily).toBe("claude");
		expect("hooksIntegration" in agent).toBe(false);
	});

	it("carries the explicit opt-out over too", () => {
		const [agent] = migrateOldFormat([
			{ id: "a", name: "W", baseCommand: "claude", configurations: [], hooksIntegration: "none" },
		]) as any[];
		expect(agent.agentFamily).toBe("none");
	});

	it("leaves an agent that never declared anything alone", () => {
		const [agent] = migrateOldFormat([
			{ id: "a", name: "Claude", baseCommand: "claude", configurations: [] },
		]) as any[];
		expect(agent.agentFamily).toBeUndefined();
	});

	it("lets an already-migrated value win over a stale old key", () => {
		const [agent] = migrateOldFormat([
			{ id: "a", name: "W", baseCommand: "x", configurations: [], hooksIntegration: "codex", agentFamily: "claude" },
		]) as any[];
		expect(agent.agentFamily).toBe("claude");
		expect("hooksIntegration" in agent).toBe(false);
	});
});

describe("mergeWithDefaults — preserves user-defined order", () => {
	it("returns DEFAULT_AGENTS as-is when no stored agents", () => {
		const result = mergeWithDefaults([]);
		expect(result.map((a) => a.id)).toEqual(DEFAULT_AGENTS.map((a) => a.id));
	});

	it("preserves user-reordered agents", () => {
		// User dragged Codex above Claude.
		const stored: CodingAgent[] = [
			{ ...DEFAULT_AGENTS[1] }, // Codex
			{ ...DEFAULT_AGENTS[0] }, // Claude
		];
		const result = mergeWithDefaults(stored);
		expect(result[0].id).toBe("builtin-codex");
		expect(result[1].id).toBe("builtin-claude");
	});

	it("preserves user-reordered configurations within an agent", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		// Reverse a few default configs.
		const reorderedConfigs = [
			claude.configurations.find((c) => c.id === "claude-plan")!,
			claude.configurations.find((c) => c.id === "claude-plan-sonnet5")!,
			claude.configurations.find((c) => c.id === "claude-default")!,
		];
		// Plus the rest unchanged.
		const others = claude.configurations.filter(
			(c) => !["claude-plan", "claude-plan-sonnet5", "claude-default"].includes(c.id),
		);
		const stored: CodingAgent[] = [
			{ ...claude, configurations: [...reorderedConfigs, ...others] },
		];
		const result = mergeWithDefaults(stored);
		const claudeResult = result.find((a) => a.id === "builtin-claude")!;
		expect(claudeResult.configurations[0].id).toBe("claude-plan");
		expect(claudeResult.configurations[1].id).toBe("claude-plan-sonnet5");
		expect(claudeResult.configurations[2].id).toBe("claude-default");
	});

	it("appends newly added default agents at the end without disturbing stored order", () => {
		// Stored has only Codex; defaults have Claude+Codex+others. New defaults should append.
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const stored: CodingAgent[] = [{ ...codex }];
		const result = mergeWithDefaults(stored);
		expect(result[0].id).toBe("builtin-codex");
		// All other defaults present somewhere in result.
		for (const def of DEFAULT_AGENTS) {
			expect(result.some((a) => a.id === def.id)).toBe(true);
		}
	});

	it("appends newly added default configurations within an agent without disturbing stored order", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		// Stored has only the first 3 configs of Claude (older snapshot).
		const stored: CodingAgent[] = [
			{ ...claude, configurations: claude.configurations.slice(0, 3) },
		];
		const result = mergeWithDefaults(stored);
		const claudeResult = result.find((a) => a.id === "builtin-claude")!;
		// First 3 unchanged.
		expect(claudeResult.configurations[0].id).toBe(claude.configurations[0].id);
		expect(claudeResult.configurations[1].id).toBe(claude.configurations[1].id);
		expect(claudeResult.configurations[2].id).toBe(claude.configurations[2].id);
		// All default configs present.
		for (const def of claude.configurations) {
			expect(claudeResult.configurations.some((c) => c.id === def.id)).toBe(true);
		}
	});

	it("drops superseded prerelease GPT-5.6 preset ids", () => {
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const interimIds = [
			"codex-5.6-heavy-bypass",
			"codex-5.6-heavy",
			"codex-5.6-medium-bypass",
			"codex-5.6-medium",
			"codex-5.6-terra-xhigh",
			"codex-5.6-luna-low-bypass",
			"codex-5.6-luna-low",
		];
		const stored: CodingAgent[] = [{
			...codex,
			configurations: [
				...codex.configurations,
				...interimIds.map((id) => ({ id, name: id, model: "gpt-5.6-sol" })),
			],
		}];

		const mergedCodex = mergeWithDefaults(stored).find((agent) => agent.id === "builtin-codex")!;
		expect(mergedCodex.configurations.some((config) => interimIds.includes(config.id))).toBe(false);
	});

	it("ships canonical model labels on every Codex preset", () => {
		const codex = DEFAULT_AGENTS.find((agent) => agent.id === "builtin-codex")!;
		const expectedLabels: Record<string, string> = {
			"gpt-5.6-sol": "GPT-5.6 Sol",
			"gpt-5.6-terra": "GPT-5.6 Terra",
			"gpt-5.6-luna": "GPT-5.6 Luna",
			"gpt-5.5": "GPT-5.5",
		};

		for (const config of codex.configurations) {
			expect(config.groupLabel).toBe(expectedLabels[config.model!]);
		}
	});

	it("refreshes presentation labels when a built-in preset version increases", () => {
		const codex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const currentDefault = codex.configurations.find((config) => config.id === "codex-default")!;
		const stored: CodingAgent[] = [{
			...codex,
			configurations: [{
				...currentDefault,
				name: "Old default name",
				modeLabel: "Old mode label",
				groupLabel: "Old model label",
				version: (currentDefault.version ?? 1) - 1,
			}],
		}];

		const mergedDefault = mergeWithDefaults(stored)
			.find((agent) => agent.id === "builtin-codex")!
			.configurations.find((config) => config.id === "codex-default")!;
		expect({
			name: mergedDefault.name,
			modeLabel: mergedDefault.modeLabel,
			groupLabel: mergedDefault.groupLabel,
		}).toEqual({
			name: currentDefault.name,
			modeLabel: currentDefault.modeLabel,
			groupLabel: currentDefault.groupLabel,
		});
	});

	it("keeps user-created configurations in their original position", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		const userCfg: AgentConfiguration = {
			id: "user-custom-1",
			name: "My Plan Variant",
			model: "sonnet",
			permissionMode: "plan",
		};
		// Place user config between Plan and Bypass groups.
		const planIdx = claude.configurations.findIndex((c) => c.id === "claude-plan-sonnet");
		const stored: CodingAgent[] = [
			{
				...claude,
				configurations: [
					...claude.configurations.slice(0, planIdx + 1),
					userCfg,
					...claude.configurations.slice(planIdx + 1),
				],
			},
		];
		const result = mergeWithDefaults(stored);
		const claudeResult = result.find((a) => a.id === "builtin-claude")!;
		const userIdx = claudeResult.configurations.findIndex((c) => c.id === "user-custom-1");
		const planSonnetIdx = claudeResult.configurations.findIndex((c) => c.id === "claude-plan-sonnet");
		expect(userIdx).toBe(planSonnetIdx + 1);
	});
});

describe("mergeMcpApproval", () => {
	it("defaults to enableAllProjectMcpServers when no inputs", () => {
		const result = mergeMcpApproval({}, []);
		expect(result.enableAllProjectMcpServers).toBe(true);
		expect(result.enabledMcpjsonServers).toBeUndefined();
		expect(result.disabledMcpjsonServers).toBeUndefined();
	});

	it("defaults to enableAll when project sources are all null", () => {
		const result = mergeMcpApproval({}, [null, null]);
		expect(result.enableAllProjectMcpServers).toBe(true);
	});

	it("preserves existing worktree settings unrelated to MCP", () => {
		const result = mergeMcpApproval({ permissions: { allow: ["Bash(ls *)"] } }, []);
		expect(result.permissions).toEqual({ allow: ["Bash(ls *)"] });
		expect(result.enableAllProjectMcpServers).toBe(true);
	});

	it("respects explicit enableAll=false from project source", () => {
		const result = mergeMcpApproval({}, [{ enableAllProjectMcpServers: false }]);
		expect(result.enableAllProjectMcpServers).toBe(false);
	});

	it("merges enabled/disabled server names from project sources", () => {
		const result = mergeMcpApproval({}, [
			{ enabledMcpjsonServers: ["nile-docs", "nile"], disabledMcpjsonServers: ["scary"] },
			{ enabledMcpjsonServers: ["nile-reports"] },
		]);
		expect(result.enabledMcpjsonServers).toEqual(["nile-docs", "nile", "nile-reports"]);
		expect(result.disabledMcpjsonServers).toEqual(["scary"]);
	});

	it("later project source overrides earlier enableAll boolean", () => {
		const result = mergeMcpApproval({}, [
			{ enableAllProjectMcpServers: true },
			{ enableAllProjectMcpServers: false },
		]);
		expect(result.enableAllProjectMcpServers).toBe(false);
	});

	it("keeps existing enabled/disabled lists from worktree settings", () => {
		const result = mergeMcpApproval(
			{ enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["b"] },
			[{ enabledMcpjsonServers: ["c"] }],
		);
		expect(result.enabledMcpjsonServers).toEqual(["a", "c"]);
		expect(result.disabledMcpjsonServers).toEqual(["b"]);
	});

	it("ignores non-string entries in *McpjsonServers arrays", () => {
		const result = mergeMcpApproval({}, [
			{ enabledMcpjsonServers: ["a", 42, null, "b"] as unknown[] },
		]);
		expect(result.enabledMcpjsonServers).toEqual(["a", "b"]);
	});
});

describe("applyLayoutResync", () => {
	it("reorders a stale legacy config order to match the current DEFAULT_AGENTS order", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		// Simulate a fossilized stored order — reverse of the current declared order.
		const staleOrder = [...claude.configurations].reverse();
		const stored: CodingAgent[] = [{ ...claude, configurations: staleOrder }];

		const result = applyLayoutResync(stored);
		const resyncedClaude = result.find((a) => a.id === "builtin-claude")!;

		expect(resyncedClaude.configurations.map((c) => c.id)).toEqual(
			claude.configurations.map((c) => c.id),
		);
	});

	it("appends user-created configs after the resynced built-ins, preserving their relative order", () => {
		const claude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		const custom: AgentConfiguration = { id: "my-custom-config", name: "My Custom" };
		const stored: CodingAgent[] = [
			{ ...claude, configurations: [custom, ...[...claude.configurations].reverse()] },
		];

		const result = applyLayoutResync(stored);
		const resyncedClaude = result.find((a) => a.id === "builtin-claude")!;

		const ids = resyncedClaude.configurations.map((c) => c.id);
		expect(ids[ids.length - 1]).toBe("my-custom-config");
		expect(ids.slice(0, -1)).toEqual(claude.configurations.map((c) => c.id));
	});

	it("leaves fully custom agents untouched", () => {
		const custom = makeAgent({
			id: "my-custom-agent",
			configurations: [{ id: "b", name: "B" }, { id: "a", name: "A" }],
		});
		const result = applyLayoutResync([custom]);
		expect(result[0].configurations.map((c) => c.id)).toEqual(["b", "a"]);
	});
});


describe("applyProviderModel — flag-delivered backends rewrite the model alias", () => {
	const codexOnBedrock = (providerConfig?: CodingAgent["providerConfig"]) =>
		makeAgent({ baseCommand: "codex", llmProvider: "bedrock-codex", providerConfig });

	it("rewrites a codex alias to the mapped Bedrock id", () => {
		const config = makeConfig({ model: "gpt-5.6-sol" });
		const result = applyProviderModel(config, codexOnBedrock());
		expect(result?.model).toBe("openai.gpt-5.6-sol");
		// Original config is not mutated.
		expect(config.model).toBe("gpt-5.6-sol");
	});

	it("a per-model manual override wins over the map", () => {
		const config = makeConfig({ model: "gpt-5.6-sol" });
		const result = applyProviderModel(
			config,
			codexOnBedrock({ "bedrock-codex": { modelOverrides: { "gpt-5.6-sol": "openai.custom" } } }),
		);
		expect(result?.model).toBe("openai.custom");
	});

	it("does nothing on the native default", () => {
		const config = makeConfig({ model: "gpt-5.6-sol" });
		expect(applyProviderModel(config, makeAgent({ baseCommand: "codex" }))).toBe(config);
	});

	it("does nothing for env-delivering backends (Claude on Bedrock keeps its alias; --model is omitted)", () => {
		const config = makeConfig({ model: "claude-opus-4-8[1m]" });
		expect(applyProviderModel(config, makeAgent({ baseCommand: "claude", llmProvider: "bedrock" }))).toBe(config);
	});

	it("ignores a provider registered for a different agent command", () => {
		const config = makeConfig({ model: "gpt-5.6-sol" });
		expect(applyProviderModel(config, makeAgent({ baseCommand: "gemini", llmProvider: "bedrock-codex" }))).toBe(config);
	});
});

describe("resolveLaunchConfig — the shared launch-time model pipeline", () => {
	it("rewrites a codex alias to the pinned Bedrock id (provider step applies)", () => {
		const agent = makeAgent({ baseCommand: "codex", llmProvider: "bedrock-codex" });
		const config = makeConfig({ model: "gpt-5.6-sol" });
		const result = resolveLaunchConfig(config, agent, "codex", {});
		expect(result?.model).toBe("openai.gpt-5.6-sol");
	});

	it("applies the session-env model override after the provider step (claude)", () => {
		const agent = makeAgent({ baseCommand: "claude" });
		const config = makeConfig({ model: "sonnet" });
		const result = resolveLaunchConfig(config, agent, "claude", { ANTHROPIC_MODEL: "my-model" });
		expect(result?.model).toBe("my-model");
	});

	it("is a no-op for a native codex config with no session env", () => {
		const config = makeConfig({ model: "gpt-5.6-sol" });
		expect(resolveLaunchConfig(config, makeAgent({ baseCommand: "codex" }), "codex", {})).toBe(config);
	});
});

describe("applyModelOverride — API profile model beats the preset --model flag", () => {
	it("replaces the preset model when ANTHROPIC_MODEL is in the session env", () => {
		const config = makeConfig({ model: "claude-opus-4-8[1m]" });
		const result = applyModelOverride(config, "claude", { ANTHROPIC_MODEL: "openrouter/custom" });
		expect(result?.model).toBe("openrouter/custom");
		// Original config is not mutated.
		expect(config.model).toBe("claude-opus-4-8[1m]");
	});

	it("produces a command with the overridden --model", () => {
		const config = applyModelOverride(makeConfig({ model: "sonnet" }), "claude", { ANTHROPIC_MODEL: "my-model" });
		const cmd = resolveAgentCommand(makeAgent(), config, makeCtx());
		expect(cmd).toContain("--model my-model");
		expect(cmd).not.toContain("--model sonnet");
	});

	it("does nothing without ANTHROPIC_MODEL in the env", () => {
		const config = makeConfig({ model: "sonnet" });
		expect(applyModelOverride(config, "claude", {})).toBe(config);
	});

	it("does nothing for non-Claude commands", () => {
		const config = makeConfig({ model: "gpt-5.5" });
		expect(applyModelOverride(config, "codex", { ANTHROPIC_MODEL: "my-model" })).toBe(config);
	});

	it("returns undefined config unchanged (env alone wins when no flag is emitted)", () => {
		expect(applyModelOverride(undefined, "claude", { ANTHROPIC_MODEL: "my-model" })).toBeUndefined();
	});

	it("rewrites the preset to the family-slot override (dev3 presets pass concrete ids)", () => {
		const config = makeConfig({ model: "claude-opus-4-8[1m]" });
		const result = applyModelOverride(config, "claude", { ANTHROPIC_DEFAULT_OPUS_MODEL: "openrouter/opus-alt" });
		expect(result?.model).toBe("openrouter/opus-alt");
	});

	it("prefers the family-slot override over a bare ANTHROPIC_MODEL", () => {
		const config = makeConfig({ model: "claude-sonnet-5" });
		const result = applyModelOverride(config, "claude", {
			ANTHROPIC_DEFAULT_SONNET_MODEL: "provider/sonnet",
			ANTHROPIC_MODEL: "provider/generic",
		});
		expect(result?.model).toBe("provider/sonnet");
	});

	it("keeps the preset when the model's family has no override", () => {
		const config = makeConfig({ model: "claude-fable-5" });
		// Only an opus override is present — fable is untouched, no ANTHROPIC_MODEL fallback.
		expect(applyModelOverride(config, "claude", { ANTHROPIC_DEFAULT_OPUS_MODEL: "x" })).toBe(config);
	});

	it("ignores ENV_UNSET sentinels — they mean 'unset', not a model id", () => {
		const config = makeConfig({ model: "claude-opus-4-8[1m]" });
		const env = { ANTHROPIC_DEFAULT_OPUS_MODEL: ENV_UNSET, ANTHROPIC_MODEL: ENV_UNSET };
		expect(applyModelOverride(config, "claude", env)).toBe(config);
	});
});

describe("claudeModelFamily", () => {
	it("classifies dev3 preset model ids into alias families", () => {
		expect(claudeModelFamily("claude-opus-4-8[1m]")).toBe("opus");
		expect(claudeModelFamily("claude-sonnet-5")).toBe("sonnet");
		expect(claudeModelFamily("claude-haiku-4-5")).toBe("haiku");
		expect(claudeModelFamily("claude-fable-5")).toBe("fable");
		expect(claudeModelFamily("openrouter/deepseek-v4")).toBeNull();
	});
});
