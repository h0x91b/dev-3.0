import type { CodingAgent, Project } from "../shared/types";
import { BUILTIN_AGENTS } from "../shared/types";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const log = createLogger("agents");

const AGENTS_FILE = `${DEV3_HOME}/agents.json`;

// ---- Storage ----

async function loadCustomAgents(): Promise<CodingAgent[]> {
	try {
		const file = Bun.file(AGENTS_FILE);
		if (!(await file.exists())) return [];
		return await file.json();
	} catch (err) {
		log.error("Failed to load custom agents", { error: String(err) });
		return [];
	}
}

async function saveCustomAgents(agents: CodingAgent[]): Promise<void> {
	await Bun.write(AGENTS_FILE, JSON.stringify(agents, null, 2));
	log.info(`Saved ${agents.length} custom agent(s)`);
}

export async function getAllAgents(): Promise<CodingAgent[]> {
	const custom = await loadCustomAgents();
	return [...BUILTIN_AGENTS, ...custom];
}

export async function saveAllAgents(agents: CodingAgent[]): Promise<void> {
	// Only persist custom agents — built-ins are constants
	const custom = agents.filter((a) => a.kind === "custom");
	await saveCustomAgents(custom);
}

// ---- Command Resolution ----

function shellEscape(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

function resolveBuiltinCommand(kind: string, taskTitle: string): string {
	const escaped = shellEscape(taskTitle);
	switch (kind) {
		case "claude":
			return taskTitle ? `claude ${escaped}` : "claude";
		case "codex":
			return taskTitle ? `codex ${escaped}` : "codex";
		case "gemini":
			return taskTitle ? `gemini ${escaped}` : "gemini";
		default:
			return "bash";
	}
}

export function resolveAgentCommand(
	agent: CodingAgent,
	taskTitle: string,
): string {
	if (agent.kind === "custom") {
		return agent.command || "bash";
	}
	return resolveBuiltinCommand(agent.kind, taskTitle);
}

export async function resolveCommandForProject(
	project: Project,
	taskTitle: string,
): Promise<{ command: string; agent: CodingAgent | null }> {
	if (project.defaultAgentId) {
		const agents = await getAllAgents();
		const agent = agents.find((a) => a.id === project.defaultAgentId);
		if (agent) {
			return {
				command: resolveAgentCommand(agent, taskTitle),
				agent,
			};
		}
		log.warn("Agent not found, falling back to defaultTmuxCommand", {
			agentId: project.defaultAgentId,
		});
	}

	// Backward compat: use raw defaultTmuxCommand
	return {
		command: project.defaultTmuxCommand || "bash",
		agent: null,
	};
}

export function buildTaskEnv(
	project: Project,
	taskTitle: string,
	taskId: string,
	worktreePath: string,
): Record<string, string> {
	return {
		DEV3_TASK_TITLE: taskTitle,
		DEV3_TASK_ID: taskId,
		DEV3_PROJECT_NAME: project.name,
		DEV3_PROJECT_PATH: project.path,
		DEV3_WORKTREE_PATH: worktreePath,
	};
}
