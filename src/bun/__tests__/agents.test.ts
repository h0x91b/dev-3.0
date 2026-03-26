import { describe, expect, it } from "vitest";
import { resolveAgentCommand, supportsResume, isOpenCodeCommand, type TemplateContext } from "../agents";
import type { AgentConfiguration, CodingAgent } from "../../shared/types";

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
		// Cursor injects DEV3_SYSTEM_PROMPT via prompt
		expect(cmd).toContain("MANDATORY");
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
		expect(cmd).not.toContain("MANDATORY");
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

	it("OpenCode: injects DEV3_SYSTEM_PROMPT into --prompt", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "opencode" }),
			makeConfig({ model: undefined }),
			makeCtx({ taskDescription: "Some task" }),
		);

		expect(cmd).toContain("--prompt");
		expect(cmd).toContain("MANDATORY");
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
