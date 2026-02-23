import { describe, it, expect, vi } from "vitest";

// Mock bun-specific modules before importing agents
vi.mock("../../bun/logger", () => ({
	createLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../../bun/paths", () => ({
	DEV3_HOME: "/tmp/test-dev3",
}));

import {
	mergeWithDefaults,
	migrateOldFormat,
	interpolateTemplate,
	shellEscape,
	findConfig,
	resolveAgentCommand,
	buildTaskEnv,
} from "../../bun/agents";
import type { TemplateContext } from "../../bun/agents";
import type { CodingAgent, AgentConfiguration, Project } from "../../shared/types";
import { DEFAULT_AGENTS } from "../../shared/types";

// ---- helpers ----

function makeAgent(overrides: Partial<CodingAgent> & { id: string }): CodingAgent {
	return {
		name: "Test",
		baseCommand: "test-cmd",
		configurations: [{ id: `${overrides.id}-cfg`, name: "Default" }],
		defaultConfigId: `${overrides.id}-cfg`,
		...overrides,
	};
}

function makeCtx(overrides?: Partial<TemplateContext>): TemplateContext {
	return {
		taskTitle: "Fix bug",
		taskDescription: "Fix the login bug",
		projectName: "my-project",
		projectPath: "/home/user/project",
		worktreePath: "/tmp/wt-123",
		...overrides,
	};
}

function makeProject(overrides?: Partial<Project>): Project {
	return {
		id: "proj-1",
		name: "test-project",
		path: "/home/user/project",
		setupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-01-01",
		...overrides,
	};
}

// ---- mergeWithDefaults ----

