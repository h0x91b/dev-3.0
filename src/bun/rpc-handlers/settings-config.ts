import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../electrobun-platform";
import type { AgentCheckResult, CodingAgent, ConfigSourceEntry, Dev3RepoConfig, GitHubCliStatus, GlobalSettings, Project, ProjectSettingsUpdate, RequirementCheckResult } from "../../shared/types";
import * as data from "../data";
import * as agents from "../agents";
import * as github from "../github";
import * as updater from "../updater";
import * as repoConfig from "../repo-config";
import * as pty from "../pty-server";
import { loadSettings, saveSettings } from "../settings";
import { toggleFavorite } from "../../shared/favorites";
import { DEV3_HOME } from "../paths";
import { isFreshStartMode } from "../fresh-start";
import { spawn } from "../spawn";
import { setCurrentUiTheme } from "../theme-state";
import { extractConfigFromParams, getPushMessage, getSystemRequirements, log, resolveBinaryPath, setFocusMode } from "./shared";
import { VENDORED_TMUX_PATHS } from "./shared-pure";
import { whichSync } from "../which";
import { isExecutableFile } from "../executable";

// `resolveOperationalProjectConfig` moved to ../repo-config (it depends only on
// resolveProjectConfig, so it belongs next to the config resolver and stays
// integration-testable without this module's heavy deps). Re-exported here so
// existing `./settings-config` importers keep working.
export { resolveOperationalProjectConfig } from "../repo-config";

async function getResolvedProject(params: { projectId: string; worktreePath: string }): Promise<Project> {
	log.debug("→ getResolvedProject", { projectId: params.projectId, worktreePath: params.worktreePath });
	const project = await data.getProject(params.projectId);
	const resolved = await repoConfig.resolveProjectConfig(project, params.worktreePath);
	log.debug("← getResolvedProject");
	return resolved;
}

async function getProjectConfigs(params: { projectId: string; worktreePath?: string }): Promise<{ repo: Dev3RepoConfig; local: Dev3RepoConfig }> {
	log.info("→ getProjectConfigs", { projectId: params.projectId, worktreePath: params.worktreePath });
	const project = await data.getProject(params.projectId);
	const configPath = params.worktreePath || project.path;
	const repo = repoConfig.loadRepoConfigRaw(configPath);
	const local = repoConfig.loadLocalConfigRaw(configPath);
	log.info("← getProjectConfigs");
	return { repo, local };
}

async function getProjectConfigFiles(params: { projectId: string }): Promise<{ hasRepoConfig: boolean; hasLocalConfig: boolean }> {
	const project = await data.getProject(params.projectId);
	return {
		hasRepoConfig: repoConfig.hasRepoConfig(project.path),
		hasLocalConfig: repoConfig.hasLocalConfig(project.path),
	};
}

async function updateProjectSettings(params: { projectId: string } & ProjectSettingsUpdate): Promise<Project> {
	log.info("→ updateProjectSettings", { projectId: params.projectId });
	const updates = {
		...extractConfigFromParams(params),
		...(params.githubAuthHost !== undefined ? { githubAuthHost: params.githubAuthHost } : {}),
		...(params.githubAuthLogin !== undefined ? { githubAuthLogin: params.githubAuthLogin } : {}),
	};
	const updated = await data.updateProject(params.projectId, updates);
	getPushMessage()?.("projectUpdated", { project: updated });
	log.info("← updateProjectSettings done");
	return updated;
}

async function saveRepoConfig(params: { projectId: string; worktreePath?: string; autoCommit?: boolean } & Dev3RepoConfig): Promise<void> {
	log.info("→ saveRepoConfig", { projectId: params.projectId, worktreePath: params.worktreePath, autoCommit: params.autoCommit });
	const project = await data.getProject(params.projectId);
	const configPath = params.worktreePath || project.path;
	const config = extractConfigFromParams(params) as Dev3RepoConfig;
	await repoConfig.saveRepoConfig(configPath, config);
	if (params.autoCommit && params.worktreePath) {
		try {
			const proc = spawn(["git", "-C", params.worktreePath, "add", ".dev3/config.json"]);
			const addCode = await proc.exited;
			if (addCode !== 0) throw new Error(`git add exited with code ${addCode}`);
			const commitProc = spawn(["git", "-C", params.worktreePath, "commit", "-m", "chore: update dev3 config"]);
			const commitCode = await commitProc.exited;
			if (commitCode !== 0) throw new Error(`git commit exited with code ${commitCode}`);
			log.info("Auto-committed .dev3/config.json", { worktreePath: params.worktreePath });
		} catch (err) {
			log.warn("Auto-commit failed (non-fatal)", { error: String(err) });
		}
	}
	log.info("← saveRepoConfig done");
}

