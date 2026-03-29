import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import type { AgentConfiguration, CodingAgent, Project } from "../shared/types";
import { DEFAULT_AGENTS } from "../shared/types";
import { createLogger } from "./logger";
import { ensureCodexConfig } from "./codex-config";
import { DEV3_HOME } from "./paths";
import { loadSettings } from "./settings";

const log = createLogger("agents");

const AGENTS_FILE = `${DEV3_HOME}/agents.json`;

// ---- Storage ----

/** Old default config IDs that were removed or renamed. These are filtered out
 *  during merge so they don't linger as phantom "user" configs. */
const DEPRECATED_CONFIG_IDS = new Set([
	"claude-plan-then-bypass-opus",
	"claude-plan-then-bypass-sonnet",
	"claude-approvals-opus",
	"claude-bypass-opus",
]);

/** Merge stored agents with defaults. Missing defaults are added; stored versions win.
 *  For default agents, new predefined configurations are appended if not already present. */
export function mergeWithDefaults(stored: CodingAgent[]): CodingAgent[] {
	const byId = new Map(stored.map((a) => [a.id, a]));
	const result: CodingAgent[] = [];

	// Ensure all defaults are present
	for (const def of DEFAULT_AGENTS) {
		const existing = byId.get(def.id);
		if (existing) {
			// Build a map of default configs for field-level merging
			const defConfigById = new Map(def.configurations.map((c) => [c.id, c]));

			// Build a map of stored configs that survived deprecation and match a default
			const storedConfigById = new Map<string, AgentConfiguration>();
			for (const storedCfg of existing.configurations) {
				if (DEPRECATED_CONFIG_IDS.has(storedCfg.id)) continue; // drop deprecated
				storedConfigById.set(storedCfg.id, storedCfg);
			}

			// Merge existing configs: use default as base, user overrides on top.
			// When the default config has a higher version than stored, reset
			// additionalArgs, model, and name to the new defaults (preset was updated).
			function mergeConfig(storedCfg: AgentConfiguration): AgentConfiguration {
				const defCfg = defConfigById.get(storedCfg.id);
				if (!defCfg) return storedCfg; // user-created config, keep as-is

				const storedVersion = storedCfg.version ?? 0;
				const defVersion = defCfg.version ?? 0;
				const presetUpdated = defVersion > storedVersion;

				const userOverrides = stripUndefined(storedCfg);
				if (presetUpdated) {
					// Preset was bumped — reset to new defaults
					delete userOverrides.additionalArgs;
					delete userOverrides.model;
					delete userOverrides.name;
					delete userOverrides.version;
				}

				return { ...defCfg, ...userOverrides };
			}

			// Rebuild configurations in the default-defined order:
			// 1. Default configs first (in their defined order), merged with stored overrides
			// 2. User-created configs appended at the end
			const defConfigIds = new Set(def.configurations.map((c) => c.id));
			const ordered: AgentConfiguration[] = [];

			for (const defCfg of def.configurations) {
				const storedCfg = storedConfigById.get(defCfg.id);
				ordered.push(storedCfg ? mergeConfig(storedCfg) : defCfg);
			}

			// Append user-created configs (not in defaults, not deprecated)
			for (const storedCfg of existing.configurations) {
				if (!defConfigIds.has(storedCfg.id) && !DEPRECATED_CONFIG_IDS.has(storedCfg.id)) {
					ordered.push(storedCfg);
				}
			}

			const merged = {
				...existing,
				isDefault: true,
				configurations: ordered,
			};
			result.push(merged);
			byId.delete(def.id);
		} else {
			result.push({ ...def });
		}
	}

	// Add remaining user-created agents
	for (const [, agent] of byId) {
		result.push(agent);
	}

	return result;
}

/** Remove keys with undefined values so they don't shadow defaults in spread. */
function stripUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
	const result: any = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

/** Detect and migrate old flat format (kind-based agents) to new model. */
export function migrateOldFormat(data: any[]): CodingAgent[] {
	if (!Array.isArray(data) || data.length === 0) return [];

	// Check if this is the old format (has `kind` field)
	if (data[0] && "kind" in data[0]) {
		log.info("Migrating old agent format to new model");
		return data
			.filter((a: any) => a.kind === "custom")
			.map((a: any) => ({
				id: a.id,
				name: a.name,
				baseCommand: a.command || "bash",
				configurations: [{ id: `${a.id}-default`, name: "Default" }],
				defaultConfigId: `${a.id}-default`,
			}));
	}

	return data as CodingAgent[];
}

