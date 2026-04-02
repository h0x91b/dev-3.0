import type { AgentConfiguration, CodingAgent, Task } from "../../shared/types";

function resolveTaskAgentConfig(agent: CodingAgent | null, configId: string | null): AgentConfiguration | null {
	if (!agent) return null;
	if (configId) {
		const exact = agent.configurations.find((config) => config.id === configId);
		if (exact) return exact;
	}
	return agent.configurations.find((config) => config.id === agent.defaultConfigId) ?? agent.configurations[0] ?? null;
}

function getFallbackModelLabel(model: string | undefined): string {
	if (!model) return "";

	const noDuration = model.replace(/\[[^\]]+\]/g, "");
	const scoped = noDuration.split("/").pop() ?? noDuration;

	return scoped
		.replace(/-preview/gi, "")
		.replace(/-thinking/gi, "")
		.replace(/^gpt-(\d(?:\.\d+)*)/i, "GPT-$1")
		.replace(/^gemini-(\d(?:\.\d+)*)(?:-(flash-lite|flash|pro))?/i, (_, version: string, tier?: string) => {
			if (!tier) return `Gemini ${version}`;
			const normalizedTier = tier
				.split("-")
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(" ");
			return `${version} ${normalizedTier}`;
		})
		.replace(/^claude-(.+)$/i, (_, tail: string) =>
			`Claude ${tail.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase())}`,
		)
		.trim();
}

export function getCompactConfigLabel(config: AgentConfiguration | null): string {
	if (!config) return "";

	const trimmedName = config.name.trim();
	const parenMatch = trimmedName.match(/^(.*)\(([^)]+)\)$/);
	if (parenMatch) {
		const prefix = parenMatch[1].trim();
		const model = parenMatch[2].trim();
		const detail = prefix
			.replace(/^Default$/i, "")
			.replace(/^Default\s+/i, "")
			.split("/")
			.map((part) => part.trim())
			.filter(Boolean)
			.slice(-1)[0] ?? "";
		return detail ? `${model} · ${detail}` : model;
	}

	if (/^default$/i.test(trimmedName)) {
		return getFallbackModelLabel(config.model);
	}

	return trimmedName.replace(/^Default\s+/i, "").trim();
}

export function getTaskAgentMeta(task: Task, agents: CodingAgent[]) {
	const agent = task.agentId ? agents.find((candidate) => candidate.id === task.agentId) ?? null : null;
	const config = resolveTaskAgentConfig(agent, task.configId ?? null);
	const configLabel = getCompactConfigLabel(config);

	return {
		agent,
		config,
		configLabel,
	};
}