async function saveLocalConfig(params: { projectId: string; worktreePath?: string } & Dev3RepoConfig): Promise<void> {
	log.info("→ saveLocalConfig", { projectId: params.projectId, worktreePath: params.worktreePath });
	const project = await data.getProject(params.projectId);
	const configPath = params.worktreePath || project.path;
	const config = extractConfigFromParams(params) as Dev3RepoConfig;
	await repoConfig.saveRepoLocalConfig(configPath, config);
	log.info("← saveLocalConfig done");
}

async function getRepoConfigSources(params: { projectId: string; worktreePath?: string }): Promise<ConfigSourceEntry[]> {
	log.info("→ getRepoConfigSources", { projectId: params.projectId, worktreePath: params.worktreePath });
	const project = await data.getProject(params.projectId);
	const configPath = params.worktreePath || project.path;
	const sources = await repoConfig.getConfigSources(configPath);
	log.info("← getRepoConfigSources", { count: sources.length });
	return sources;
}

async function getGlobalSettings(): Promise<GlobalSettings> {
	log.info("→ getGlobalSettings");
	const settings = await loadSettings();
	log.info("← getGlobalSettings", { settings });
	return settings;
}

async function getGitHubCliStatus(): Promise<GitHubCliStatus> {
	log.info("→ getGitHubCliStatus");
	const status = await github.getGitHubCliStatus();
	log.info("← getGitHubCliStatus", {
		authStatus: status.authStatus,
		accountCount: status.accounts.length,
		binaryPath: status.binaryPath,
	});
	return status;
}

async function saveGlobalSettings(params: GlobalSettings): Promise<void> {
	log.info("→ saveGlobalSettings", { params });
	// A JSON-RPC patch may omit optional `focusMode`; preserve the live gate in
	// that case instead of accidentally releasing queued agent notifications while
	// the user changes an unrelated setting.
	if (Object.prototype.hasOwnProperty.call(params, "focusMode")) {
		setFocusMode(params.focusMode === true);
	}
	await saveSettings(params);
	getPushMessage()?.("globalSettingsUpdated", params);
	log.info("← saveGlobalSettings done");
}

/** Add or remove an (agentId, configId) pair in the global favorites list,
 *  applying the cap + LFU-then-LRU eviction server-side (single source of truth),
 *  then persist. Returns the updated settings so the renderer can sync. */
async function toggleFavoriteAgent(params: { agentId: string; configId: string }): Promise<GlobalSettings> {
	log.info("→ toggleFavoriteAgent", { agentId: params.agentId, configId: params.configId });
	const settings = await loadSettings();
	const favorites = toggleFavorite(settings.favorites ?? [], params.agentId, params.configId, Date.now());
	const next: GlobalSettings = { ...settings, favorites };
	await saveSettings(next);
	log.info("← toggleFavoriteAgent", { count: favorites.length });
	return next;
}

async function installDev3Cli(): Promise<{ installedFrom: string }> {
	log.info("→ installDev3Cli");
	const cliBinDir = `${DEV3_HOME}/bin`;
	const cliDest = `${cliBinDir}/dev3`;
	const prodCli = join(PATHS.VIEWS_FOLDER, "..", "cli", "dev3");
	const devCli = join(import.meta.dir, "..", "cli", "dev3");
	const source = existsSync(prodCli) ? prodCli : devCli;
	if (!existsSync(source)) throw new Error(`CLI binary not found: ${source}`);
	mkdirSync(cliBinDir, { recursive: true });
	try { unlinkSync(cliDest); } catch {}
	symlinkSync(source, cliDest);
	chmodSync(cliDest, 0o755);
	log.info("← installDev3Cli", { from: source, to: cliDest });
	return { installedFrom: source };
}

async function getAgents(): Promise<CodingAgent[]> {
	log.info("→ getAgents");
	const all = await agents.getAllAgents();
	log.info(`← getAgents: ${all.length} agent(s)`);
	return all;
}

async function saveAgents(params: { agents: CodingAgent[] }): Promise<void> {
	log.info("→ saveAgents", { count: params.agents.length });
	await agents.saveAllAgents(params.agents);
	log.info("← saveAgents done");
}

async function checkForUpdate(): Promise<{ updateAvailable: boolean; version: string; error?: string }> {
	log.info("-> checkForUpdate");
	const settings = await loadSettings();
	const result = await updater.checkForUpdateWithChannel(settings.updateChannel);
	log.info("<- checkForUpdate", { ...result });
	return result;
}

