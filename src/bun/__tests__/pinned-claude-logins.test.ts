import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc-handlers/shared", () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../data", () => ({ loadProjects: vi.fn(), getProject: vi.fn() }));
vi.mock("../repo-config", () => ({ resolveProjectEnv: vi.fn() }));
vi.mock("../agent-accounts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../agent-accounts")>()),
	readClaudeConfigDirIdentity: vi.fn((dir: string) => ({
		email: `${dir.split("/").slice(-2)[0]}@example.com`,
		organization: null,
		plan: null,
		planLabel: null,
		accountId: null,
	})),
	claudeAccountForConfigDir: vi.fn(() => null),
}));

import * as data from "../data";
import { resolveProjectEnv } from "../repo-config";
import { agentAccountHandlers } from "../rpc-handlers/agent-accounts";

const project = (id: string) => ({ id, name: id, path: `/repos/${id}` }) as any;

beforeEach(() => {
	vi.mocked(data.loadProjects).mockResolvedValue([project("a"), project("b"), project("c"), project("d"), project("e")]);
	vi.mocked(resolveProjectEnv).mockImplementation(async (p: any) => {
		const env: Record<string, Record<string, string>> = {
			a: { CLAUDE_CONFIG_DIR: "/work/shared/.claude" },
			b: { CLAUDE_CONFIG_DIR: "/work/shared/.claude/" },
			c: { CLAUDE_CONFIG_DIR: "~/.claude" },
			d: {},
			f: { CLAUDE_CONFIG_DIR: "/work/f/.claude", CLAUDE_CODE_USE_BEDROCK: "1" },
			g: { CLAUDE_CONFIG_DIR: "/work/g/.claude", ANTHROPIC_API_KEY: "k" },
			h: { CLAUDE_CONFIG_DIR: "/work/h/.claude", CLAUDE_CODE_USE_BEDROCK: "0" },
			i: { CLAUDE_CONFIG_DIR: "/work/i/.claude", ANTHROPIC_MODEL: "claude-opus-5-5" },
			j: { CLAUDE_CONFIG_DIR: "/work/j/.claude", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5" },
			k: { CLAUDE_CONFIG_DIR: "/work/k/.claude", ANTHROPIC_BASE_URL: "https://gw.example.com" },
			l: { CLAUDE_CONFIG_DIR: "/work/l/.claude", ANTHROPIC_BASE_URL: "https://gw.example.com", ANTHROPIC_AUTH_TOKEN: "t" },
		};
		if (p.id === "e") throw new Error("unreadable config");
		return env[p.id];
	});
});

describe("listPinnedClaudeLogins", () => {
	it("groups projects by their normalized dir and skips ~/.claude and unpinned ones", async () => {
		const logins = await agentAccountHandlers.listPinnedClaudeLogins();
		expect(logins).toEqual([
			{
				configDir: "/work/shared/.claude",
				identity: expect.objectContaining({ email: "shared@example.com" }),
				projectNames: ["a", "b"],
				accountId: null,
			},
		]);
	});

	it("treats a project pinning its home .claude as the system login", async () => {
		vi.mocked(data.getProject).mockResolvedValue(project("c"));
		await expect(agentAccountHandlers.getProjectClaudeLogin({ projectId: "c" })).resolves.toEqual({
			configDir: null,
			identity: null,
		});
	});

	it.each([
		["a", null],
		["f", "bedrock"],
		["g", "env-auth"],
		["h", null],
		["i", "model"],
		["j", "model"],
		["k", "gateway"],
		["l", "env-auth"],
	])("reports the backend project %s's env puts Claude on: %s", async (id, backend) => {
		vi.mocked(data.getProject).mockResolvedValue(project(id));
		await expect(agentAccountHandlers.getProjectClaudeLogin({ projectId: id })).resolves.toMatchObject({ backend });
	});
});
