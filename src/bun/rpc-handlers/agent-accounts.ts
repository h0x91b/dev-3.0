/**
 * RPC handlers for the agent account switcher (multi-account per agent CLI,
 * hot-swap without re-login). Thin wrappers over src/bun/agent-accounts.ts.
 */

import type {
	AccountLoginState,
	AgentAccount,
	AgentAccountKind,
	AgentAccountsState,
	ClaudeSlotModels,
	PinnedClaudeLogin,
	ProjectClaudeLogin,
} from "../../shared/agent-accounts";
import type { ClaudeApiProfileDraft } from "../agent-accounts";
import { isAgentDirAccountKind, isAutoAccountId, isRoutableAccountKind, parseEnvLines, shortCodexWorkspaceId, type RoutableAccountKind } from "../../shared/agent-accounts";
import type { AutoAccountPreview } from "../../shared/account-routing";
import { previewAutoAccount as previewAutoAccountNow } from "../account-router";
import { loadSettings, saveSettings } from "../settings";
import { pinnedClaudeConfigDir } from "../../shared/claude-config-dir";
import * as accounts from "../agent-accounts";
import { ACCOUNT_LOGIN_SESSION_PREFIX, accountLogins } from "../account-login-terminal";
import { getPtyPort } from "../pty-server";
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
	const autoDefault = (await loadSettings()).autoAccountDefault;
	if (autoDefault?.claude) state.claude.autoDefault = true;
	if (autoDefault?.codex) state.codex.autoDefault = true;
	log.info("← listAgentAccounts", {
		claude: state.claude.accounts.length,
		omp: state.omp.accounts.length,
		pi: state.pi.accounts.length,
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
	if (isAgentDirAccountKind(params.kind)) throw new Error(`${params.kind} accounts are added with a fresh login, not imported`);
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

/** Start (or join) the in-app sign-in for `kind`. `remoteViewer`: the page asking is
 *  not on the host, so a host-side browser callback cannot reach the user. */
async function startAccountLogin(params: { kind: AgentAccountKind; remoteViewer: boolean }): Promise<AccountLoginState> {
	log.info("→ startAccountLogin", params);
	const state = await accountLogins.start(params.kind, { remoteViewer: params.remoteViewer });
	log.info("← startAccountLogin", { loginId: state.loginId.slice(0, 8), phase: state.phase });
	return state;
}

async function getAccountLogin(params: { kind: AgentAccountKind }): Promise<AccountLoginState | null> {
	return accountLogins.get(params.kind);
}

async function restartAccountLogin(params: { loginId: string; remoteViewer: boolean }): Promise<AccountLoginState> {
	log.info("→ restartAccountLogin", { loginId: params.loginId.slice(0, 8) });
	return accountLogins.restart(params.loginId, { remoteViewer: params.remoteViewer });
}

/** Loopback URL of a sign-in terminal; the browser transport swaps in its proxied `/pty`. */
async function getAccountLoginPtyUrl(params: { sessionKey: string }): Promise<string> {
	if (!params.sessionKey.startsWith(ACCOUNT_LOGIN_SESSION_PREFIX)) throw new Error("Not a sign-in terminal");
	return `ws://localhost:${getPtyPort()}?session=${encodeURIComponent(params.sessionKey)}`;
}

/** Cancel a sign-in in progress, or dismiss a finished one. */
async function closeAccountLogin(params: { loginId: string }): Promise<void> {
	log.info("→ closeAccountLogin", { loginId: params.loginId.slice(0, 8) });
	accountLogins.close(params.loginId);
}

async function setActiveAgentAccount(params: { kind: AgentAccountKind; accountId: string | null }): Promise<void> {
	log.info("→ setActiveAgentAccount", params);
	if (isAutoAccountId(params.accountId)) {
		if (!isRoutableAccountKind(params.kind)) throw new Error(`Auto is not available for ${params.kind} accounts`);
		await setAutoAccountDefault(params.kind, true);
		log.info("← setActiveAgentAccount done (auto)");
		return;
	}
	// Both kinds now accept null = "default to the system login" (~/.claude /
	// ~/.codex). Codex no longer swaps auth.json — this only moves the default.
	if (params.kind === "claude") {
		await accounts.setActiveClaudeAccount(params.accountId);
	} else if (isAgentDirAccountKind(params.kind)) {
		await accounts.setActiveAgentDirAccount(params.kind, params.accountId);
	} else {
		await accounts.setActiveCodexAccount(params.accountId);
	}
	if (isRoutableAccountKind(params.kind)) await setAutoAccountDefault(params.kind, false);
	log.info("← setActiveAgentAccount done");
}

/** Auto as the default lives in settings, not the registry, so an older build
 *  reading accounts.json still finds a specific, valid default. */
async function setAutoAccountDefault(kind: RoutableAccountKind, on: boolean): Promise<void> {
	const settings = await loadSettings();
	const current = settings.autoAccountDefault ?? {};
	if ((current[kind] === true) === on) return;
	const next = { ...current };
	if (on) next[kind] = true;
	else delete next[kind];
	await saveSettings({ ...settings, autoAccountDefault: Object.keys(next).length ? next : undefined });
}

/** What Auto would pick for a launch in this project right now. Reserves nothing. */
async function previewAutoAccount(params: { kind: AgentAccountKind; projectId?: string | null }): Promise<AutoAccountPreview | null> {
	if (!isRoutableAccountKind(params.kind)) return null;
	const project = params.projectId ? await data.getProject(params.projectId).catch(() => null) : null;
	return previewAutoAccountNow({ kind: params.kind, exclusions: project?.autoAccountExclusions ?? [] });
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
	startAccountLogin,
	getAccountLogin,
	restartAccountLogin,
	getAccountLoginPtyUrl,
	closeAccountLogin,
	setActiveAgentAccount,
	previewAutoAccount,
	removeAgentAccount,
	renameAgentAccount,
};
