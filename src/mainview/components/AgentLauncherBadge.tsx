import type { ComponentType } from "react";
import { Claude, Codex, Cursor, Gemini, OpenCode } from "@lobehub/icons/es/icons";
import type { CodingAgent } from "../../shared/types";

type AgentLauncherIconComponent = ComponentType<any>;

export function resolveAgentLauncherIcon(agent: CodingAgent): AgentLauncherIconComponent | null {
	const agentName = agent.name.toLowerCase();

	if (agent.id === "builtin-claude" || agent.baseCommand === "claude" || agentName.includes("claude")) {
		return Claude.Color;
	}
	if (agent.id === "builtin-codex" || agent.baseCommand === "codex" || agentName.includes("codex")) {
		return Codex.Color;
	}
	if (agent.id === "builtin-gemini" || agent.baseCommand === "gemini" || agentName.includes("gemini")) {
		return Gemini.Color;
	}
	if (agent.id === "builtin-cursor" || agentName.includes("cursor")) {
		return Cursor.Avatar;
	}
	if (agent.id === "builtin-opencode" || agent.baseCommand === "opencode" || agentName.includes("opencode")) {
		return OpenCode.Avatar;
	}

	return null;
}

interface AgentLauncherBadgeProps {
	agent: CodingAgent;
	size?: number;
}

function AgentLauncherBadge({ agent, size = 16 }: AgentLauncherBadgeProps) {
	const Icon = resolveAgentLauncherIcon(agent);
	if (!Icon) return null;

	return (
		<span
			className="inline-flex items-center justify-center shrink-0"
			role="img"
			aria-label={agent.name}
			title={agent.name}
		>
			<Icon size={size} className="block shrink-0" aria-hidden />
		</span>
	);
}

export default AgentLauncherBadge;
