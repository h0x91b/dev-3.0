import { findAgentConfig } from "../../shared/agent-live-models";
import type { CodingAgent, Task } from "../../shared/types";
import { resolveAgentLauncherIcon } from "../components/AgentLauncherBadge";
import { taskRunningAgentIds } from "./taskAgentMeta";

/** Who runs a task, as a card's identity row names it: the agent, and its config · model string. */
export function taskCardAgent(task: Pick<Task, "agentId" | "configId" | "worktreePath" | "sessionState">, agents: CodingAgent[]) {
	const { agentId, configId } = taskRunningAgentIds(task);
	const agent = agentId ? agents.find((a) => a.id === agentId) ?? null : null;
	const agentConfig = agent && configId
		? findAgentConfig(agent, configId)
		: agent?.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent?.configurations[0];
	const configLabel = agentConfig
		? (agentConfig.model ? `${agentConfig.name} · ${agentConfig.model}` : agentConfig.name)
		: agent?.name ?? "";
	const hasLauncherIcon = agent ? resolveAgentLauncherIcon(agent) !== null : false;
	return { agent, agentConfig: agentConfig ?? null, configLabel, hasLauncherIcon };
}
