import type { CodingAgent } from "../shared/types";
import { staleCustomPath, type CustomPathSettings } from "./executable";
import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const log = createLogger("stale-agent-path");

/** agentId → the stale path already announced in this process, so one warning per path, not per launch. */
const announced = new Map<string, string>();

export function resetStaleAgentPathNoticesForTests(): void {
	announced.clear();
}

/** Warn once that a launch fell back to PATH because a pre-strict custom path is gone. */
export function notifyStaleCustomPath(agent: Pick<CodingAgent, "id" | "name" | "baseCommand">, settings: CustomPathSettings): void {
	const path = staleCustomPath(agent.id, settings);
	if (!path || announced.get(agent.id) === path) return;
	announced.set(agent.id, path);
	log.warn("Saved custom executable is gone — launching the command from PATH", { agentId: agent.id, path });
	getPushMessage()?.("staleAgentPath", { agentId: agent.id, agentName: agent.name, path, command: agent.baseCommand });
}
