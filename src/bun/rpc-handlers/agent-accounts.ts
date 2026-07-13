/**
 * RPC handlers for the agent account switcher (multi-account per agent CLI,
 * hot-swap without re-login). Thin wrappers over src/bun/agent-accounts.ts.
 */

import type { AgentAccount, AgentAccountKind, AgentAccountsState, ClaudeSlotModels } from "../../shared/agent-accounts";
import type { ClaudeApiProfileDraft } from "../agent-accounts";
import { parseEnvLines, shortCodexWorkspaceId } from "../../shared/agent-accounts";
import * as accounts from "../agent-accounts";
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

export const agentAccountHandlers = {
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
