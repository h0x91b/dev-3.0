import { describe, it, expect } from "vitest";
import type { AgentAccount, AgentAccountsState } from "../../../shared/agent-accounts";
import type { CodingAgent, Task } from "../../../shared/types";
import type { PaneSessionEntry } from "../../../shared/types/task-lifecycle";
import { describeTaskAgentAccounts } from "../taskAgentAccounts";

const claudeAgent = { id: "builtin-claude", name: "Claude Code", baseCommand: "claude", configurations: [] } as CodingAgent;
const codexAgent = { id: "builtin-codex", name: "Codex", baseCommand: "codex", configurations: [] } as CodingAgent;
const geminiAgent = { id: "builtin-gemini", name: "Gemini", baseCommand: "gemini", configurations: [] } as CodingAgent;
const agents = [claudeAgent, codexAgent, geminiAgent];

function account(id: string, label: string, email: string | null, auth: "oauth" | "api" = "oauth"): AgentAccount {
	return {
		id,
		kind: "claude",
		label,
		identity: email ? { email, organization: null, plan: null, planLabel: null, accountId: null } : null,
		auth,
		api: null,
		createdAt: 0,
	};
}

const accounts = {
	claude: {
		accounts: [account("a1", "Work", "work@example.com"), account("a2", "work@example.com", "work@example.com"), account("a3", "Proxy", null, "api")],
		activeId: null,
		systemConfigDir: "/home/me/.claude",
		systemIdentity: { email: "system@example.com", organization: null, plan: null, planLabel: null, accountId: null },
	},
	codex: {
		accounts: [{ ...account("c1", "Codex Work", "codex@example.com"), kind: "codex" as const }],
		activeId: null,
		currentIdentity: { email: "codex-system@example.com", organization: null, plan: null, planLabel: null, accountId: null },
	},
	omp: { accounts: [], activeId: null },
	pi: { accounts: [], activeId: null },
} as AgentAccountsState;

function pane(over: Partial<PaneSessionEntry>): PaneSessionEntry {
	return { agentCmd: "claude", sessionId: null, agentId: "builtin-claude", configId: null, ...over };
}

function task(over: Partial<Task>): Task {
	return { id: "t1", agentId: "builtin-claude", configId: null, ...over } as Task;
}

