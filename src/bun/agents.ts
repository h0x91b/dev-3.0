import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import type { AgentConfiguration, CodingAgent, Project } from "../shared/types";
import { DEFAULT_AGENTS } from "../shared/types";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { loadSettings } from "./settings";

const log = createLogger("agents");

const AGENTS_FILE = `${DEV3_HOME}/agents.json`;

// ---- Storage ----

/** Merge stored agents with defaults. Missing defaults are added; stored versions win.
 *  For default agents, new predefined configurations are appended if not already present. */
export function mergeWithDefaults(stored: CodingAgent[]): CodingAgent[] {
	const byId = new Map(stored.map((a) => [a.id, a]));
	const result: CodingAgent[] = [];

	// Ensure all defaults are present
	for (const def of DEFAULT_AGENTS) {
		const existing = byId.get(def.id);
		if (existing) {
			// Stored version wins, but merge in any new default configurations
			const existingConfigIds = new Set(existing.configurations.map((c) => c.id));
			const newConfigs = def.configurations.filter((c) => !existingConfigIds.has(c.id));
			const merged = {
				...existing,
				isDefault: true,
				configurations: [...existing.configurations, ...newConfigs],
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
	"TASK STATUS MANAGEMENT IS NON-NEGOTIABLE: " +
	"(1) Run `dev3 task move --status in-progress` when you START working. " +
	"(2) Run `dev3 task move --status user-questions` if you are BLOCKED and need human input. " +
	"(3) Run `dev3 task move --status review-by-user` when you have COMPLETED all work. " +
	"You MUST leave the task in one of these statuses before the session ends. " +
	"NEVER finish a session without updating the task status.";

/** Returns true when the resolved base command is the Claude CLI. */
export function isClaudeCommand(baseCmd: string): boolean {
	const name = baseCmd.split("/").pop() ?? "";
	return name === "claude";
}

export function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function resolveAgentCommand(
	agent: CodingAgent,
	config: AgentConfiguration | undefined,
	ctx: TemplateContext,
): string {
	const baseCmd = config?.baseCommandOverride || agent.baseCommand;
	const args: string[] = [];

	if (config?.model) {
		args.push("--model", config.model);
	}

	if (config?.permissionMode && config.permissionMode !== "default") {
		args.push("--permission-mode", config.permissionMode);
	}

	if (config?.effort) {
		args.push("--effort", config.effort);
	}

	if (config?.maxBudgetUsd != null && config.maxBudgetUsd > 0) {
		args.push("--max-budget-usd", String(config.maxBudgetUsd));
	}

	// Inject --append-system-prompt for Claude-based agents
	if (isClaudeCommand(baseCmd)) {
		args.push("--append-system-prompt", shellEscape(DEV3_SYSTEM_PROMPT));
	}

	if (config?.additionalArgs) {
		args.push(...config.additionalArgs);
	}

	// Build prompt: task description + interpolated append prompt
	let prompt = ctx.taskDescription;
	if (config?.appendPrompt) {
		const interpolated = interpolateTemplate(config.appendPrompt, ctx);
		if (interpolated.trim()) {
			prompt = prompt ? `${prompt}\n\n${interpolated}` : interpolated;
		}
	}

	const parts = [baseCmd, ...args];
	if (prompt) {
		parts.push(shellEscape(prompt));
	}

	return parts.join(" ");
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

export async function resolveCommandForAgent(
	agentId: string,
	configId: string | null,
	ctx: TemplateContext,
): Promise<{ command: string; agent: CodingAgent; config: AgentConfiguration | undefined; extraEnv: Record<string, string> }> {
	const allAgents = await getAllAgents();
	const agent = allAgents.find((a) => a.id === agentId);
	if (!agent) {
		throw new Error(`Agent not found: ${agentId}`);
	}
	const config = findConfig(agent, configId);
	const command = resolveAgentCommand(agent, config, ctx);
	const extraEnv: Record<string, string> = {};
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
): Promise<{ command: string; agent: CodingAgent | null; config: AgentConfiguration | undefined; extraEnv: Record<string, string> }> {
	const ctx: TemplateContext = {
		taskTitle,
		taskDescription,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};

	const settings = await loadSettings();
	const agents = await getAllAgents();
	const agent = agents.find((a) => a.id === settings.defaultAgentId);

	if (agent) {
		const resolvedConfigId = configId ?? settings.defaultConfigId;
		const config = findConfig(agent, resolvedConfigId);
		const command = resolveAgentCommand(agent, config, ctx);
		const extraEnv = buildTaskEnv(project, taskTitle, "", worktreePath, config);
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
