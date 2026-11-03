import type { CodingAgent, GlobalSettings, LaunchVariant } from "./types";

export const DEFAULT_COORDINATOR_AGENT_ID = "builtin-claude";
export const DEFAULT_COORDINATOR_CONFIG_ID = "claude-auto-fable51-medium";

/**
 * The agent/preset a coordinator launches on unless someone picks another.
 * Null when the configured agent is gone, so callers fall back to the global default.
 */
export function coordinatorLaunchDefault(
	agents: readonly CodingAgent[],
	settings: Pick<GlobalSettings, "coordinatorAgentId" | "coordinatorConfigId">,
): LaunchVariant | null {
	const agentId = settings.coordinatorAgentId || DEFAULT_COORDINATOR_AGENT_ID;
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) return null;
	const wanted = settings.coordinatorConfigId || DEFAULT_COORDINATOR_CONFIG_ID;
	const configId = agent.configurations.some((c) => c.id === wanted)
		? wanted
		: agent.defaultConfigId ?? agent.configurations[0]?.id ?? null;
	return { agentId, configId };
}