async function downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
	log.info("-> downloadUpdate");
	const settings = await loadSettings();
	const result = await updater.downloadUpdateForChannel(
		settings.updateChannel,
		(status, progress) => {
			getPushMessage()?.("updateDownloadProgress", { status, progress });
		},
	);
	log.info("<- downloadUpdate", result);
	return result;
}

async function applyUpdate(): Promise<void> {
	log.info("-> applyUpdate");
	await updater.applyUpdate();
}

async function saveLastRoute({ route }: { route: string }): Promise<void> {
	log.info("-> saveLastRoute");
	// Fresh-start (dev) mode must not persist the route — it would clobber the
	// shared ~/.dev3.0/last-route.json that the real install restores from.
	if (isFreshStartMode()) return;
	await data.saveLastRoute(route);
}

async function getLastRoute(): Promise<{ route: string | null }> {
	log.info("-> getLastRoute");
	// In fresh-start (dev) mode always land on the dashboard — ignore any saved route.
	if (isFreshStartMode()) return { route: null };
	const route = await data.loadLastRoute();
	return { route };
}

async function getAppVersion(): Promise<{ version: string; channel: string; buildChannel: string }> {
	log.info("-> getAppVersion");
	const local = await updater.getLocalVersion();
	const settings = await loadSettings();
	const result = {
		version: local.version,
		channel: settings.updateChannel,
		buildChannel: local.channel,
	};
	log.info("<- getAppVersion", result);
	return result;
}

/**
 * Commit to a tmux binary: a live dev3 server started by a different tmux
 * version rejects our clients outright, so selectTmuxBinary probes for that
 * and may fall back (e.g. to the PATH tmux that started the server) until
 * the server restarts.
 */
async function commitTmuxBinary(preferred: string): Promise<string | undefined> {
	let pathTmux: string | null = null;
	try {
		pathTmux = whichSync("tmux");
	} catch {
		log.debug("which tmux failed while building fallback candidates");
	}
	// whichSync may hand us our own PATH shim (~/.dev3.0/bin is first in
	// PATH) — dereference it so we never probe or commit the shim itself.
	const pathTmuxReal = pathTmux ? pty.dereferenceTmuxShim(pathTmux) : undefined;
	const fallbacks = [pathTmuxReal ?? "", ...VENDORED_TMUX_PATHS].filter(Boolean);
	return pty.selectTmuxBinary(preferred, fallbacks);
}

/**
 * Resolve and pin the tmux binary at app startup, before any poller talks to
 * the tmux server. Waiting for the renderer's checkSystemRequirements RPC
 * would leave early tmux calls on the bare PATH `tmux` — which may be a
 * version the running server rejects, or absent entirely (keg-only install).
 */
export async function resolveTmuxBinaryAtStartup(): Promise<string | undefined> {
	const settings = await loadSettings();
	const { resolvedPath } = resolveBinaryPath("tmux", settings.customBinaryPaths?.tmux, VENDORED_TMUX_PATHS);
	if (!resolvedPath) {
		log.warn("startup tmux resolution: tmux not found anywhere");
		return undefined;
	}
	const chosen = await commitTmuxBinary(resolvedPath);
	log.info("startup tmux binary set to", { path: chosen });
	return chosen;
}

async function checkSystemRequirements(): Promise<RequirementCheckResult[]> {
	log.info("-> checkSystemRequirements", { PATH: process.env.PATH });
	const settings = await loadSettings();
	const results = getSystemRequirements().map((req) => {
		const customPath = settings.customBinaryPaths?.[req.id];
		// tmux ≥ 3.7 has a client busy-spin regression — prefer the vendored
		// tmux@3.6 keg over PATH (see VENDORED_TMUX_PATHS in shared-pure.ts).
		const vendored = req.id === "tmux" ? VENDORED_TMUX_PATHS : undefined;
		const { resolvedPath, customPathError } = resolveBinaryPath(req.id, customPath, vendored);

		if (resolvedPath) {
			log.info(`  ${req.id}: found`, { path: resolvedPath });
		} else {
			log.warn(`  ${req.id}: NOT found anywhere`);
		}

		return {
			...req,
			installed: !!resolvedPath,
			resolvedPath,
			customPathError,
		};
	});

	const tmuxResult = results.find((r) => r.id === "tmux");
	if (tmuxResult?.resolvedPath) {
		const chosen = await commitTmuxBinary(tmuxResult.resolvedPath);
		tmuxResult.resolvedPath = chosen;
		tmuxResult.installed = Boolean(chosen);
		if (!chosen && settings.customBinaryPaths?.tmux) tmuxResult.customPathError = true;
		log.info("tmux binary set to", { path: chosen });
	}

	log.info("<- checkSystemRequirements", { results: results.map((r) => `${r.id}:${r.installed}:${r.resolvedPath ?? "none"}`) });
	return results;
}

