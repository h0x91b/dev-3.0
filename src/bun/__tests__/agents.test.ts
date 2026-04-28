import { beforeEach, describe, expect, it } from "vitest";
import { resolveAgentCommand, supportsResume, supportsPreAssignedSessionId, buildResumeCommand, isOpenCodeCommand, type TemplateContext } from "../agents";
import type { AgentConfiguration, CodingAgent } from "../../shared/types";
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
});

describe("isOpenCodeCommand", () => {
	it.each([
		["opencode", true],
		["/opt/homebrew/bin/opencode", true],
		["claude", false],
		["codex", false],
		["bash", false],
	])("%s → %s", (cmd, expected) => {
		expect(isOpenCodeCommand(cmd)).toBe(expected);
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

	it("Codex: injects the dev3 reminder into new-session prompts", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
		);

		// Codex skill body includes the hook-aware status section and the
		// codex shell note (`shell="/bin/bash"`).
		expect(cmd).toContain("Task Lifecycle Protocol");
		expect(cmd).toContain("Codex sessions started after the dev3 config was installed");
		expect(cmd).toContain("shell=\"/bin/bash\"");
		expect(cmd).toContain("user-questions");
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
		["codex", false],
		["gemini", false],
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