async function loadStoredAgents(): Promise<CodingAgent[]> {
	try {
		const file = Bun.file(AGENTS_FILE);
		if (!(await file.exists())) return [];
		const data = await file.json();
		return migrateOldFormat(data);
	} catch (err) {
		log.error("Failed to load agents", { error: String(err) });
		return [];
	}
}

async function saveAgents(agents: CodingAgent[]): Promise<void> {
	await Bun.write(AGENTS_FILE, JSON.stringify(agents, null, 2));
	log.info(`Saved ${agents.length} agent(s)`);
}

export async function getAllAgents(): Promise<CodingAgent[]> {
	const stored = await loadStoredAgents();
	return mergeWithDefaults(stored);
}

export async function saveAllAgents(agents: CodingAgent[]): Promise<void> {
	await saveAgents(agents);
}

// ---- Template Interpolation ----

export interface TemplateContext {
	taskTitle: string;
	taskDescription: string;
	projectName: string;
	projectPath: string;
	worktreePath: string;
}

export function interpolateTemplate(template: string, ctx: TemplateContext): string {
	const vars: Record<string, string> = {
		TASK_TITLE: ctx.taskTitle,
		TASK_DESCRIPTION: ctx.taskDescription,
		PROJECT_NAME: ctx.projectName,
		PROJECT_PATH: ctx.projectPath,
		WORKTREE_PATH: ctx.worktreePath,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

// ---- Command Resolution ----

/**
 * System-prompt reminder injected via --append-system-prompt for all
 * Claude-based agents.  Belt-and-suspenders: the full skill lives in
 * ~/.claude/skills/dev3/SKILL.md, but the skill trigger is not 100 %
 * reliable, so we reinforce critical rules at the CLI level.
 */
export const DEV3_SYSTEM_PROMPT =
	"MANDATORY: You are inside a dev-3.0 managed worktree. " +
	"Invoke the /dev3 skill BEFORE doing any other work. Do NOT skip this step. " +
	"Task status transitions (in-progress, user-questions, review) are managed " +
	"automatically by hooks — do NOT call `dev3 task move` for status changes " +
	"unless you need to move to a custom column.";

/**
 * Generic system-prompt for agents without automatic hooks (OpenCode,
 * Cursor Agent, etc.).  Direct instructions — what to do, not what exists.
 */
export const DEV3_SYSTEM_PROMPT_GENERIC =
	"MANDATORY: You are inside a dev-3.0 managed worktree. " +
	"Invoke the /dev3 skill BEFORE doing any other work. Do NOT skip this step. " +
	"You MUST manage task status yourself: run `dev3 task move --status in-progress` " +
	"when you start working, `dev3 task move --status user-questions` when you need " +
	"user input, and `dev3 task move --status review-by-user` when you finish.";

/**
 * Codex uses automatic hooks for active/review transitions, but still needs
 * explicit fallback instructions because skill loading is not guaranteed and
 * Codex has no PermissionRequest hook for user-questions.
 */
export const DEV3_SYSTEM_PROMPT_CODEX =
	"MANDATORY: You are inside a dev-3.0 managed worktree. " +
	"Invoke the /dev3 skill BEFORE doing any other work. Do NOT skip this step. " +
	"Fresh Codex sessions use hooks for `in-progress` and review transitions. " +
	"If you need user input, move the task to `user-questions` before your final response. " +
	"If hooks appear inactive in this session, manage statuses manually with `dev3 task move`. " +
	"For exec_command calls, always set `shell=\"/bin/bash\"` and `login=false`.";

/** Returns true when the resolved base command is the Claude CLI. */
export function isClaudeCommand(baseCmd: string): boolean {
	const name = baseCmd.split("/").pop() ?? "";
	return name === "claude";
}

/** Returns true when the resolved base command is the Cursor Agent CLI. */
export function isCursorCommand(baseCmd: string): boolean {
	const name = baseCmd.split("/").pop() ?? "";
	return name === "agent";
}

/** Returns true when the resolved base command is the Codex CLI. */
export function isCodexCommand(baseCmd: string): boolean {
	const name = baseCmd.split("/").pop() ?? "";
	return name === "codex";
}

/** Returns true when the resolved base command is the Gemini CLI. */
export function isGeminiCommand(baseCmd: string): boolean {
	const name = baseCmd.split("/").pop() ?? "";
	return name === "gemini";
}

/** Returns true when the resolved base command is the OpenCode CLI. */
export function isOpenCodeCommand(baseCmd: string): boolean {
	const name = baseCmd.split("/").pop() ?? "";
	return name === "opencode";
}

export function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface CommandOptions {
	/** When true, resume the previous session instead of starting a new one.
	 *  Supported agents: Claude (--continue), Codex (resume --last),
	 *  Gemini (--resume latest), Cursor Agent (--continue). */
	resume?: boolean;
	/** When true, skip injecting the DEV3_SYSTEM_PROMPT via --append-system-prompt.
	 *  Used for review agents that rely on hooks instead of system-prompt instructions. */
	skipSystemPrompt?: boolean;
}

/** Returns true when the agent CLI supports session resumption. */
export function supportsResume(baseCmd: string): boolean {
	return isClaudeCommand(baseCmd) || isCodexCommand(baseCmd) || isGeminiCommand(baseCmd) || isCursorCommand(baseCmd) || isOpenCodeCommand(baseCmd);
}

export function resolveAgentCommand(
	agent: CodingAgent,
	config: AgentConfiguration | undefined,
	ctx: TemplateContext,
	options?: CommandOptions,
): string {
	const baseCmd = config?.baseCommandOverride || agent.baseCommand;
	const args: string[] = [];
	const shouldResume = options?.resume && supportsResume(baseCmd);
	const codexAgent = isCodexCommand(baseCmd);

	// Resume flags per agent (Codex uses a subcommand, handled at the end)
	if (shouldResume) {
		if (isClaudeCommand(baseCmd) || isCursorCommand(baseCmd) || isOpenCodeCommand(baseCmd)) {
			args.push("--continue");
		} else if (isGeminiCommand(baseCmd)) {
			args.push("--resume", "latest");
		}
		// Codex: handled below when building the final command
	}

	if (config?.model) {
		args.push("--model", config.model);
	}

	const cursorAgent = isCursorCommand(baseCmd);
	const geminiAgent = isGeminiCommand(baseCmd);
	const openCodeAgent = isOpenCodeCommand(baseCmd);

	if (config?.permissionMode && config.permissionMode !== "default" && !codexAgent && !openCodeAgent) {
		if (cursorAgent) {
			// Cursor Agent uses different flags for modes
			if (config.permissionMode === "plan") {
				args.push("--mode", "plan");
			} else if (config.permissionMode === "bypassPermissions") {
				args.push("--force");
			}
			// "acceptEdits" and "dontAsk" have no cursor equivalent — skip
		} else if (geminiAgent) {
			// Gemini CLI uses --approval-mode with its own value set
			const geminiModeMap: Record<string, string> = {
				acceptEdits: "auto_edit",
				bypassPermissions: "yolo",
				dontAsk: "yolo",
				plan: "plan",
			};
			args.push("--approval-mode", geminiModeMap[config.permissionMode] ?? config.permissionMode);
		} else {
			args.push("--permission-mode", config.permissionMode);
		}
	}

	if (config?.effort && !cursorAgent && !codexAgent && !geminiAgent && !openCodeAgent) {
		args.push("--effort", config.effort);
	}

	if (config?.maxBudgetUsd != null && config.maxBudgetUsd > 0 && !cursorAgent && !codexAgent && !geminiAgent && !openCodeAgent) {
		args.push("--max-budget-usd", String(config.maxBudgetUsd));
	}

	// Inject --append-system-prompt for Claude-based agents (unless skipped)
	if (isClaudeCommand(baseCmd) && !options?.skipSystemPrompt) {
		args.push("--append-system-prompt", shellEscape(DEV3_SYSTEM_PROMPT));
	}

	if (config?.additionalArgs) {
		args.push(...config.additionalArgs);
	}

	// When resuming, skip the prompt — we don't want to inject a new
	// message into the continued conversation.
	if (!shouldResume) {
		// Build prompt: task description + interpolated append prompt
		let prompt = ctx.taskDescription;
		if (config?.appendPrompt) {
			const interpolated = interpolateTemplate(config.appendPrompt, ctx);
			if (interpolated.trim()) {
				prompt = prompt ? `${prompt}\n\n${interpolated}` : interpolated;
			}
		}

		// Cursor Agent / OpenCode have no --append-system-prompt and no automatic
		// hooks, so inject the generic system prompt via the prompt argument.
		// Codex also gets a prompt reminder because skill loading is not guaranteed.
		if (codexAgent) {
			prompt = prompt ? `${prompt}\n\n${DEV3_SYSTEM_PROMPT_CODEX}` : DEV3_SYSTEM_PROMPT_CODEX;
		} else if (cursorAgent || openCodeAgent) {
			prompt = prompt ? `${prompt}\n\n${DEV3_SYSTEM_PROMPT_GENERIC}` : DEV3_SYSTEM_PROMPT_GENERIC;
		}

		if (prompt) {
			// OpenCode uses --prompt flag instead of positional argument
			if (openCodeAgent) {
				args.push("--prompt", shellEscape(prompt));
			} else {
				args.push(shellEscape(prompt));
			}
		}
	}

	// Codex uses a subcommand for resume: `codex resume --last [args]`
	if (shouldResume && isCodexCommand(baseCmd)) {
		return [baseCmd, "resume", "--last", ...args].join(" ");
	}

	return [baseCmd, ...args].join(" ");
}

export function findConfig(
	agent: CodingAgent,
	configId: string | null | undefined,
): AgentConfiguration | undefined {
	if (!configId) {
		// Fall back to agent's defaultConfigId, then first config
		return (
			agent.configurations.find((c) => c.id === agent.defaultConfigId) ||
			agent.configurations[0]
		);
	}
	return (
		agent.configurations.find((c) => c.id === configId) ||
		agent.configurations[0]
	);
}

/** Default env vars injected for Claude-based agents. */
export const CLAUDE_DEFAULT_ENV: Record<string, string> = {
	CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
};

/** Build default env vars for an agent based on its base command. */
export function getDefaultEnvForAgent(agent: CodingAgent, config?: AgentConfiguration): Record<string, string> {
	const baseCmd = config?.baseCommandOverride || agent.baseCommand;
	if (isClaudeCommand(baseCmd)) {
		return { ...CLAUDE_DEFAULT_ENV };
	}
	return {};
}

/** Apply saved binary path override if the cached file still exists on disk. */
function applyBinaryPathOverride(agent: CodingAgent, savedPaths: Record<string, string> | undefined): CodingAgent {
	const savedPath = savedPaths?.[agent.id];
	return savedPath && existsSync(savedPath)
		? { ...agent, baseCommand: savedPath }
		: agent;
}

export async function resolveCommandForAgent(
	agentId: string,
	configId: string | null,
	ctx: TemplateContext,
	options?: CommandOptions,
): Promise<{ command: string; agent: CodingAgent; config: AgentConfiguration | undefined; extraEnv: Record<string, string> }> {
	const allAgents = await getAllAgents();
	const agent = allAgents.find((a) => a.id === agentId);
	if (!agent) {
		throw new Error(`Agent not found: ${agentId}`);
	}
	const config = findConfig(agent, configId);

	const settings = await loadSettings();
	const agentWithPath = applyBinaryPathOverride(agent, settings.agentBinaryPaths);

	const command = resolveAgentCommand(agentWithPath, config, ctx, options);
	// Agent-type defaults first, then config envVars override
	const extraEnv: Record<string, string> = { ...getDefaultEnvForAgent(agent, config) };
	if (config?.envVars) {
		Object.assign(extraEnv, config.envVars);
	}
	return { command, agent, config, extraEnv };
}

export async function resolveCommandForProject(
	project: Project,
	taskTitle: string,
	taskDescription: string,
	worktreePath: string,
	configId?: string | null,
	options?: CommandOptions,
): Promise<{ command: string; agent: CodingAgent | null; config: AgentConfiguration | undefined; extraEnv: Record<string, string> }> {
	const ctx: TemplateContext = {
		taskTitle,
		taskDescription,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};

	const settings = await loadSettings();
	const allAgents = await getAllAgents();
	const agent = allAgents.find((a) => a.id === settings.defaultAgentId);

	if (agent) {
		const agentWithPath = applyBinaryPathOverride(agent, settings.agentBinaryPaths);
		const resolvedConfigId = configId ?? settings.defaultConfigId;
		const config = findConfig(agent, resolvedConfigId);
		const command = resolveAgentCommand(agentWithPath, config, ctx, options);
		// Agent-type defaults first, then buildTaskEnv (which includes config envVars) overrides
		const agentDefaults = getDefaultEnvForAgent(agent, config);
		const extraEnv = { ...agentDefaults, ...buildTaskEnv(project, taskTitle, "", worktreePath, config) };
		return { command, agent, config, extraEnv };
	}

	log.warn("Default agent not found, falling back to bash", {
		agentId: settings.defaultAgentId,
	});

	return {
		command: "bash",
		agent: null,
		config: undefined,
		extraEnv: buildTaskEnv(project, taskTitle, "", worktreePath),
	};
}

export function buildTaskEnv(
	project: Project,
	taskTitle: string,
	taskId: string,
	worktreePath: string,
	config?: AgentConfiguration,
): Record<string, string> {
	const env: Record<string, string> = {
		DEV3_TASK_TITLE: taskTitle,
		DEV3_TASK_ID: taskId,
		DEV3_PROJECT_NAME: project.name,
		DEV3_PROJECT_PATH: project.path,
		DEV3_WORKTREE_PATH: worktreePath,
	};

	// Merge config-level env vars
	if (config?.envVars) {
		Object.assign(env, config.envVars);
	}

	return env;
}

// ---- Gemini Trust ----

const CODEX_CONFIG = `${homedir()}/.codex/config.toml`;

const GEMINI_TRUSTED_FOLDERS = `${homedir()}/.gemini/trustedFolders.json`;

/**
 * Ensure a directory is marked as trusted in ~/.gemini/trustedFolders.json so
 * that `gemini` CLI skips the "Do you trust the files in this folder?" dialog.
 * Resolves symlinks (e.g. /tmp → /private/tmp on macOS).
 */
export async function ensureGeminiTrust(dirPath: string): Promise<void> {
	try {
		const resolved = await realpath(dirPath);
		const file = Bun.file(GEMINI_TRUSTED_FOLDERS);
		let data: Record<string, string> = {};
		if (await file.exists()) {
			data = await file.json();
		}

		if (data[resolved] === "TRUST_FOLDER") {
			return; // already trusted
		}

		data[resolved] = "TRUST_FOLDER";

		await Bun.write(GEMINI_TRUSTED_FOLDERS, JSON.stringify(data, null, 2));
		log.info("Registered worktree as trusted in ~/.gemini/trustedFolders.json", { path: resolved });
	} catch (err) {
		// Non-fatal — worst case the user sees the trust dialog
		log.warn("Failed to register Gemini worktree trust", { error: String(err) });
	}
}

// ---- Codex Trust ----

/**
 * Ensure a directory is marked as trusted in ~/.codex/config.toml so that
 * `codex` CLI skips the "Do you trust the contents of this directory?" dialog.
 * Resolves symlinks (e.g. /tmp → /private/tmp on macOS).
 */
export async function ensureCodexTrust(dirPath: string): Promise<void> {
	try {
		const resolved = await realpath(dirPath);
		const home = homedir();
		const worktreesPath = `${home}/.dev3.0/worktrees`;
		const socketsPath = `${home}/.dev3.0/sockets`;

		let content: string | null = null;
		try {
			content = readFileSync(CODEX_CONFIG, "utf-8");
		} catch {
			// File doesn't exist yet — create with defaults below.
		}

		const updated = ensureCodexConfig(content, worktreesPath, socketsPath, [worktreesPath, resolved]);
		if (updated === content) {
			return;
		}

		writeFileSync(CODEX_CONFIG, updated, "utf-8");
		log.info("Registered worktree as trusted in ~/.codex/config.toml", { path: resolved });
	} catch (err) {
		// Non-fatal — worst case the user sees the trust dialog
		log.warn("Failed to register Codex worktree trust", { error: String(err) });
	}
}

// ---- Claude Trust ----

const CLAUDE_JSON = `${homedir()}/.claude.json`;

const TRUST_ENTRY = {
	allowedTools: [],
	hasTrustDialogAccepted: true,
	projectOnboardingSeenCount: 1,
	hasCompletedProjectOnboarding: true,
	hasClaudeMdExternalIncludesApproved: false,
	mcpServers: {},
	enabledMcpjsonServers: [],
	disabledMcpjsonServers: [],
	mcpContextUris: [],
	ignorePatterns: [],
};

/**
 * Ensure a directory is marked as trusted in ~/.claude.json so that
 * `claude` CLI skips the "Do you trust this folder?" dialog.
 * Resolves symlinks (e.g. /tmp → /private/tmp on macOS).
 */
export async function ensureClaudeTrust(dirPath: string): Promise<void> {
	try {
		// Resolve symlinks so the path matches what claude sees
		const resolved = await realpath(dirPath);

		const file = Bun.file(CLAUDE_JSON);
		let data: any = {};
		if (await file.exists()) {
			data = await file.json();
		}

		if (!data.projects) {
			data.projects = {};
		}

		if (data.projects[resolved]?.hasTrustDialogAccepted) {
			return; // already trusted
		}

		data.projects[resolved] = {
			...TRUST_ENTRY,
			...(data.projects[resolved] || {}),
			hasTrustDialogAccepted: true,
		};

		await Bun.write(CLAUDE_JSON, JSON.stringify(data, null, 2));
		log.info("Registered worktree as trusted in ~/.claude.json", { path: resolved });
	} catch (err) {
		// Non-fatal — worst case the user sees the trust dialog
		log.warn("Failed to register worktree trust", { error: String(err) });
	}
}