async function checkGhAvailable(): Promise<{ available: boolean; notInstalled: boolean }> {
	log.info("-> checkGhAvailable");
	const status = await github.getGitHubCliStatus();
	const available = status.authStatus === "authenticated";
	const notInstalled = status.authStatus === "not_installed";
	log.info("<- checkGhAvailable", { available, notInstalled });
	return { available, notInstalled };
}

async function setCustomBinaryPath(params: { requirementId: string; path: string }): Promise<{ ok: boolean }> {
	log.info("-> setCustomBinaryPath", params);
	const path = params.path.trim();
	const requirement = getSystemRequirements().find((candidate) => candidate.id === params.requirementId);
	if (!requirement || !isExecutableFile(path)) {
		log.warn("<- setCustomBinaryPath rejected non-executable path", { requirementId: params.requirementId, path });
		return { ok: false };
	}
	if (params.requirementId === "tmux" && !(await pty.probeTmuxVersion(path))) {
		log.warn("<- setCustomBinaryPath rejected path that is not tmux", { path });
		return { ok: false };
	}
	const settings = await loadSettings();
	const paths = { ...(settings.customBinaryPaths ?? {}), [params.requirementId]: path };
	await saveSettings({ ...settings, customBinaryPaths: paths });
	log.info("<- setCustomBinaryPath saved");
	return { ok: true };
}

async function checkAgentAvailability(): Promise<AgentCheckResult[]> {
	log.info("-> checkAgentAvailability");
	const settings = await loadSettings();
	const allAgents = await agents.getAllAgents();
	const results: AgentCheckResult[] = allAgents.map((agent) => {
		const customPath = settings.agentBinaryPaths?.[agent.id];
		const { resolvedPath, customPathError } = resolveBinaryPath(agent.baseCommand, customPath);
		log.info(`  agent ${agent.id} (${agent.baseCommand}): ${resolvedPath ? "found" : "NOT found"}`, { path: resolvedPath ?? "none" });
		return {
			agentId: agent.id,
			name: agent.name,
			baseCommand: agent.baseCommand,
			installed: !!resolvedPath,
			resolvedPath,
			installCommand: agent.installCommand,
			installUrl: agent.installUrl,
			customPathError,
		};
	});

	const pathsToSave: Record<string, string> = { ...(settings.agentBinaryPaths ?? {}) };
	let changed = false;
	for (const result of results) {
		if (result.resolvedPath && pathsToSave[result.agentId] !== result.resolvedPath) {
			pathsToSave[result.agentId] = result.resolvedPath;
			changed = true;
		}
	}
	if (changed) {
		saveSettings({ ...settings, agentBinaryPaths: pathsToSave }).catch((err) =>
			log.warn("Failed to auto-save agent binary paths", { error: String(err) }),
		);
	}

	log.info("<- checkAgentAvailability", { results: results.map((r) => `${r.agentId}:${r.installed}`) });
	return results;
}

async function setAgentBinaryPath(params: { agentId: string; path: string }): Promise<void> {
	log.info("-> setAgentBinaryPath", params);
	if (!existsSync(params.path)) {
		throw new Error(`File not found: ${params.path}`);
	}
	const settings = await loadSettings();
	const paths = settings.agentBinaryPaths ?? {};
	paths[params.agentId] = params.path;
	await saveSettings({ ...settings, agentBinaryPaths: paths });
	log.info("<- setAgentBinaryPath saved");
}

async function setTmuxTheme(params: { theme: "dark" | "light"; preference?: "dark" | "light" | "system" }): Promise<void> {
	log.info("→ setTmuxTheme", params);
	const settings = await loadSettings();
	await saveSettings({
		...settings,
		...(params.preference !== undefined ? { theme: params.preference } : {}),
		resolvedTheme: params.theme,
	});
	setCurrentUiTheme(params.theme);
	await pty.applyTmuxTheme(params.theme);
}

export const settingsConfigHandlers = {
	getResolvedProject,
	getProjectConfigs,
	getProjectConfigFiles,
	updateProjectSettings,
	saveRepoConfig,
	saveLocalConfig,
	getRepoConfigSources,
	getGlobalSettings,
	getGitHubCliStatus,
	saveGlobalSettings,
	toggleFavoriteAgent,
	installDev3Cli,
	getAgents,
	saveAgents,
	checkForUpdate,
	downloadUpdate,
	applyUpdate,
	saveLastRoute,
	getLastRoute,
	getAppVersion,
	checkSystemRequirements,
	checkGhAvailable,
	setCustomBinaryPath,
	checkAgentAvailability,
	setAgentBinaryPath,
	setTmuxTheme,
};
