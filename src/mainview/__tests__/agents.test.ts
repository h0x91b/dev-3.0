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
	isClaudeCommand,
	getDefaultEnvForAgent,
	CLAUDE_DEFAULT_ENV,
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
		devScript: "",
		cleanupScript: "",
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

	it("fills missing fields from defaults for stored default configs", () => {
		// Stored Codex agent with a bare "Default" config (no model, no additionalArgs)
		const stored: CodingAgent[] = [
			{
				id: "builtin-codex",
				name: "Codex",
				baseCommand: "codex",
				configurations: [{ id: "codex-default", name: "Default" }],
				defaultConfigId: "codex-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const codex = result.find((a) => a.id === "builtin-codex")!;
		const cfg = codex.configurations.find((c) => c.id === "codex-default")!;

		// Default model should be filled in
		const defCodex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const defCfg = defCodex.configurations.find((c) => c.id === "codex-default")!;
		expect(cfg.model).toBe(defCfg.model);
		expect(cfg.additionalArgs).toEqual(defCfg.additionalArgs);

		// User's explicit name should still win
		expect(cfg.name).toBe("Default");
	});

	it("user overrides still win over defaults when versions match", () => {
		const stored: CodingAgent[] = [
			{
				id: "builtin-codex",
				name: "Codex",
				baseCommand: "codex",
				configurations: [
					{ id: "codex-default", name: "My Codex", model: "o3", additionalArgs: ["--my-custom-flag"], version: 2 },
				],
				defaultConfigId: "codex-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const codex = result.find((a) => a.id === "builtin-codex")!;
		const cfg = codex.configurations.find((c) => c.id === "codex-default")!;
		const defCodex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const defCfg = defCodex.configurations.find((c) => c.id === "codex-default")!;

		// When stored version matches default version, user overrides win
		expect(cfg.name).toBe("My Codex");
		expect(cfg.model).toBe("o3");
		expect(cfg.additionalArgs).toEqual(["--my-custom-flag"]);
		// Version should be preserved
		expect(cfg.version).toBe(defCfg.version);
	});

	// ---- version-based preset update tests ----

	it("resets additionalArgs when stored has no version (legacy data)", () => {
		const defCodex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const defCfg = defCodex.configurations.find((c) => c.id === "codex-default")!;

		const stored: CodingAgent[] = [
			{
				id: "builtin-codex",
				name: "Codex",
				baseCommand: "codex",
				configurations: [
					// No version field — legacy stored data
					{ id: "codex-default", name: "Default", additionalArgs: ["--full-auto", "--no-alt-screen", "--sandbox", "danger-full-access"] },
				],
				defaultConfigId: "codex-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const codex = result.find((a) => a.id === "builtin-codex")!;
		const cfg = codex.configurations.find((c) => c.id === "codex-default")!;

		// additionalArgs should be reset to defaults because stored has no version
		expect(cfg.additionalArgs).toEqual(defCfg.additionalArgs);
		// version should be set to default
		expect(cfg.version).toBe(defCfg.version);
	});

	it("resets additionalArgs when stored version < default version", () => {
		const defCodex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const defCfg = defCodex.configurations.find((c) => c.id === "codex-default")!;

		const stored: CodingAgent[] = [
			{
				id: "builtin-codex",
				name: "Codex",
				baseCommand: "codex",
				configurations: [
					{ id: "codex-default", name: "My Codex", model: "o3", additionalArgs: ["--old-stale-flag"], version: 1 },
				],
				defaultConfigId: "codex-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const codex = result.find((a) => a.id === "builtin-codex")!;
		const cfg = codex.configurations.find((c) => c.id === "codex-default")!;

		// additionalArgs reset to default because stored version is older
		expect(cfg.additionalArgs).toEqual(defCfg.additionalArgs);
		// User-editable fields still preserved
		expect(cfg.name).toBe("My Codex");
		expect(cfg.model).toBe("o3");
		// version bumped to default
		expect(cfg.version).toBe(defCfg.version);
	});

	it("preserves user additionalArgs when stored version == default version", () => {
		const defCodex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const defCfg = defCodex.configurations.find((c) => c.id === "codex-default")!;

		const stored: CodingAgent[] = [
			{
				id: "builtin-codex",
				name: "Codex",
				baseCommand: "codex",
				configurations: [
					{ id: "codex-default", name: "Default", additionalArgs: ["--my-custom-flag"], version: defCfg.version },
				],
				defaultConfigId: "codex-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const codex = result.find((a) => a.id === "builtin-codex")!;
		const cfg = codex.configurations.find((c) => c.id === "codex-default")!;

		// Same version — user's customization wins
		expect(cfg.additionalArgs).toEqual(["--my-custom-flag"]);
	});

	it("preserves user additionalArgs when stored version > default version (future-proof)", () => {
		const stored: CodingAgent[] = [
			{
				id: "builtin-codex",
				name: "Codex",
				baseCommand: "codex",
				configurations: [
					{ id: "codex-default", name: "Default", additionalArgs: ["--future-flag"], version: 999 },
				],
				defaultConfigId: "codex-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const codex = result.find((a) => a.id === "builtin-codex")!;
		const cfg = codex.configurations.find((c) => c.id === "codex-default")!;

		// Stored version is higher — user's args are preserved
		expect(cfg.additionalArgs).toEqual(["--future-flag"]);
	});

	it("resets additionalArgs only for outdated configs, not all configs of same agent", () => {
		const defCodex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const defCfgDefault = defCodex.configurations.find((c) => c.id === "codex-default")!;

		const stored: CodingAgent[] = [
			{
				id: "builtin-codex",
				name: "Codex",
				baseCommand: "codex",
				configurations: [
					// This config is outdated — should be reset
					{ id: "codex-default", name: "Default", additionalArgs: ["--stale"], version: 1 },
					// User-created config — should not be touched
					{ id: "my-custom-codex", name: "My Setup", additionalArgs: ["--my-flag"] },
				],
				defaultConfigId: "codex-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const codex = result.find((a) => a.id === "builtin-codex")!;

		const defaultCfg = codex.configurations.find((c) => c.id === "codex-default")!;
		expect(defaultCfg.additionalArgs).toEqual(defCfgDefault.additionalArgs);

		const customCfg = codex.configurations.find((c) => c.id === "my-custom-codex")!;
		expect(customCfg.additionalArgs).toEqual(["--my-flag"]);
	});

	it("does not reset user-editable fields even when version is outdated", () => {
		const defCodex = DEFAULT_AGENTS.find((a) => a.id === "builtin-codex")!;
		const defCfg = defCodex.configurations.find((c) => c.id === "codex-default")!;

		const stored: CodingAgent[] = [
			{
				id: "builtin-codex",
				name: "Codex",
				baseCommand: "codex",
				configurations: [
					{
						id: "codex-default",
						name: "My Custom Name",
						model: "o3-mini",
						permissionMode: "plan" as any,
						effort: "low" as any,
						maxBudgetUsd: 42,
						appendPrompt: "Be careful",
						additionalArgs: ["--stale-flag"],
						envVars: { MY_VAR: "hello" },
						version: 1,
					},
				],
				defaultConfigId: "codex-default",
			},
		];
		const result = mergeWithDefaults(stored);
		const codex = result.find((a) => a.id === "builtin-codex")!;
		const cfg = codex.configurations.find((c) => c.id === "codex-default")!;

		// additionalArgs reset
		expect(cfg.additionalArgs).toEqual(defCfg.additionalArgs);
		// All user-editable fields preserved
		expect(cfg.name).toBe("My Custom Name");
		expect(cfg.model).toBe("o3-mini");
		expect(cfg.permissionMode).toBe("plan");
		expect(cfg.effort).toBe("low");
		expect(cfg.maxBudgetUsd).toBe(42);
		expect(cfg.appendPrompt).toBe("Be careful");
		expect(cfg.envVars).toEqual({ MY_VAR: "hello" });
	});

	it("version field is included in merged output for fresh defaults (no stored data)", () => {
		const result = mergeWithDefaults([]);
		for (const agent of result) {
			for (const cfg of agent.configurations) {
				// All default configs should have a version
				if (cfg.version !== undefined) {
					expect(typeof cfg.version).toBe("number");
					expect(cfg.version).toBeGreaterThan(0);
				}
			}
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

	it("preserves double quotes (no escaping needed inside single quotes)", () => {
		expect(shellEscape('say "hello"')).toBe("'say \"hello\"'");
	});

	it("preserves dollar signs (no expansion inside single quotes)", () => {
		expect(shellEscape("path is $HOME/dir")).toBe("'path is $HOME/dir'");
	});

	it("preserves backticks (no command substitution inside single quotes)", () => {
		expect(shellEscape("run `whoami` here")).toBe("'run `whoami` here'");
	});

	it("preserves backslashes (literal inside single quotes)", () => {
		expect(shellEscape("path\\to\\file")).toBe("'path\\to\\file'");
	});

	it("preserves semicolons (no command chaining)", () => {
		expect(shellEscape("first; rm -rf /")).toBe("'first; rm -rf /'");
	});

	it("preserves pipe characters", () => {
		expect(shellEscape("echo foo | cat")).toBe("'echo foo | cat'");
	});

	it("preserves ampersands", () => {
		expect(shellEscape("cmd1 && cmd2")).toBe("'cmd1 && cmd2'");
	});

	it("preserves parentheses (no subshell)", () => {
		expect(shellEscape("$(whoami)")).toBe("'$(whoami)'");
	});

	it("preserves newlines", () => {
		expect(shellEscape("line1\nline2")).toBe("'line1\nline2'");
	});

	it("preserves tabs", () => {
		expect(shellEscape("col1\tcol2")).toBe("'col1\tcol2'");
	});

	it("handles multiple single quotes", () => {
		expect(shellEscape("it's Bob's car")).toBe("'it'\\''s Bob'\\''s car'");
	});

	it("handles single quote at start", () => {
		expect(shellEscape("'hello")).toBe("''\\''hello'");
	});

	it("handles single quote at end", () => {
		expect(shellEscape("hello'")).toBe("'hello'\\'''");
	});

	it("handles only a single quote", () => {
		expect(shellEscape("'")).toBe("''\\'''");
	});

	it("preserves exclamation marks", () => {
		expect(shellEscape("hello! world!")).toBe("'hello! world!'");
	});

	it("preserves glob characters (* and ?)", () => {
		expect(shellEscape("file*.txt and file?.log")).toBe("'file*.txt and file?.log'");
	});

	it("preserves square brackets", () => {
		expect(shellEscape("[a-z] range")).toBe("'[a-z] range'");
	});

	it("preserves curly braces", () => {
		expect(shellEscape("{a,b,c}")).toBe("'{a,b,c}'");
	});

	it("preserves hash (comment character)", () => {
		expect(shellEscape("text # not a comment")).toBe("'text # not a comment'");
	});

	it("preserves tilde", () => {
		expect(shellEscape("~/Documents")).toBe("'~/Documents'");
	});

	it("handles unicode characters", () => {
		expect(shellEscape("Привет мир 🚀")).toBe("'Привет мир 🚀'");
	});

	it("handles complex real-world task title with mixed special chars", () => {
		const title = "Fix the \"login\" bug (it's broken); check $PATH & `env`";
		const escaped = shellEscape(title);
		expect(escaped).toBe(
			"'Fix the \"login\" bug (it'\\''s broken); check $PATH & `env`'",
		);
	});

	it("handles injection attempt via single-quote breakout", () => {
		const malicious = "'; rm -rf / #";
		const escaped = shellEscape(malicious);
		// Should produce: ''\''; rm -rf / #'
		// Shell parses as: '' (empty) + \' (literal ') + '; rm -rf / #' (quoted text)
		// Result: literal string "'; rm -rf / #"
		expect(escaped).toBe("''\\''; rm -rf / #'");
	});

	it("handles consecutive single quotes", () => {
		expect(shellEscape("a''b")).toBe("'a'\\'''\\''b'");
	});

	it("preserves redirect operators", () => {
		expect(shellEscape("cmd > /tmp/out 2>&1")).toBe("'cmd > /tmp/out 2>&1'");
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
		expect(cmd).toContain("claude");
		expect(cmd).toContain("'Fix the login bug'");
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

	it("injects --append-system-prompt for claude base command", () => {
		const cmd = resolveAgentCommand(agent, undefined, ctx);
		expect(cmd).toContain("--append-system-prompt");
		expect(cmd).toContain("dev-3.0");
	});

	it("does not inject --append-system-prompt for non-claude agents", () => {
		const nonClaude: CodingAgent = {
			id: "a2",
			name: "Codex",
			baseCommand: "codex",
			configurations: [],
		};
		const cmd = resolveAgentCommand(nonClaude, undefined, ctx);
		expect(cmd).not.toContain("--append-system-prompt");
	});

	it("does not inject --append-system-prompt when baseCommandOverride is non-claude", () => {
		const config: AgentConfiguration = {
			id: "c1",
			name: "Test",
			baseCommandOverride: "my-wrapper",
		};
		const cmd = resolveAgentCommand(agent, config, ctx);
		expect(cmd).not.toContain("--append-system-prompt");
	});

	// ---- special character escaping in task descriptions ----

	describe("special characters in task description", () => {
		// Non-claude agent to avoid --append-system-prompt noise in assertions
		const simpleAgent: CodingAgent = {
			id: "a2",
			name: "Bash",
			baseCommand: "bash-agent",
			configurations: [],
		};

		it("escapes single quotes in task description", () => {
			const c = makeCtx({ taskDescription: "Fix it's broken flow" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'Fix it'\\''s broken flow'");
		});

		it("preserves double quotes in task description (safe inside single quotes)", () => {
			const c = makeCtx({ taskDescription: 'Fix the "login" page' });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'Fix the \"login\" page'");
		});

		it("preserves dollar signs in task description", () => {
			const c = makeCtx({ taskDescription: "Check $HOME and $PATH vars" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'Check $HOME and $PATH vars'");
		});

		it("preserves backticks in task description", () => {
			const c = makeCtx({ taskDescription: "Run `whoami` and check" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'Run `whoami` and check'");
		});

		it("preserves command substitution syntax in task description", () => {
			const c = makeCtx({ taskDescription: "Value is $(cat /etc/passwd)" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'Value is $(cat /etc/passwd)'");
		});

		it("preserves semicolons and pipes in task description", () => {
			const c = makeCtx({ taskDescription: "step1; step2 | step3" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'step1; step2 | step3'");
		});

		it("preserves backslashes in task description", () => {
			const c = makeCtx({ taskDescription: "path\\to\\file" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'path\\to\\file'");
		});

		it("preserves newlines in task description", () => {
			const c = makeCtx({ taskDescription: "line1\nline2\nline3" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'line1\nline2\nline3'");
		});

		it("handles injection attempt via single-quote breakout", () => {
			const c = makeCtx({ taskDescription: "'; rm -rf / #" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent ''\\''; rm -rf / #'");
		});

		it("handles complex real-world task with mixed special chars", () => {
			const desc = "Fix the \"login\" bug (it's broken); check $PATH & `env` | grep HOME";
			const c = makeCtx({ taskDescription: desc });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe(
				"bash-agent 'Fix the \"login\" bug (it'\\''s broken); check $PATH & `env` | grep HOME'",
			);
		});

		it("handles unicode and emoji in task description", () => {
			const c = makeCtx({ taskDescription: "Исправь баг 🐛 в компоненте" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'Исправь баг 🐛 в компоненте'");
		});

		it("escapes task description with only single quotes", () => {
			const c = makeCtx({ taskDescription: "'''" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent ''\\'''\\'''\\'''");
		});

		it("preserves redirect operators in task description", () => {
			const c = makeCtx({ taskDescription: "output > /dev/null 2>&1" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'output > /dev/null 2>&1'");
		});

		it("preserves glob patterns in task description", () => {
			const c = makeCtx({ taskDescription: "Fix *.ts files in src/**/" });
			const cmd = resolveAgentCommand(simpleAgent, undefined, c);
			expect(cmd).toBe("bash-agent 'Fix *.ts files in src/**/'");
		});
	});

	// ---- special characters in appendPrompt with template interpolation ----

	describe("special characters via appendPrompt template", () => {
		const simpleAgent: CodingAgent = {
			id: "a2",
			name: "Bash",
			baseCommand: "bash-agent",
			configurations: [],
		};

		it("escapes task title with single quotes when interpolated via template", () => {
			const config: AgentConfiguration = {
				id: "c1",
				name: "Test",
				appendPrompt: "Title: {{TASK_TITLE}}",
			};
			const c = makeCtx({
				taskTitle: "Fix it's problem",
				taskDescription: "",
			});
			const cmd = resolveAgentCommand(simpleAgent, config, c);
			// The interpolated prompt "Title: Fix it's problem" gets shellEscape'd
			expect(cmd).toBe("bash-agent 'Title: Fix it'\\''s problem'");
		});

		it("escapes task title with dollar signs when interpolated via template", () => {
			const config: AgentConfiguration = {
				id: "c1",
				name: "Test",
				appendPrompt: "Work on: {{TASK_TITLE}}",
			};
			const c = makeCtx({
				taskTitle: "Check $HOME path",
				taskDescription: "",
			});
			const cmd = resolveAgentCommand(simpleAgent, config, c);
			expect(cmd).toBe("bash-agent 'Work on: Check $HOME path'");
		});

		it("escapes combined description + appendPrompt with special chars", () => {
			const config: AgentConfiguration = {
				id: "c1",
				name: "Test",
				appendPrompt: "Title: {{TASK_TITLE}}",
			};
			const c = makeCtx({
				taskTitle: "Fix 'auth' bug",
				taskDescription: "The $user can't login",
			});
			const cmd = resolveAgentCommand(simpleAgent, config, c);
			// Description + \n\n + interpolated appendPrompt, all shellEscape'd
			expect(cmd).toBe(
				"bash-agent 'The $user can'\\''t login\n\nTitle: Fix '\\''auth'\\'' bug'",
			);
		});
	});
});

// ---- isClaudeCommand ----

describe("isClaudeCommand", () => {
	it("returns true for 'claude'", () => {
		expect(isClaudeCommand("claude")).toBe(true);
	});

	it("returns true for full path ending in claude", () => {
		expect(isClaudeCommand("/usr/local/bin/claude")).toBe(true);
	});

	it("returns false for 'codex'", () => {
		expect(isClaudeCommand("codex")).toBe(false);
	});

	it("returns false for 'my-claude-wrapper'", () => {
		expect(isClaudeCommand("my-claude-wrapper")).toBe(false);
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

// ---- getDefaultEnvForAgent ----

describe("getDefaultEnvForAgent", () => {
	it("returns CLAUDE_DEFAULT_ENV for claude-based agents", () => {
		const agent: CodingAgent = {
			id: "test-claude",
			name: "Claude",
			baseCommand: "claude",
			configurations: [{ id: "c1", name: "Default" }],
			defaultConfigId: "c1",
		};
		const env = getDefaultEnvForAgent(agent);
		expect(env).toEqual(CLAUDE_DEFAULT_ENV);
		expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
	});

	it("returns CLAUDE_DEFAULT_ENV for full-path claude command", () => {
		const agent: CodingAgent = {
			id: "test-claude-path",
			name: "Claude",
			baseCommand: "/usr/local/bin/claude",
			configurations: [{ id: "c1", name: "Default" }],
			defaultConfigId: "c1",
		};
		expect(getDefaultEnvForAgent(agent)).toEqual(CLAUDE_DEFAULT_ENV);
	});

	it("returns empty env for non-claude agents", () => {
		const agent: CodingAgent = {
			id: "test-codex",
			name: "Codex",
			baseCommand: "codex",
			configurations: [{ id: "c1", name: "Default" }],
			defaultConfigId: "c1",
		};
		expect(getDefaultEnvForAgent(agent)).toEqual({});
	});

	it("uses config baseCommandOverride when present", () => {
		const agent: CodingAgent = {
			id: "test-custom",
			name: "Custom",
			baseCommand: "bash",
			configurations: [{ id: "c1", name: "Default" }],
			defaultConfigId: "c1",
		};
		const config: AgentConfiguration = {
			id: "c1",
			name: "Default",
			baseCommandOverride: "claude",
		};
		expect(getDefaultEnvForAgent(agent, config)).toEqual(CLAUDE_DEFAULT_ENV);
	});

	it("returns empty env when config overrides away from claude", () => {
		const agent: CodingAgent = {
			id: "test-claude",
			name: "Claude",
			baseCommand: "claude",
			configurations: [{ id: "c1", name: "Default" }],
			defaultConfigId: "c1",
		};
		const config: AgentConfiguration = {
			id: "c1",
			name: "Default",
			baseCommandOverride: "my-custom-agent",
		};
		expect(getDefaultEnvForAgent(agent, config)).toEqual({});
	});
});
