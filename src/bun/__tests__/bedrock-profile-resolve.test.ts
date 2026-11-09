import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
vi.mock("../account-router", () => ({
	isAutoAccountDefault: vi.fn(async () => false),
	pickAutoAccount: vi.fn(async () => ({ accountId: null, reason: { code: "test" } })),
}));
vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => state.settings),
	saveSettings: vi.fn(async () => undefined),
}));

import { resolveCommandForAgent } from "../agents";
import { DEV3_HOME } from "../paths";
import { CLAUDE_BEDROCK_SSO_SETTINGS_PATH, CLAUDE_STATUSLINE_SETTINGS_PATH } from "../rate-limit-monitor";
import type { CodingAgent } from "../../shared/types";

const ctx = { taskTitle: "t", taskDescription: "d", projectName: "p", projectPath: "/p", worktreePath: "/w" };
const AGENTS_FILE = `${DEV3_HOME}/agents.json`;

const bedrockAgent: CodingAgent = {
	id: "claude-bedrock",
	name: "Claude · Bedrock",
	baseCommand: "claude",
	llmProvider: "bedrock",
	providerConfig: {
		bedrock: {
			profiles: [
				{ name: "og", awsProfile: "og-aws-claude-code", region: "us-west-2" },
				{ name: "sandbox", awsProfile: "sandbox-aws-claude-code" },
			],
			defaultProfile: "sandbox",
		},
	},
	configurations: [
		{ id: "auto", name: "Auto", model: "claude-opus-5", permissionMode: "auto" },
		{ id: "preset-env", name: "Preset env", model: "claude-opus-5", envVars: { AWS_PROFILE: "preset-profile", AWS_REGION: "eu-central-1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "preset-haiku" } },
		{ id: "via-codex", name: "Via codex", model: "gpt-5.5", baseCommandOverride: "codex" },
		{ id: "preset-arn", name: "Preset ARN", model: "claude-opus-5", envVars: { ANTHROPIC_MODEL: "arn:aws:bedrock:us-east-1:1:application-inference-profile/abc" } },
	],
	defaultConfigId: "auto",
};

// The user's own Claude settings are read to decide the SSO refresh, so point them at a scratch dir.
const CLAUDE_DIR = `${DEV3_HOME}/claude-config-test`;
const WORKTREE = `${DEV3_HOME}/worktree-test`;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeAll(() => mkdirSync(DEV3_HOME, { recursive: true }));
beforeEach(() => {
	state.settings = { agentsLayoutRevision: 999, defaultAgentId: "builtin-claude", agentBinaryPaths: {} };
	writeFileSync(AGENTS_FILE, JSON.stringify([bedrockAgent]));
	rmSync(CLAUDE_DIR, { recursive: true, force: true });
	rmSync(WORKTREE, { recursive: true, force: true });
	mkdirSync(CLAUDE_DIR, { recursive: true });
	process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
});
afterAll(() => {
	rmSync(AGENTS_FILE, { force: true });
	rmSync(CLAUDE_DIR, { recursive: true, force: true });
	rmSync(WORKTREE, { recursive: true, force: true });
	if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

describe("resolveCommandForAgent — AWS profile through the real launch path", () => {
	it("injects the picked profile with the Bedrock env and reports it", async () => {
		const r = await resolveCommandForAgent("claude-bedrock", "auto", ctx, { bedrockProfile: "og" });
		expect(r.extraEnv).toMatchObject({ AWS_PROFILE: "og-aws-claude-code", AWS_REGION: "us-west-2", CLAUDE_CODE_USE_BEDROCK: "1" });
		expect(r.resolvedBedrockProfile).toBe("og");
		expect(r.bedrockProfileMissing).toBeUndefined();
	});

	it("pins the alias slots on the real launch path, and a preset's own slot value wins", async () => {
		const plain = await resolveCommandForAgent("claude-bedrock", "auto", ctx, { bedrockProfile: "og" });
		expect(plain.extraEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("global.anthropic.claude-haiku-5-5");
		expect(plain.extraEnv.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(plain.extraEnv.ANTHROPIC_MODEL);
		const preset = await resolveCommandForAgent("claude-bedrock", "preset-env", ctx, { bedrockProfile: "og" });
		expect(preset.extraEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("preset-haiku");
	});

	it("a preset's own ANTHROPIC_MODEL keeps driving the launch slot", async () => {
		const r = await resolveCommandForAgent("claude-bedrock", "preset-arn", ctx, { bedrockProfile: "og" });
		const arn = "arn:aws:bedrock:us-east-1:1:application-inference-profile/abc";
		expect(r.extraEnv.ANTHROPIC_MODEL).toBe(arn);
		expect(r.extraEnv.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(arn);
		expect(r.command).not.toContain("global.anthropic.claude-opus-5");
	});

	it("a picked profile launches with the settings file that refreshes an expired SSO session", async () => {
		const picked = await resolveCommandForAgent("claude-bedrock", "auto", ctx, { bedrockProfile: "og" });
		expect(picked.command).toContain(`--settings ${CLAUDE_BEDROCK_SSO_SETTINGS_PATH}`);
		expect(JSON.parse(readFileSync(CLAUDE_BEDROCK_SSO_SETTINGS_PATH, "utf-8")).awsAuthRefresh).toBe("aws sso login");
		const none = await resolveCommandForAgent("claude-bedrock", "auto", ctx, { bedrockProfile: null });
		expect(none.command).toContain(`--settings ${CLAUDE_STATUSLINE_SETTINGS_PATH}`);
		const missing = await resolveCommandForAgent("claude-bedrock", "auto", ctx, { bedrockProfile: "gone" });
		expect(missing.command).toContain(`--settings ${CLAUDE_STATUSLINE_SETTINGS_PATH}`);
	});

	it("a user's own awsAuthRefresh keeps the shared settings file, so dev3 never shadows it", async () => {
		writeFileSync(`${CLAUDE_DIR}/settings.json`, JSON.stringify({ awsAuthRefresh: "granted sso" }));
		const user = await resolveCommandForAgent("claude-bedrock", "auto", ctx, { bedrockProfile: "og" });
		expect(user.command).toContain(`--settings ${CLAUDE_STATUSLINE_SETTINGS_PATH}`);
		rmSync(`${CLAUDE_DIR}/settings.json`);
		mkdirSync(`${WORKTREE}/.claude`, { recursive: true });
		writeFileSync(`${WORKTREE}/.claude/settings.local.json`, JSON.stringify({ awsAuthRefresh: "aws-vault login" }));
		const project = await resolveCommandForAgent("claude-bedrock", "auto", { ...ctx, worktreePath: WORKTREE }, { bedrockProfile: "og" });
		expect(project.command).toContain(`--settings ${CLAUDE_STATUSLINE_SETTINGS_PATH}`);
	});

	it("the picked profile wins over the preset's own envVars", async () => {
		const r = await resolveCommandForAgent("claude-bedrock", "preset-env", ctx, { bedrockProfile: "og" });
		expect(r.extraEnv.AWS_PROFILE).toBe("og-aws-claude-code");
		expect(r.extraEnv.AWS_REGION).toBe("us-west-2");
	});

	it("None keeps the preset's envVars", async () => {
		const r = await resolveCommandForAgent("claude-bedrock", "preset-env", ctx, { bedrockProfile: null });
		expect(r.extraEnv.AWS_PROFILE).toBe("preset-profile");
		expect(r.resolvedBedrockProfile).toBeNull();
	});

	it("no pick uses the agent default", async () => {
		const r = await resolveCommandForAgent("claude-bedrock", "auto", ctx);
		expect(r.extraEnv.AWS_PROFILE).toBe("sandbox-aws-claude-code");
		expect(r.extraEnv.AWS_REGION).toBeUndefined();
		expect(r.resolvedBedrockProfile).toBe("sandbox");
	});

	it("a removed profile injects nothing but keeps the name, flagged", async () => {
		const r = await resolveCommandForAgent("claude-bedrock", "auto", ctx, { bedrockProfile: "kort" });
		expect(r.extraEnv.AWS_PROFILE).toBeUndefined();
		expect(r.resolvedBedrockProfile).toBe("kort");
		expect(r.bedrockProfileMissing).toBe("kort");
	});

	it("a preset that overrides the command to another CLI takes no profile", async () => {
		const r = await resolveCommandForAgent("claude-bedrock", "via-codex", ctx, { bedrockProfile: "og" });
		expect(r.extraEnv.AWS_PROFILE).toBeUndefined();
		expect(r.resolvedBedrockProfile).toBeUndefined();
	});
});
