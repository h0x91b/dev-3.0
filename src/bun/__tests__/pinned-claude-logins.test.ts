import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc-handlers/shared", () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../data", () => ({ loadProjects: vi.fn(), getProject: vi.fn() }));
vi.mock("../repo-config", () => ({ resolveProjectEnv: vi.fn() }));
vi.mock("../agent-accounts", () => ({
	readClaudeConfigDirIdentity: vi.fn((dir: string) => ({
		email: `${dir.split("/").slice(-2)[0]}@example.com`,
		organization: null,
		plan: null,
		planLabel: null,
		accountId: null,
	})),
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
});
