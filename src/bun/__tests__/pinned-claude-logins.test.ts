import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc-handlers/shared", () => ({
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../data", () => ({ loadProjects: vi.fn(), getProject: vi.fn(), getTask: vi.fn() }));
vi.mock("../repo-config", () => ({ resolveProjectEnv: vi.fn() }));
vi.mock("../agents", () => ({ resolveClaudePickLaunch: vi.fn() }));
vi.mock("../rpc-handlers/tmux-pty/resume", () => ({ claudeResumePickTarget: vi.fn(() => null) }));
vi.mock("../ops-worktree", () => ({
	resolveLaunchProject: vi.fn(async (project: any) => ({ ...project, launch: true })),
	rootProjectFor: vi.fn((project: any, task: any) => (task.attachedRepo ? { ...project, path: task.attachedRepo } : project)),
}));
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
	listAgentAccounts: vi.fn(async () => ({ claude: { accounts: [{ id: "cl-1" }, { id: "cl-2" }] } })),
}));

import * as data from "../data";
import { resolveProjectEnv } from "../repo-config";
import { resolveClaudePickLaunch } from "../agents";
import { claudeResumePickTarget } from "../rpc-handlers/tmux-pty/resume";
import { log } from "../rpc-handlers/shared";
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
	it("groups projects by their normalized dir, treating ~/.claude as the system login and skipping unpinned ones", async () => {
		const logins = await agentAccountHandlers.listPinnedClaudeLogins();
		expect(logins).toEqual([
			{
				configDir: "/work/shared/.claude",
				identity: expect.objectContaining({ email: "shared@example.com" }),
				projectNames: ["a", "b"],
				accountId: null,
			},
		]);

		// A project pinning its home .claude is the system login.
		vi.mocked(data.getProject).mockResolvedValue(project("c"));
		await expect(agentAccountHandlers.getProjectClaudeLogin({ projectId: "c" })).resolves.toEqual({
			configDir: null,
			identity: null,
		});
	});

});

describe("getClaudePickLaunches", () => {
	beforeEach(() => {
		// Stand-in for the launcher: no pick and cl-1 stay in the project folder, only no pick keeps the env.
		vi.mocked(resolveClaudePickLaunch).mockImplementation(async (accountId) => ({
			projectFolder: accountId === undefined || accountId === "cl-1",
			keepsProjectBackend: accountId === undefined,
		}));
	});

	it("reports the backend each project's env puts Claude on for no pick, and drops it for a named login", async () => {
		const cases: Array<[string, string | null]> = [
			["a", null],
			["f", "bedrock"],
			["g", "env-auth"],
			["h", null],
			["i", "model"],
			["j", "model"],
			["k", "gateway"],
			["l", "env-auth"],
		];
		for (const [id, backend] of cases) {
			vi.mocked(data.getProject).mockResolvedValue(project(id));
			await expect(agentAccountHandlers.getClaudePickLaunches({ projectId: id }), id).resolves.toEqual({
				none: { projectFolder: true, backend },
				accounts: { "cl-1": { projectFolder: true, backend: null }, "cl-2": { projectFolder: false, backend: null } },
			});
		}
	});

	it("names no backend when the project pins no folder", async () => {
		vi.mocked(data.getProject).mockResolvedValue(project("c"));
		vi.mocked(resolveProjectEnv).mockResolvedValueOnce({ CLAUDE_CONFIG_DIR: "~/.claude", CLAUDE_CODE_USE_BEDROCK: "1" });
		await expect(agentAccountHandlers.getClaudePickLaunches({ projectId: "c" })).resolves.toMatchObject({ none: { backend: null } });
	});

	it("asks about a resume with the task's worktree, env and the conversation the resume heals to", async () => {
		vi.mocked(data.getProject).mockResolvedValue(project("a"));
		const task = { id: "t1", worktreePath: "/wt/t1", attachedRepo: "/repos/root", foreignCode: true } as any;
		vi.mocked(data.getTask).mockResolvedValue(task);
		vi.mocked(claudeResumePickTarget).mockReturnValueOnce({ sessionId: "s-1", agentLatest: false, savedAccountId: "cl-2" });
		await agentAccountHandlers.getClaudePickLaunches({ projectId: "a", taskId: "t1", resume: true });
		expect(claudeResumePickTarget).toHaveBeenCalledWith(task);
		expect(resolveProjectEnv).toHaveBeenCalledWith(expect.objectContaining({ id: "a", launch: true }), "/wt/t1", { foreignCode: true });
		expect(resolveClaudePickLaunch).toHaveBeenCalledWith("cl-1", {
			projectEnv: { CLAUDE_CONFIG_DIR: "/work/shared/.claude" },
			projectPath: "/repos/root",
			worktreePath: "/wt/t1",
			resume: true,
			sessionId: "s-1",
		});
	});

	it("leaves out the accounts a --continue resume would refuse to switch to, keeping same-folder switches", async () => {
		vi.mocked(data.getProject).mockResolvedValue(project("a"));
		vi.mocked(data.getTask).mockResolvedValue({ id: "t1", worktreePath: "/wt/t1" } as any);
		// The pane ran on cl-2 with no conversation id: only a re-pick of cl-2 is no switch.
		vi.mocked(claudeResumePickTarget).mockReturnValueOnce({ sessionId: null, agentLatest: true, savedAccountId: "cl-2" });
		const { accounts } = await agentAccountHandlers.getClaudePickLaunches({ projectId: "a", taskId: "t1", resume: true });
		expect(accounts).toEqual({ "cl-2": { projectFolder: false, backend: null } });

		// With no saved account, a --continue switch that stays in the project folder is kept.
		vi.mocked(claudeResumePickTarget).mockReturnValueOnce({ sessionId: null, agentLatest: true, savedAccountId: undefined });
		const kept = await agentAccountHandlers.getClaudePickLaunches({ projectId: "a", taskId: "t1", resume: true });
		expect(Object.keys(kept.accounts)).toEqual(["cl-1"]);
	});

	it("logs a failure before the picker sees it", async () => {
		vi.mocked(data.getProject).mockRejectedValueOnce(new Error("gone"));
		await expect(agentAccountHandlers.getClaudePickLaunches({ projectId: "z" })).rejects.toThrow("gone");
		expect(log.warn).toHaveBeenCalledWith("getClaudePickLaunches failed", expect.objectContaining({ projectId: "z" }));
	});
});