describe("describeTaskAgentAccounts", () => {
	it("resolves a managed account with label and email", () => {
		const rows = describeTaskAgentAccounts(
			task({ accountId: "a1", sessionState: { panes: [pane({})] } }), agents, accounts,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ key: 0, agentName: "Claude Code", auto: false, account: { kind: "managed", label: "Work", email: "work@example.com", api: false } });
	});

	it("drops the email when it equals the label", () => {
		const [row] = describeTaskAgentAccounts(task({ accountId: "a2", sessionState: { panes: [pane({})] } }), agents, accounts);
		expect(row.account).toMatchObject({ kind: "managed", email: null });
	});

	it("flags Auto when the router picked the pane-0 account", () => {
		const [row] = describeTaskAgentAccounts(
			task({ accountId: "a1", accountPick: { reason: { code: "only", short: null }, at: "x" }, sessionState: { panes: [pane({ accountId: "a1" })] } }),
			agents, accounts,
		);
		expect(row.auto).toBe(true);
	});

	it("treats the literal auto id as Auto with no account text", () => {
		const [row] = describeTaskAgentAccounts(task({ accountId: "auto", sessionState: { panes: [pane({})] } }), agents, accounts);
		expect(row.auto).toBe(true);
		expect(row.account).toEqual({ kind: "unknown" });
	});

	it("does not flag Auto on an extra pane when the main pane is parked", () => {
		const rows = describeTaskAgentAccounts(
			task({
				accountId: "a1",
				accountPick: { reason: { code: "only", short: null }, at: "x" },
				sessionState: { panes: [pane({ parked: true }), pane({ accountId: "a1" })] },
			}),
			agents, accounts,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ key: 1, auto: false });
	});

	it("follows the pane's agent family for a wrapper command", () => {
		const [row] = describeTaskAgentAccounts(
			task({ sessionState: { panes: [pane({ agentCmd: "ccr code", agentFamily: "claude", accountId: "a1" })] } }),
			agents, accounts,
		);
		expect(row.account).toMatchObject({ kind: "managed", label: "Work" });
	});

	it("returns nothing when every pane is parked", () => {
		expect(describeTaskAgentAccounts(task({ sessionState: { panes: [pane({ parked: true })] } }), agents, accounts)).toEqual([]);
	});

	it("marks API accounts", () => {
		const [row] = describeTaskAgentAccounts(task({ accountId: "a3", sessionState: { panes: [pane({})] } }), agents, accounts);
		expect(row.account).toMatchObject({ kind: "managed", api: true });
	});

	it("shows the system login with its email for claude and codex", () => {
		const rows = describeTaskAgentAccounts(
			task({
				accountId: null,
				sessionState: { panes: [pane({}), pane({ agentCmd: "codex", agentId: "builtin-codex", accountId: null })] },
			}),
			agents, accounts,
		);
		expect(rows[0].account).toEqual({ kind: "system", email: "system@example.com" });
		expect(rows[1].account).toEqual({ kind: "system", email: "codex-system@example.com" });
	});

	it("reports a deleted account for an unknown id", () => {
		const [row] = describeTaskAgentAccounts(task({ accountId: "gone", sessionState: { panes: [pane({})] } }), agents, accounts);
		expect(row.account).toEqual({ kind: "deleted" });
	});

	it("falls back to default when nothing was recorded", () => {
		const [row] = describeTaskAgentAccounts(task({ sessionState: { panes: [pane({})] } }), agents, accounts);
		expect(row.account).toEqual({ kind: "default" });
	});

	it("uses the pane's own account for an extra pane", () => {
		const rows = describeTaskAgentAccounts(
			task({
				accountId: "a1",
				sessionState: { panes: [pane({}), pane({ agentCmd: "codex", agentId: "builtin-codex", accountId: "c1" }), pane({ agentCmd: "codex", agentId: "builtin-codex" })] },
			}),
			agents, accounts,
		);
		expect(rows.map((r) => r.key)).toEqual([0, 1, 2]);
		expect(rows[1].account).toMatchObject({ kind: "managed", label: "Codex Work" });
		expect(rows[2].account).toEqual({ kind: "default" });
	});

	it("skips parked panes", () => {
		const rows = describeTaskAgentAccounts(
			task({ accountId: "a1", sessionState: { panes: [pane({ parked: true }), pane({ agentCmd: "codex", agentId: "builtin-codex" })] } }),
			agents, accounts,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].agentName).toBe("Codex");
		// The main pane's task-level account must not leak onto an extra pane.
		expect(rows[0].account).toEqual({ kind: "default" });
	});

	it("builds a synthetic row from the task agent when there are no panes", () => {
		const [row] = describeTaskAgentAccounts(task({ accountId: "a1" }), agents, accounts);
		expect(row).toMatchObject({ agentName: "Claude Code", account: { kind: "managed", label: "Work" } });
	});

	it("returns nothing without any agent", () => {
		expect(describeTaskAgentAccounts(task({ agentId: null }), agents, accounts)).toEqual([]);
	});

	it("returns unknown accounts while the registry is not loaded", () => {
		const [row] = describeTaskAgentAccounts(task({ accountId: "a1", sessionState: { panes: [pane({})] } }), agents, null);
		expect(row.account).toEqual({ kind: "unknown" });
	});

	it("treats an agent without an account registry as the system login", () => {
		const [row] = describeTaskAgentAccounts(
			task({ sessionState: { panes: [pane({ agentCmd: "/opt/bin/gemini", agentId: "builtin-gemini" })] } }),
			agents, accounts,
		);
		expect(row).toMatchObject({ agentName: "Gemini", account: { kind: "system", email: null } });
	});

	it("does not throw for a pane whose agent is gone or a registry is missing", () => {
		const partial = { claude: accounts.claude, codex: accounts.codex } as AgentAccountsState;
		const rows = describeTaskAgentAccounts(
			task({ sessionState: { panes: [pane({ agentId: "nope", agentCmd: "/usr/bin/omp", accountId: "x" })] } }),
			agents, partial,
		);
		expect(rows[0]).toMatchObject({ agentName: "omp", account: { kind: "deleted" } });
	});

	it("shows the project login for a null-id claude pane when the project pins one", () => {
		const projectLogin = { configDir: "/home/me/.claude-proj", identity: { email: "proj@example.com", organization: null, plan: null, planLabel: null, accountId: null } };
		const t = task({ accountId: null, sessionState: { panes: [pane({}), pane({ agentCmd: "codex", agentId: "builtin-codex", accountId: null })] } });
		const rows = describeTaskAgentAccounts(t, agents, accounts, projectLogin);
		expect(rows[0].account).toEqual({ kind: "project", email: "proj@example.com" });
		expect(rows[1].account).toEqual({ kind: "system", email: "codex-system@example.com" });
		expect(describeTaskAgentAccounts(t, agents, accounts, { configDir: null, identity: null })[0].account).toEqual({ kind: "system", email: "system@example.com" });
	});

	it("does not assert the system identity while the project lookup is pending", () => {
		const t = task({ accountId: null, sessionState: { panes: [pane({}), pane({ agentCmd: "codex", agentId: "builtin-codex", accountId: null })] } });
		const rows = describeTaskAgentAccounts(t, agents, accounts, "pending");
		expect(rows[0].account).toEqual({ kind: "unknown" });
		expect(rows[1].account).toEqual({ kind: "system", email: "codex-system@example.com" });
	});

	describe("onSystemClaude", () => {
		const row = (t: Task, a: CodingAgent[] = agents) => describeTaskAgentAccounts(t, a, accounts)[0];
		it("is true for claude with a null account id", () => {
			expect(row(task({ sessionState: { panes: [pane({ accountId: null })] } })).onSystemClaude).toBe(true);
		});
		it("is false for a managed account, the default, and codex on null", () => {
			expect(row(task({ sessionState: { panes: [pane({ accountId: "a1" })] } })).onSystemClaude).toBe(false);
			expect(row(task({ sessionState: { panes: [pane({})] } })).onSystemClaude).toBe(false);
			expect(row(task({ sessionState: { panes: [pane({ agentCmd: "codex", agentId: "builtin-codex", accountId: null })] } })).onSystemClaude).toBe(false);
		});
		it("is false for claude under a preset pin", () => {
			const pinned = { ...claudeAgent, defaultConfigId: "cfg", configurations: [{ id: "cfg", name: "Cfg", envVars: { CLAUDE_CONFIG_DIR: "/x" } }] } as CodingAgent;
			expect(row(task({ sessionState: { panes: [pane({ configId: "cfg", accountId: null })] } }), [pinned]).onSystemClaude).toBe(false);
		});
	});

	describe("synthetic row and agent family", () => {
		const ccr = { id: "ccr", name: "CCR", baseCommand: "ccr code", agentFamily: "claude", configurations: [] } as CodingAgent;

		it("is skipped when the task agent is not in the list", () => {
			expect(describeTaskAgentAccounts(task({ agentId: "gone", accountId: "a1" }), agents, accounts)).toEqual([]);
		});

		it("takes the family from the agent for a wrapper command", () => {
			const [row] = describeTaskAgentAccounts(task({ agentId: "ccr", accountId: "a1" }), [ccr], accounts);
			expect(row.account).toMatchObject({ kind: "managed", label: "Work" });
		});

		it("takes the family from the pane's agent when the pane has none", () => {
			const [row] = describeTaskAgentAccounts(
				task({ sessionState: { panes: [pane({ agentCmd: "ccr code", agentId: "ccr", accountId: "a1" })] } }), [ccr], accounts,
			);
			expect(row.account).toMatchObject({ kind: "managed", label: "Work" });
		});
	});

	describe("Auto", () => {
		const pick = { reason: { code: "only", short: null }, at: "x" } as Task["accountPick"];

		it("is off when pane 0 carries its own account, different from the task's", () => {
			const [row] = describeTaskAgentAccounts(
				task({ accountId: "a1", accountPick: pick, sessionState: { panes: [pane({ accountId: "a2" })] } }), agents, accounts,
			);
			expect(row.auto).toBe(false);
		});

		it("is on for the synthetic row with a pick and an account", () => {
			const [row] = describeTaskAgentAccounts(task({ accountId: "a1", accountPick: pick }), agents, accounts);
			expect(row.auto).toBe(true);
		});
	});

	it("does not let the project login override a managed or default claude account", () => {
		const projectLogin = { configDir: "/home/me/.claude-proj", identity: null };
		const managed = describeTaskAgentAccounts(task({ sessionState: { panes: [pane({ accountId: "a1" })] } }), agents, accounts, projectLogin);
		const unset = describeTaskAgentAccounts(task({ sessionState: { panes: [pane({})] } }), agents, accounts, projectLogin);
		expect(managed[0].account).toMatchObject({ kind: "managed", label: "Work" });
		expect(unset[0].account).toEqual({ kind: "default" });
	});

	describe("preset pin", () => {
		const withEnv = (agent: CodingAgent, envVars: Record<string, string>): CodingAgent =>
			({ ...agent, defaultConfigId: "cfg", configurations: [{ id: "cfg", name: "Cfg", envVars }] }) as CodingAgent;
		const claudePinned = withEnv(claudeAgent, { CLAUDE_CONFIG_DIR: "/home/me/.claude-preset" });
		const claudePlain = withEnv(claudeAgent, { FOO: "1" });

		it("reports the preset login for a claude config pinning CLAUDE_CONFIG_DIR, whatever the account id", () => {
			const t = task({
				accountId: "a1",
				accountPick: { reason: { code: "only", short: null }, at: "x" },
				sessionState: { panes: [pane({ configId: "cfg", accountId: "a1" })] },
			});
			const [row] = describeTaskAgentAccounts(t, [claudePinned], accounts);
			expect(row.account).toEqual({ kind: "preset" });
			expect(row.auto).toBe(false);
			const [nullRow] = describeTaskAgentAccounts(
				task({ sessionState: { panes: [pane({ configId: "cfg", accountId: null })] } }), [claudePinned], accounts, null,
			);
			expect(nullRow).toMatchObject({ account: { kind: "preset" }, onSystemClaude: false });
		});

		const ompAgent = { id: "builtin-omp", name: "Omp", baseCommand: "omp", configurations: [] } as CodingAgent;
		const piAgent = { id: "builtin-pi", name: "Pi", baseCommand: "pi", configurations: [] } as CodingAgent;
		it.each([
			["claude", "CLAUDE_CONFIG_DIR", claudeAgent],
			["codex", "CODEX_HOME", codexAgent],
			["omp", "PI_CODING_AGENT_DIR", ompAgent],
			["pi", "PI_CODING_AGENT_DIR", piAgent],
		])("reports the preset login for a %s config pinning %s", (cmd, envKey, agent) => {
			const pinned = withEnv(agent, { [envKey]: "/home/me/.preset" });
			const [row] = describeTaskAgentAccounts(
				task({ sessionState: { panes: [pane({ agentCmd: cmd, agentId: agent.id, configId: "cfg", accountId: "c1" })] } }), [pinned], accounts,
			);
			expect(row.account).toEqual({ kind: "preset" });
		});

		it("ignores a pin key that belongs to another agent", () => {
			const wrongKey = withEnv(claudeAgent, { CODEX_HOME: "/home/me/.codex-preset" });
			const [row] = describeTaskAgentAccounts(
				task({ sessionState: { panes: [pane({ configId: "cfg", accountId: "a1" })] } }), [wrongKey], accounts,
			);
			expect(row.account).toMatchObject({ kind: "managed", label: "Work" });
		});

		it("takes the pin from the default config when configId is null", () => {
			const [row] = describeTaskAgentAccounts(task({ sessionState: { panes: [pane({ accountId: "a1" })] } }), [claudePinned], accounts);
			expect(row.account).toEqual({ kind: "preset" });
		});

		it("wins over an unloaded registry", () => {
			const [row] = describeTaskAgentAccounts(
				task({ sessionState: { panes: [pane({ configId: "cfg", accountId: "a1" })] } }), [claudePinned], null,
			);
			expect(row.account).toEqual({ kind: "preset" });
		});

		it("leaves a config without the pin key unchanged", () => {
			const [row] = describeTaskAgentAccounts(
				task({ sessionState: { panes: [pane({ configId: "cfg", accountId: "a1" })] } }), [claudePlain], accounts,
			);
			expect(row.account).toMatchObject({ kind: "managed", label: "Work" });
		});

		it("uses task.configId for the synthetic row", () => {
			const [row] = describeTaskAgentAccounts(task({ configId: "cfg", accountId: "a1" }), [claudePinned], accounts);
			expect(row.account).toEqual({ kind: "preset" });
		});
	});

	it("adds native extra agents after the main pane with their own accounts", () => {
		const rows = describeTaskAgentAccounts(
			task({ accountId: "a1", terminalBackend: "native", sessionState: { panes: [pane({})] } }), agents, accounts, null,
			[
				{ paneId: "p2", agentCmd: "claude", agentId: "builtin-claude", configId: null, accountId: "a2" },
				{ paneId: "p3", agentCmd: "codex", agentId: "builtin-codex", configId: null, accountId: "c1" },
			],
		);
		expect(rows.map((r) => r.key)).toEqual([0, 1, 2]);
		expect(rows.map((r) => r.account.kind === "managed" && r.account.label)).toEqual(["Work", "work@example.com", "Codex Work"]);
		expect(rows[1].auto).toBe(false);
	});

	it("leaves a tmux task without extra agents unchanged", () => {
		const rows = describeTaskAgentAccounts(task({ accountId: "a1", sessionState: { panes: [pane({})] } }), agents, accounts);
		expect(rows).toHaveLength(1);
	});
});
