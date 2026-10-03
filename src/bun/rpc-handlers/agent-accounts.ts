/**
 * RPC handlers for the agent account switcher (multi-account per agent CLI,
 * hot-swap without re-login). Thin wrappers over src/bun/agent-accounts.ts.
 */

import type {
	AgentAccount,
	AgentAccountKind,
	AgentAccountsState,
	ClaudeSlotModels,
	PinnedClaudeLogin,
	ProjectClaudeLogin,
} from "../../shared/agent-accounts";
import type { ClaudeApiProfileDraft } from "../agent-accounts";
import { parseEnvLines, shortCodexWorkspaceId } from "../../shared/agent-accounts";
import { pinnedClaudeConfigDir } from "../../shared/claude-config-dir";
import * as accounts from "../agent-accounts";
import * as data from "../data";
import { resolveProjectEnv } from "../repo-config";
import { homedir } from "node:os";
import { log } from "./shared";

function accountLogDetails(account: AgentAccount) {
	return {
		id: account.id.slice(0, 8),
		label: account.label,
		workspaceId: account.kind === "codex" ? shortCodexWorkspaceId(account.identity) : null,
		workspaceName: account.kind === "codex" ? account.identity?.organization ?? null : null,
	};
}

async function listAgentAccounts(): Promise<AgentAccountsState> {
	log.info("→ listAgentAccounts");
	const state = await accounts.listAgentAccounts();
	log.info("← listAgentAccounts", {
		claude: state.claude.accounts.length,
		codex: {
			count: state.codex.accounts.length,
			activeId: state.codex.activeId?.slice(0, 8) ?? null,
			accounts: state.codex.accounts.map(accountLogDetails),
		},
	});
	return state;
}

async function importAgentAccount(params: { kind: AgentAccountKind }): Promise<AgentAccount> {
	log.info("→ importAgentAccount", params);
	const account =
		params.kind === "claude"
			? await accounts.importCurrentClaudeAccount()
			: await accounts.importCurrentCodexAccount();
	log.info("← importAgentAccount", accountLogDetails(account));
	return account;
}

async function addAgentApiProfile(params: {
	kind: AgentAccountKind;
	label?: string;
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	slotModels?: ClaudeSlotModels;
	envText?: string;
}): Promise<AgentAccount> {
	log.info("→ addAgentApiProfile", { kind: params.kind, baseUrl: params.baseUrl, model: params.model });
	if (params.kind !== "claude") throw new Error("API profiles are only supported for Claude Code");
	const env = params.envText ? parseEnvLines(params.envText) : {};
	const account = await accounts.addClaudeApiProfile({
		label: params.label,
		baseUrl: params.baseUrl,
		apiKey: params.apiKey,
		model: params.model,
		slotModels: params.slotModels,
		env,
	});
	log.info("← addAgentApiProfile", { id: account.id, label: account.label });
	return account;
}

async function getAgentApiProfileDraft(params: { kind: AgentAccountKind; accountId: string }): Promise<ClaudeApiProfileDraft> {
	log.info("→ getAgentApiProfileDraft", { kind: params.kind, accountId: params.accountId });
	if (params.kind !== "claude") throw new Error("API profiles are only supported for Claude Code");
	const draft = await accounts.getClaudeApiProfileDraft(params.accountId);
	log.info("← getAgentApiProfileDraft", { hasApiKey: draft.hasApiKey });
	return draft;
}

async function updateAgentApiProfile(params: {
	kind: AgentAccountKind;
	accountId: string;
	label?: string;
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	slotModels?: ClaudeSlotModels;
	envText?: string;
}): Promise<AgentAccount> {
	log.info("→ updateAgentApiProfile", { kind: params.kind, accountId: params.accountId, baseUrl: params.baseUrl, model: params.model });
	if (params.kind !== "claude") throw new Error("API profiles are only supported for Claude Code");
	const env = params.envText !== undefined ? parseEnvLines(params.envText) : undefined;
	const account = await accounts.updateClaudeApiProfile(params.accountId, {
		label: params.label,
		baseUrl: params.baseUrl,
		apiKey: params.apiKey,
		model: params.model,
		slotModels: params.slotModels,
		env,
	});
	log.info("← updateAgentApiProfile", { id: account.id, label: account.label });
	return account;
}

