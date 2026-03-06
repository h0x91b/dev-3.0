import { describe, expect, it } from "vitest";
import { resolveAgentCommand, type TemplateContext } from "../agents";
import type { AgentConfiguration, CodingAgent } from "../../shared/types";

const makeAgent = (overrides?: Partial<CodingAgent>): CodingAgent => ({
	id: "test-claude",
	name: "Claude",
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

describe("resolveAgentCommand", () => {
	it("adds --continue and skips prompt when resume=true for Claude", () => {
		const cmd = resolveAgentCommand(
			makeAgent(),
			makeConfig(),
			makeCtx({ taskDescription: "Some task description" }),
			{ resume: true },
		);

		expect(cmd).toContain("--continue");
		expect(cmd).not.toContain("Some task description");
	});

	it("includes prompt normally when resume is not set", () => {
		const cmd = resolveAgentCommand(
			makeAgent(),
			makeConfig(),
			makeCtx({ taskDescription: "Some task description" }),
		);

		expect(cmd).not.toContain("--continue");
		expect(cmd).toContain("Some task description");
	});

	it("does not add --continue for non-Claude agents even with resume=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent({ baseCommand: "codex" }),
			makeConfig(),
			makeCtx({ taskDescription: "Some task" }),
			{ resume: true },
		);

		expect(cmd).not.toContain("--continue");
		// Non-Claude agent should still include prompt
		expect(cmd).toContain("Some task");
	});

	it("skips appendPrompt when resume=true for Claude", () => {
		const cmd = resolveAgentCommand(
			makeAgent(),
			makeConfig({ appendPrompt: "Extra instructions: {{TASK_TITLE}}" }),
			makeCtx({ taskDescription: "" }),
			{ resume: true },
		);

		expect(cmd).toContain("--continue");
		expect(cmd).not.toContain("Extra instructions");
		expect(cmd).not.toContain("Fix bug");
	});

	it("still includes --append-system-prompt when resume=true", () => {
		const cmd = resolveAgentCommand(
			makeAgent(),
			makeConfig(),
			makeCtx(),
			{ resume: true },
		);

		expect(cmd).toContain("--append-system-prompt");
	});
});
