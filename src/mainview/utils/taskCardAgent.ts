import { findAgentConfig } from "../../shared/agent-live-models";
import type { CodingAgent, Task } from "../../shared/types";
import { resolveAgentLauncherIcon } from "../components/AgentLauncherBadge";

/** Who runs a task, as a card's identity row names it: the agent, and its config · model string. */
export function taskCardAgent(task: Pick<Task, "agentId" | "configId" | "worktreePath" | "sessionState">, agents: CodingAgent[]) {
	// No pick follows the global default; a running task shows the one its main pane got.
	const runningPane = !task.agentId && task.worktreePath ? task.sessionState?.panes?.[0] : undefined;
	const agentId = task.agentId ?? runningPane?.agentId;
	const configId = task.agentId ? task.configId : runningPane?.configId;
	const agent = agentId ? agents.find((a) => a.id === agentId) ?? null : null;
	const agentConfig = agent && configId
		? findAgentConfig(agent, configId)
		: agent?.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent?.configurations[0];
	const configLabel = agentConfig
		? (agentConfig.model ? `${agentConfig.name} · ${agentConfig.model}` : agentConfig.name)
		: agent?.name ?? "";
	const hasLauncherIcon = agent ? resolveAgentLauncherIcon(agent) !== null : false;
	return { agent, configLabel, hasLauncherIcon };
}
