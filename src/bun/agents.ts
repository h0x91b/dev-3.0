import type { AgentConfiguration, CodingAgent, Project } from "../shared/types";
import { DEFAULT_AGENTS } from "../shared/types";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("agents");

const AGENTS_FILE = `${DEV3_HOME}/agents.json`;

// ---- Storage ----

/** Merge stored agents with defaults. Missing defaults are added; stored versions win.
 *  For default agents, new predefined configurations are appended if not already present. */
function mergeWithDefaults(stored: CodingAgent[]): CodingAgent[] {
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
function migrateOldFormat(data: any[]): CodingAgent[] {
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

function interpolateTemplate(template: string, ctx: TemplateContext): string {
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

function shellEscape(s: string): string {
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

function findConfig(
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

	if (project.defaultAgentId) {
		const agents = await getAllAgents();
		const agent = agents.find((a) => a.id === project.defaultAgentId);
		if (agent) {
			const resolvedConfigId = configId ?? project.defaultConfigId;
			const config = findConfig(agent, resolvedConfigId);
			const command = resolveAgentCommand(agent, config, ctx);
			const extraEnv = buildTaskEnv(project, taskTitle, "", worktreePath, config);
			return { command, agent, config, extraEnv };
		}
		log.warn("Agent not found, falling back to defaultTmuxCommand", {
			agentId: project.defaultAgentId,
		});
	}

	// Backward compat: use raw defaultTmuxCommand
	return {
		command: project.defaultTmuxCommand || "bash",
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