describe("mergeWithDefaults", () => {
	it("returns all defaults when stored is empty", () => {
		const result = mergeWithDefaults([]);
		expect(result.length).toBe(DEFAULT_AGENTS.length);
		for (const def of DEFAULT_AGENTS) {
			const found = result.find((a) => a.id === def.id);
			expect(found).toBeDefined();
			expect(found!.isDefault).toBe(true);
			expect(found!.configurations.length).toBe(def.configurations.length);
		}
	});

	it("keeps stored agent properties but sets isDefault flag", () => {
		const stored: CodingAgent[] = [
			{
				id: "builtin-claude",
				name: "My Claude",
				baseCommand: "claude-custom",
				configurations: [{ id: "claude-default", name: "Old Default" }],
				defaultConfigId: "claude-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const claude = result.find((a) => a.id === "builtin-claude")!;
		expect(claude.name).toBe("My Claude");
		expect(claude.baseCommand).toBe("claude-custom");
		expect(claude.isDefault).toBe(true);
	});

	it("appends new default configurations to existing stored agent", () => {
		// Stored Claude with only the old "Default" config
		const stored: CodingAgent[] = [
			{
				id: "builtin-claude",
				name: "Claude",
				baseCommand: "claude",
				configurations: [{ id: "claude-default", name: "Default" }],
				defaultConfigId: "claude-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const claude = result.find((a) => a.id === "builtin-claude")!;

		// Should have original + all new predefined configs from DEFAULT_AGENTS
		const defaultClaude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		const expectedNewConfigs = defaultClaude.configurations.filter(
			(c) => c.id !== "claude-default",
		);
		expect(claude.configurations.length).toBe(1 + expectedNewConfigs.length);

		// Original config is first
		expect(claude.configurations[0].id).toBe("claude-default");
		expect(claude.configurations[0].name).toBe("Default");

		// All new defaults appended
		for (const expected of expectedNewConfigs) {
			const found = claude.configurations.find((c) => c.id === expected.id);
			expect(found).toBeDefined();
			expect(found!.name).toBe(expected.name);
		}
	});

	it("does not duplicate configs that already exist in stored agent", () => {
		const defaultClaude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		// Stored agent already has all default configs
		const stored: CodingAgent[] = [
			{
				id: "builtin-claude",
				name: "Claude",
				baseCommand: "claude",
				configurations: [...defaultClaude.configurations],
				defaultConfigId: "claude-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const claude = result.find((a) => a.id === "builtin-claude")!;
		expect(claude.configurations.length).toBe(defaultClaude.configurations.length);
	});

	it("preserves user-modified configs while appending new defaults", () => {
		const stored: CodingAgent[] = [
			{
				id: "builtin-claude",
				name: "Claude",
				baseCommand: "claude",
				configurations: [
					{ id: "claude-default", name: "My Custom Name", model: "haiku" },
					{ id: "user-custom-cfg", name: "My Extra Config" },
				],
				defaultConfigId: "claude-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const claude = result.find((a) => a.id === "builtin-claude")!;

		// User's modified default should be preserved
		const userDefault = claude.configurations.find((c) => c.id === "claude-default")!;
		expect(userDefault.name).toBe("My Custom Name");
		expect(userDefault.model).toBe("haiku");

		// User's custom config should be preserved
		const userCustom = claude.configurations.find((c) => c.id === "user-custom-cfg");
		expect(userCustom).toBeDefined();

		// New default configs should be appended
		const defaultClaude = DEFAULT_AGENTS.find((a) => a.id === "builtin-claude")!;
		const expectedNew = defaultClaude.configurations.filter(
			(c) => c.id !== "claude-default",
		);
		for (const exp of expectedNew) {
			expect(claude.configurations.find((c) => c.id === exp.id)).toBeDefined();
		}
	});

	it("preserves user-created (non-default) agents after defaults", () => {
		const userAgent = makeAgent({ id: "user-aider", name: "Aider", baseCommand: "aider" });
		const stored: CodingAgent[] = [userAgent];
		const result = mergeWithDefaults(stored);

		// All defaults come first
		for (let i = 0; i < DEFAULT_AGENTS.length; i++) {
			expect(result[i].id).toBe(DEFAULT_AGENTS[i].id);
		}
		// User agent is at the end
		const last = result[result.length - 1];
		expect(last.id).toBe("user-aider");
		expect(last.name).toBe("Aider");
		expect(last.isDefault).toBeUndefined();
	});

	it("adds missing default agents when only some are stored", () => {
		// Only Claude is stored, Codex and Gemini are missing
		const stored: CodingAgent[] = [
			{
				id: "builtin-claude",
				name: "Claude",
				baseCommand: "claude",
				configurations: [{ id: "claude-default", name: "Default" }],
			},
		];
		const result = mergeWithDefaults(stored);
		expect(result.find((a) => a.id === "builtin-codex")).toBeDefined();
		expect(result.find((a) => a.id === "builtin-gemini")).toBeDefined();
	});
});

// ---- migrateOldFormat ----

describe("migrateOldFormat", () => {
	it("returns empty array for empty input", () => {
		expect(migrateOldFormat([])).toEqual([]);
	});

	it("migrates old kind-based custom agents", () => {
		const old = [
			{ id: "builtin-1", kind: "builtin", name: "Claude" },
			{ id: "custom-1", kind: "custom", name: "Aider", command: "aider" },
			{ id: "custom-2", kind: "custom", name: "MyTool", command: "my-tool" },
		];
		const result = migrateOldFormat(old);

		// Built-ins are skipped, only custom agents migrated
		expect(result.length).toBe(2);
		expect(result[0].id).toBe("custom-1");
		expect(result[0].name).toBe("Aider");
		expect(result[0].baseCommand).toBe("aider");
		expect(result[0].configurations.length).toBe(1);
		expect(result[0].configurations[0].name).toBe("Default");
		expect(result[0].defaultConfigId).toBe("custom-1-default");
	});

	it("uses 'bash' as fallback command for old agents without command", () => {
		const old = [{ id: "c1", kind: "custom", name: "NoCmd" }];
		const result = migrateOldFormat(old);
		expect(result[0].baseCommand).toBe("bash");
	});

	it("returns new-format data as-is", () => {
		const agents: CodingAgent[] = [
			makeAgent({ id: "test-1", name: "Test Agent" }),
		];
		const result = migrateOldFormat(agents);
		expect(result).toEqual(agents);
	});
});

// ---- interpolateTemplate ----

describe("interpolateTemplate", () => {
	const ctx = makeCtx();

	it("replaces all known variables", () => {
		const tpl = "Title: {{TASK_TITLE}}, Project: {{PROJECT_NAME}}, Path: {{PROJECT_PATH}}, WT: {{WORKTREE_PATH}}";
		const result = interpolateTemplate(tpl, ctx);
		expect(result).toBe(
			"Title: Fix bug, Project: my-project, Path: /home/user/project, WT: /tmp/wt-123",
		);
	});

	it("replaces TASK_DESCRIPTION", () => {
		expect(interpolateTemplate("{{TASK_DESCRIPTION}}", ctx)).toBe("Fix the login bug");
	});

	it("replaces unknown variables with empty string", () => {
		expect(interpolateTemplate("{{UNKNOWN_VAR}}", ctx)).toBe("");
	});

	it("returns string as-is if no variables", () => {
		expect(interpolateTemplate("no vars here", ctx)).toBe("no vars here");
	});

	it("handles multiple occurrences of the same variable", () => {
		expect(interpolateTemplate("{{TASK_TITLE}} and {{TASK_TITLE}}", ctx)).toBe(
			"Fix bug and Fix bug",
		);
	});
});

// ---- shellEscape ----

describe("shellEscape", () => {
	it("wraps string in single quotes", () => {
		expect(shellEscape("hello")).toBe("'hello'");
	});

	it("escapes single quotes inside string", () => {
		expect(shellEscape("it's a test")).toBe("'it'\\''s a test'");
	});

	it("handles empty string", () => {
		expect(shellEscape("")).toBe("''");
	});
});

// ---- findConfig ----

describe("findConfig", () => {
	const agent: CodingAgent = {
		id: "a1",
		name: "Test",
		baseCommand: "test",
		configurations: [
			{ id: "cfg-1", name: "First" },
			{ id: "cfg-2", name: "Second" },
			{ id: "cfg-3", name: "Third" },
		],
		defaultConfigId: "cfg-2",
	};

	it("returns matching config by id", () => {
		expect(findConfig(agent, "cfg-3")!.name).toBe("Third");
	});

	it("falls back to defaultConfigId when configId is null", () => {
		expect(findConfig(agent, null)!.name).toBe("Second");
	});

	it("falls back to defaultConfigId when configId is undefined", () => {
		expect(findConfig(agent, undefined)!.name).toBe("Second");
	});

	it("falls back to first config when configId is invalid", () => {
		expect(findConfig(agent, "nonexistent")!.name).toBe("First");
	});

	it("falls back to first config when no defaultConfigId and no configId", () => {
		const noDefault: CodingAgent = { ...agent, defaultConfigId: undefined };
		expect(findConfig(noDefault, null)!.name).toBe("First");
	});
});

// ---- resolveAgentCommand ----

describe("resolveAgentCommand", () => {
	const agent: CodingAgent = {
		id: "a1",
		name: "Claude",
		baseCommand: "claude",
		configurations: [],
	};
	const ctx = makeCtx();

	it("builds basic command with no config", () => {
		const cmd = resolveAgentCommand(agent, undefined, ctx);
		expect(cmd).toBe("claude 'Fix the login bug'");
	});

	it("adds --model flag from config", () => {
		const config: AgentConfiguration = { id: "c1", name: "Test", model: "opus" };
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).toContain("--model opus");
	});

	it("adds --permission-mode flag", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			permissionMode: "plan",
		};
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).toContain("--permission-mode plan");
	});

	it("does not add --permission-mode when set to 'default'", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			permissionMode: "default",
		};
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).not.toContain("--permission-mode");
	});

	it("adds --effort flag", () => {
		const config: AgentConfiguration = { id: "c1", name: "Test", effort: "high" };
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).toContain("--effort high");
	});

	it("adds --max-budget-usd flag", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			maxBudgetUsd: 5.5,
		};
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).toContain("--max-budget-usd 5.5");
	});

	it("does not add --max-budget-usd when 0", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			maxBudgetUsd: 0,
		};
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).not.toContain("--max-budget-usd");
	});

	it("appends additionalArgs", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			additionalArgs: ["--verbose", "--debug"],
		};
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).toContain("--verbose --debug");
	});

	it("appends interpolated appendPrompt to task description", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			appendPrompt: "Project: {{PROJECT_NAME}}",
		};
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).toContain("Fix the login bug\n\nProject: my-project");
	});

	it("uses baseCommandOverride when set", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			baseCommandOverride: "my-claude-wrapper",
		};
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).toMatch(/^my-claude-wrapper /);
	});

	it("builds full command with all config fields", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Full",
			model: "opus",
			permissionMode: "bypassPermissions",
			effort: "high",
			maxBudgetUsd: 10,
			additionalArgs: ["--verbose"],
			appendPrompt: "Extra: {{TASK_TITLE}}",
			baseCommandOverride: "my-claude",
		};
		const cmd = resolveAgentCommand(agent, config, ctx);

		expect(cmd).toMatch(/^my-claude /);
		expect(cmd).toContain("--model opus");
		expect(cmd).toContain("--permission-mode bypassPermissions");
		expect(cmd).toContain("--effort high");
		expect(cmd).toContain("--max-budget-usd 10");
		expect(cmd).toContain("--verbose");
		expect(cmd).toContain("Extra: Fix bug");
	});

	it("handles empty task description with appendPrompt", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			appendPrompt: "Do work on {{PROJECT_NAME}}",
		};
		const emptyCtx = makeCtx({ taskDescription: "" });
		const cmd = resolveAgentCommand(agent, config, emptyCtx);
		expect(cmd).toContain("Do work on my-project");
	});
});

