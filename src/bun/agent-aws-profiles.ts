import type { BedrockProfile, CodingAgent, LlmProvider } from "../shared/types";
import { agentBedrockProfiles, getProviderDefinition } from "../shared/llm-provider";
import { agentKey } from "../shared/agent-adapters/families";
import { getAllAgents, saveAllAgents } from "./agents";

export interface AgentAwsProfiles {
	agentId: string;
	name: string;
	provider: LlmProvider;
	profiles: BedrockProfile[];
	defaultProfile: string | null;
}

/** The Bedrock provider an agent record is on, if it takes AWS profiles. */
function awsProfileProvider(agent: CodingAgent): LlmProvider | undefined {
	const def = getProviderDefinition(agent.llmProvider);
	if (!def?.usesAwsProfiles || def.agentCommand !== agentKey(agent.baseCommand, agent.agentFamily)) return undefined;
	return def.id;
}

function describe(agent: CodingAgent, provider: LlmProvider): AgentAwsProfiles {
	return {
		agentId: agent.id,
		name: agent.name,
		provider,
		profiles: agentBedrockProfiles(agent),
		defaultProfile: agent.providerConfig?.[provider]?.defaultProfile ?? null,
	};
}

/** Every agent on a Bedrock backend, or just `agentId`. */
export async function listAgentAwsProfiles(agentId?: string): Promise<AgentAwsProfiles[]> {
	const agents = await getAllAgents();
	if (agentId && !agents.some((a) => a.id === agentId)) throw new Error(`Unknown agent "${agentId}" — see dev3 agent list.`);
	return agents.flatMap((agent) => {
		if (agentId && agent.id !== agentId) return [];
		const provider = awsProfileProvider(agent);
		if (!provider) {
			if (agentId) throw new Error(`Agent "${agentId}" is not on an Amazon Bedrock backend — set its LLM provider in Settings → Agents first.`);
			return [];
		}
		return [describe(agent, provider)];
	});
}

/** Check a profile list a caller wants stored; returns the cleaned list. */
export function validateAwsProfiles(profiles: unknown, defaultProfile: unknown): { profiles: BedrockProfile[]; defaultProfile: string | undefined } {
	if (!Array.isArray(profiles)) throw new Error("profiles must be an array.");
	const seen = new Set<string>();
	const clean = profiles.map((raw, i): BedrockProfile => {
		const entry = raw as Partial<BedrockProfile> | null;
		const name = typeof entry?.name === "string" ? entry.name.trim() : "";
		const awsProfile = typeof entry?.awsProfile === "string" ? entry.awsProfile.trim() : "";
		const region = typeof entry?.region === "string" ? entry.region.trim() : "";
		if (!name || !awsProfile) throw new Error(`Profile #${i + 1} needs both a name and an AWS profile.`);
		if (seen.has(name)) throw new Error(`Profile name "${name}" is listed twice.`);
		seen.add(name);
		return { name, awsProfile, ...(region ? { region } : {}) };
	});
	if (defaultProfile !== undefined && defaultProfile !== null && typeof defaultProfile !== "string") throw new Error("defaultProfile must be a string.");
	const def = typeof defaultProfile === "string" && defaultProfile.trim() ? defaultProfile.trim() : undefined;
	if (def && !seen.has(def)) throw new Error(`Default profile "${def}" is not in the list.`);
	return { profiles: clean, defaultProfile: def };
}

/** Replace an agent's whole AWS profile list (and its default). */
export async function setAgentAwsProfiles(agentId: string, profiles: unknown, defaultProfile: unknown): Promise<AgentAwsProfiles> {
	const valid = validateAwsProfiles(profiles, defaultProfile);
	const agents = await getAllAgents();
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) throw new Error(`Unknown agent "${agentId}" — see dev3 agent list.`);
	const provider = awsProfileProvider(agent);
	if (!provider) throw new Error(`Agent "${agentId}" is not on an Amazon Bedrock backend — set its LLM provider in Settings → Agents first.`);
	const { defaultProfile: _old, ...rest } = agent.providerConfig?.[provider] ?? {};
	const updated: CodingAgent = {
		...agent,
		providerConfig: {
			...agent.providerConfig,
			[provider]: { ...rest, profiles: valid.profiles, ...(valid.defaultProfile ? { defaultProfile: valid.defaultProfile } : {}) },
		},
	};
	await saveAllAgents(agents.map((a) => (a.id === agentId ? updated : a)));
	return describe(updated, provider);
}
