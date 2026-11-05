import type { AgentAccountKind, AgentAccountsState, ProjectClaudeLogin } from "../../shared/agent-accounts";
import { AUTO_ACCOUNT_ID } from "../../shared/agent-accounts";
import type { AgentFamily, CodingAgent, NativeTaskAgent, Task } from "../../shared/types";
import { agentKey } from "../../shared/agent-adapters/families";
import { resolveTaskAgentConfig } from "./taskAgentMeta";

export type TaskAgentAccount =
	| { kind: "managed"; label: string; email: string | null; api: boolean }
	| { kind: "system"; email: string | null }
	| { kind: "project"; email: string | null }
	| { kind: "preset" }
	| { kind: "deleted" }
	| { kind: "default" }
	| { kind: "unknown" };

export interface TaskAgentAccountRow {
	key: number;
	agent: CodingAgent | null;
	agentName: string;
	account: TaskAgentAccount;
	auto: boolean;
	/** Claude on the system login: a project pinning `CLAUDE_CONFIG_DIR` overrides it. */
	onSystemClaude: boolean;
}

interface Source {
	key: number;
	main: boolean;
	agentId: string | null;
	configId: string | null;
	cmd: string;
	family: AgentFamily | undefined;
	accountId: string | null | undefined;
}

const PIN_ENV_KEY: Record<AgentAccountKind, string> = {
	claude: "CLAUDE_CONFIG_DIR",
	codex: "CODEX_HOME",
	omp: "PI_CODING_AGENT_DIR",
	pi: "PI_CODING_AGENT_DIR",
};

function resolveAccount(
	kind: AgentAccountKind | null,
	presetPinned: boolean,
	id: string | null | undefined,
	accounts: AgentAccountsState | null,
	projectLogin: ProjectClaudeLogin | null | "pending",
): TaskAgentAccount {
	if (!kind) return { kind: "system", email: null };
	if (presetPinned) return { kind: "preset" };
	if (!accounts) return { kind: "unknown" };
	if (id === AUTO_ACCOUNT_ID) return { kind: "unknown" };
	if (id === undefined) return { kind: "default" };
	if (id === null) {
		if (kind === "claude") {
			if (projectLogin === "pending") return { kind: "unknown" };
			if (projectLogin?.configDir) return { kind: "project", email: projectLogin.identity?.email ?? null };
		}
		const identity =
			kind === "claude" ? accounts.claude.systemIdentity : kind === "codex" ? accounts.codex.currentIdentity : null;
		return { kind: "system", email: identity?.email ?? null };
	}
	const found = accounts[kind]?.accounts.find((a) => a.id === id);
	if (!found) return { kind: "deleted" };
	const email = found.identity?.email ?? null;
	return { kind: "managed", label: found.label, email: email === found.label ? null : email, api: found.auth === "api" };
}

function accountKindOf(key: string): AgentAccountKind | null {
	return key === "claude" || key === "codex" || key === "omp" || key === "pi" ? key : null;
}

export function describeTaskAgentAccounts(
	task: Task,
	agents: CodingAgent[],
	accounts: AgentAccountsState | null,
	projectLogin: ProjectClaudeLogin | null | "pending" = null,
	/** Native "+ Agent" panes: sessionState.panes does not record them. */
	extraAgents: NativeTaskAgent[] = [],
): TaskAgentAccountRow[] {
	const panes = task.sessionState?.panes ?? [];
	const sources: Source[] = panes.flatMap((p, i) =>
		p.parked
			? []
			: [{
				key: i,
				main: i === 0,
				agentId: p.agentId,
				configId: p.configId,
				cmd: p.agentCmd,
				family: p.agentFamily ?? agents.find((a) => a.id === p.agentId)?.agentFamily,
				accountId: p.accountId !== undefined ? p.accountId : i === 0 ? task.accountId : undefined,
			}],
	);
	const taskAgent = panes.length === 0 && task.agentId ? agents.find((a) => a.id === task.agentId) : undefined;
	if (taskAgent) {
		sources.push({
			key: 0,
			main: true,
			agentId: task.agentId,
			configId: task.configId ?? null,
			cmd: taskAgent.baseCommand,
			family: taskAgent.agentFamily,
			accountId: task.accountId,
		});
	}

	const offset = panes.length || 1;
	extraAgents.forEach((p, i) => sources.push({
		key: offset + i,
		main: false,
		agentId: p.agentId,
		configId: p.configId,
		cmd: p.agentCmd,
		family: p.agentFamily ?? agents.find((a) => a.id === p.agentId)?.agentFamily,
		accountId: p.accountId,
	}));

	return sources.map((s) => {
		const agent = agents.find((a) => a.id === s.agentId) ?? null;
		const cmdName = s.cmd.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
		const kind = accountKindOf(agentKey(s.cmd, s.family));
		const presetPinned =
			!!kind && !!resolveTaskAgentConfig(agent, s.configId)?.envVars?.[PIN_ENV_KEY[kind]];
		const auto =
			!presetPinned &&
			(s.accountId === AUTO_ACCOUNT_ID ||
			(s.main && !!task.accountPick && s.accountId !== undefined && s.accountId === task.accountId));
		return {
			key: s.key,
			agent,
			agentName: agent?.name ?? cmdName,
			account: resolveAccount(kind, presetPinned, s.accountId, accounts, projectLogin),
			auto,
			onSystemClaude: kind === "claude" && !presetPinned && s.accountId === null,
		};
	});
}