// ---- buildTaskEnv ----

describe("buildTaskEnv", () => {
	it("sets DEV3_* env vars", () => {
		const project = makeProject();
		const env = buildTaskEnv(project, "My Task", "task-1", "/tmp/wt");
		expect(env.DEV3_TASK_TITLE).toBe("My Task");
		expect(env.DEV3_TASK_ID).toBe("task-1");
		expect(env.DEV3_PROJECT_NAME).toBe("test-project");
		expect(env.DEV3_PROJECT_PATH).toBe("/home/user/project");
		expect(env.DEV3_WORKTREE_PATH).toBe("/tmp/wt");
	});

	it("merges config envVars", () => {
		const project = makeProject();
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			envVars: { ANTHROPIC_BASE_URL: "https://custom.api", MY_VAR: "hello" },
		};
		const env = buildTaskEnv(project, "Task", "t1", "/tmp/wt", config);
		expect(env.ANTHROPIC_BASE_URL).toBe("https://custom.api");
		expect(env.MY_VAR).toBe("hello");
		// DEV3 vars still present
		expect(env.DEV3_TASK_TITLE).toBe("Task");
	});

	it("config envVars can override DEV3 vars", () => {
		const project = makeProject();
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			envVars: { DEV3_TASK_TITLE: "overridden" },
		};
		const env = buildTaskEnv(project, "Original", "t1", "/tmp/wt", config);
		expect(env.DEV3_TASK_TITLE).toBe("overridden");
	});

	it("returns only DEV3 vars when no config", () => {
		const project = makeProject();
		const env = buildTaskEnv(project, "Task", "t1", "/tmp/wt");
		const keys = Object.keys(env);
		expect(keys.every((k) => k.startsWith("DEV3_"))).toBe(true);
	});
});
