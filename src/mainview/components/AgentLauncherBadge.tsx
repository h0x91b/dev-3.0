import type { CodingAgent } from "../../shared/types";
import {
	type AgentIcon,
	ClaudeIcon,
	CodexIcon,
	CopilotIcon,
	CursorIcon,
	GeminiIcon,
	OpenCodeIcon,
} from "./agent-launcher-icons";

export function resolveAgentLauncherIcon(agent: CodingAgent): AgentIcon | null {
	const agentName = agent.name.toLowerCase();

	if (agent.id === "builtin-claude" || agent.baseCommand === "claude" || agentName.includes("claude")) {
		return ClaudeIcon;
	}
	if (agent.id === "builtin-codex" || agent.baseCommand === "codex" || agentName.includes("codex")) {
		return CodexIcon;
	}
	if (agent.id === "builtin-gemini" || agent.baseCommand === "gemini" || agentName.includes("gemini")) {
		return GeminiIcon;
	}
	if (agent.id === "builtin-cursor" || agentName.includes("cursor")) {
		return CursorIcon;
	}
	if (agent.id === "builtin-opencode" || agent.baseCommand === "opencode" || agentName.includes("opencode")) {
		return OpenCodeIcon;
	}
	if (agent.id === "builtin-copilot" || agent.baseCommand === "copilot" || agentName.includes("copilot")) {
		return CopilotIcon;
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