async function prepareAgentAccountLogin(params: { kind: AgentAccountKind }): Promise<{ accountId: string | null; loginCommand: string }> {
	log.info("→ prepareAgentAccountLogin", params);
	const result =
		params.kind === "claude" ? await accounts.prepareClaudeLogin() : await accounts.prepareCodexLogin();
	log.info("← prepareAgentAccountLogin", { accountId: result.accountId });
	return result;
}

async function completeAgentAccountLogin(params: { kind: AgentAccountKind; accountId?: string | null }): Promise<AgentAccount> {
	log.info("→ completeAgentAccountLogin", params);
	if (!params.accountId) throw new Error(`accountId is required for ${params.kind} login verification`);
	try {
		const account =
			params.kind === "claude"
				? await accounts.completeClaudeLogin(params.accountId)
				: await accounts.completeCodexLogin(params.accountId);
		log.info("← completeAgentAccountLogin", accountLogDetails(account));
		return account;
	} catch (error) {
		log.warn("← completeAgentAccountLogin failed", {
			kind: params.kind,
			pendingAccountId: params.accountId.slice(0, 8),
			error: String(error),
		});
		throw error;
	}
}

async function setActiveAgentAccount(params: { kind: AgentAccountKind; accountId: string | null }): Promise<void> {
	log.info("→ setActiveAgentAccount", params);
	// Both kinds now accept null = "default to the system login" (~/.claude /
	// ~/.codex). Codex no longer swaps auth.json — this only moves the default.
	if (params.kind === "claude") {
		await accounts.setActiveClaudeAccount(params.accountId);
	} else {
		await accounts.setActiveCodexAccount(params.accountId);
	}
	log.info("← setActiveAgentAccount done");
}

async function removeAgentAccount(params: { kind: AgentAccountKind; accountId: string }): Promise<void> {
	log.info("→ removeAgentAccount", params);
	await accounts.removeAgentAccount(params.kind, params.accountId);
	log.info("← removeAgentAccount done");
}

async function renameAgentAccount(params: { kind: AgentAccountKind; accountId: string; label: string }): Promise<void> {
	log.info("→ renameAgentAccount", { kind: params.kind, accountId: params.accountId });
	await accounts.renameAgentAccount(params.kind, params.accountId, params.label);
	log.info("← renameAgentAccount done");
}

/** Which Claude login a project's sessions use. Read on demand so an edit to
 *  `.dev3/config*.json` shows on the next open of the launch dialog. */
async function getProjectClaudeLogin(params: { projectId: string }): Promise<ProjectClaudeLogin> {
	try {
		const project = await data.getProject(params.projectId);
		const configDir = pinnedClaudeConfigDir((await resolveProjectEnv(project)).CLAUDE_CONFIG_DIR, homedir(), project.path);
		if (!configDir) return { configDir: null, identity: null };
		return { configDir, identity: accounts.readClaudeConfigDirIdentity(configDir) };
	} catch (err) {
		log.warn("getProjectClaudeLogin failed", { projectId: params.projectId, error: String(err) });
		return { configDir: null, identity: null };
	}
}

/** Every login some project pins via `CLAUDE_CONFIG_DIR`, one entry per
 *  directory. Global surfaces list these beside `~/.claude`, because those
 *  projects' sessions never use the system login. */
async function listPinnedClaudeLogins(): Promise<PinnedClaudeLogin[]> {
	const byDir = new Map<string, PinnedClaudeLogin>();
	for (const project of await data.loadProjects()) {
		try {
			const configDir = pinnedClaudeConfigDir((await resolveProjectEnv(project)).CLAUDE_CONFIG_DIR, homedir(), project.path);
			if (!configDir) continue;
			const entry = byDir.get(configDir);
			if (entry) entry.projectNames.push(project.name);
			else byDir.set(configDir, { configDir, identity: accounts.readClaudeConfigDirIdentity(configDir), projectNames: [project.name] });
		} catch (err) {
			log.warn("listPinnedClaudeLogins: project env unreadable", { projectId: project.id, error: String(err) });
		}
	}
	return [...byDir.values()];
}

export const agentAccountHandlers = {
	getProjectClaudeLogin,
	listPinnedClaudeLogins,
	listAgentAccounts,
	importAgentAccount,
	addAgentApiProfile,
	getAgentApiProfileDraft,
	updateAgentApiProfile,
	prepareAgentAccountLogin,
	completeAgentAccountLogin,
	setActiveAgentAccount,
	removeAgentAccount,
	renameAgentAccount,
};
