import { describe, expect, it } from "vitest";
import { applyBedrockProfileEnv } from "../agents";
import { buildAgentEnv } from "../rpc-handlers/shared-pure";
import { bedrockProfileEnv, bedrockProfilesFor, resolveBedrockProfile } from "../../shared/llm-provider";
import type { AgentConfiguration, CodingAgent, ProviderConfig } from "../../shared/types";

const PROFILES: ProviderConfig = {
	bedrock: {
		profiles: [
			{ name: "og", awsProfile: "og-aws-claude-code", region: "us-west-2" },
			{ name: "sandbox", awsProfile: "sandbox-aws-claude-code" },
		],
		defaultProfile: "sandbox",
	},
};

const bedrockAgent = (providerConfig: ProviderConfig = PROFILES, overrides?: Partial<CodingAgent>): CodingAgent => ({
	id: "claude-bedrock",
	name: "Claude · Bedrock",
	baseCommand: "claude",
	configurations: [],
	llmProvider: "bedrock",
	providerConfig,
	...overrides,
});

const config = (envVars?: Record<string, string>): AgentConfiguration => ({ id: "c1", name: "Auto", envVars });

describe("resolveBedrockProfile", () => {
	it("undefined picks the default profile", () => {
		expect(resolveBedrockProfile("bedrock", PROFILES, undefined).profile?.name).toBe("sandbox");
	});
	it("null picks none", () => {
		expect(resolveBedrockProfile("bedrock", PROFILES, null)).toEqual({ profile: null });
	});
	it("a name picks that entry", () => {
		expect(resolveBedrockProfile("bedrock", PROFILES, "og").profile?.awsProfile).toBe("og-aws-claude-code");
	});
	it("a removed name resolves to none and is flagged", () => {
		expect(resolveBedrockProfile("bedrock", PROFILES, "gone")).toEqual({ profile: null, missing: "gone" });
	});
	it("the native provider takes no profile even with a list stored", () => {
		expect(bedrockProfilesFor("anthropic", { anthropic: PROFILES.bedrock })).toEqual([]);
	});
	it("drops entries with no AWS profile value", () => {
		expect(bedrockProfilesFor("bedrock", { bedrock: { profiles: [{ name: "x", awsProfile: " " }] } })).toEqual([]);
	});
});

describe("bedrockProfileEnv", () => {
	it("sets AWS_REGION only when the entry has one", () => {
		expect(bedrockProfileEnv({ name: "og", awsProfile: "og-aws-claude-code", region: "us-west-2" }))
			.toEqual({ AWS_PROFILE: "og-aws-claude-code", AWS_REGION: "us-west-2" });
		expect(bedrockProfileEnv({ name: "s", awsProfile: "sandbox" })).toEqual({ AWS_PROFILE: "sandbox" });
		expect(bedrockProfileEnv(null)).toEqual({});
	});
});

describe("applyBedrockProfileEnv — launch env precedence", () => {
	it("the picked profile overrides the project's config.local.json env", () => {
		const extraEnv: Record<string, string> = {};
		const result = applyBedrockProfileEnv(bedrockAgent(), config(), extraEnv, { bedrockProfile: "og" });
		expect(result).toEqual({ resolvedBedrockProfile: "og" });
		// Same merge order the launch paths use: project env under the agent env.
		const projectEnv = { AWS_PROFILE: "sandbox", AWS_REGION: "eu-west-1" };
		const env = { ...projectEnv, ...buildAgentEnv(extraEnv, "t1") };
		expect(env.AWS_PROFILE).toBe("og-aws-claude-code");
		expect(env.AWS_REGION).toBe("us-west-2");
	});

	it("the picked profile overrides a preset's own envVars", () => {
		const preset = config({ AWS_PROFILE: "preset-profile", AWS_REGION: "eu-central-1" });
		const extraEnv: Record<string, string> = { ...preset.envVars };
		applyBedrockProfileEnv(bedrockAgent(), preset, extraEnv, { bedrockProfile: "og" });
		expect(extraEnv).toMatchObject({ AWS_PROFILE: "og-aws-claude-code", AWS_REGION: "us-west-2" });
	});

	it("None leaves the project env in charge", () => {
		const extraEnv: Record<string, string> = {};
		const result = applyBedrockProfileEnv(bedrockAgent(), config(), extraEnv, { bedrockProfile: null });
		expect(result).toEqual({ resolvedBedrockProfile: null });
		const env: Record<string, string> = { AWS_PROFILE: "sandbox", ...buildAgentEnv(extraEnv, "t1") };
		expect(env.AWS_PROFILE).toBe("sandbox");
		expect(env.AWS_REGION).toBeUndefined();
	});

	it("a profile without a region keeps the project's AWS_REGION", () => {
		const extraEnv: Record<string, string> = {};
		applyBedrockProfileEnv(bedrockAgent(), config(), extraEnv, { bedrockProfile: "sandbox" });
		const env: Record<string, string> = { AWS_REGION: "eu-west-1", ...buildAgentEnv(extraEnv, "t1") };
		expect(env.AWS_PROFILE).toBe("sandbox-aws-claude-code");
		expect(env.AWS_REGION).toBe("eu-west-1");
	});

	it("no pick resolves to the agent's default and reports it for the pane", () => {
		const extraEnv: Record<string, string> = {};
		expect(applyBedrockProfileEnv(bedrockAgent(), config(), extraEnv, undefined)).toEqual({ resolvedBedrockProfile: "sandbox" });
		expect(extraEnv.AWS_PROFILE).toBe("sandbox-aws-claude-code");
	});

	it("does nothing for an agent on the native backend", () => {
		const extraEnv: Record<string, string> = {};
		const agent = bedrockAgent(PROFILES, { llmProvider: "anthropic" });
		expect(applyBedrockProfileEnv(agent, config(), extraEnv, { bedrockProfile: "og" })).toEqual({});
		expect(extraEnv).toEqual({});
	});

	it("does nothing for a Bedrock agent with no profiles configured", () => {
		const extraEnv: Record<string, string> = {};
		expect(applyBedrockProfileEnv(bedrockAgent({ bedrock: {} }), config(), extraEnv, { bedrockProfile: "og" })).toEqual({});
		expect(extraEnv).toEqual({});
	});
});
