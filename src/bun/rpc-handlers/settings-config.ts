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
import { DEV3_HOME } from "../paths";
import { spawn } from "../spawn";
import { setCurrentUiTheme } from "../theme-state";
import { extractConfigFromParams, getPushMessage, getSystemRequirements, log, resolveBinaryPath } from "./shared";

/**
 * Resolve config for runtime operational scripts.
 *
 * Prefers the project-level .dev3 config (avoids running stale scripts from older
 * task branches that carry a committed `.dev3/config.json` copy), but falls back
 * to the worktree-resolved value when the project-level script is empty/unset.
 * That fallback is important for new projects where `.dev3/config.json` lives
 * only in a feature branch/worktree before it is merged to the main branch.
 */
export async function resolveOperationalProjectConfig(project: Project, worktreePath?: string): Promise<Project> {
	const projectResolved = await repoConfig.resolveProjectConfig(project);
	if (!worktreePath || worktreePath === project.path) return projectResolved;

	const worktreeResolved = await repoConfig.resolveProjectConfig(project, worktreePath);
	const pickScript = (projectVal: string | undefined, worktreeVal: string | undefined): string => {
		if (projectVal && projectVal.trim() !== "") return projectVal;
		return worktreeVal ?? "";
	};

	return {
		...worktreeResolved,
		setupScript: pickScript(projectResolved.setupScript, worktreeResolved.setupScript),
		setupScriptLaunchMode: projectResolved.setupScriptLaunchMode ?? worktreeResolved.setupScriptLaunchMode ?? "parallel",
		devScript: pickScript(projectResolved.devScript, worktreeResolved.devScript),
		cleanupScript: pickScript(projectResolved.cleanupScript, worktreeResolved.cleanupScript),
	};
}

async function getResolvedProject(params: { projectId: string; worktreePath: string }): Promise<Project> {
	log.info("→ getResolvedProject", { projectId: params.projectId, worktreePath: params.worktreePath });
	const project = await data.getProject(params.projectId);
	const resolved = await repoConfig.resolveProjectConfig(project, params.worktreePath);
	log.info("← getResolvedProject");
	return resolved;
}

async function getProjectConfigs(params: { projectId: string; worktreePath?: string }): Promise<{ repo: Dev3RepoConfig; local: Dev3RepoConfig; app: Dev3RepoConfig }> {
	log.info("→ getProjectConfigs", { projectId: params.projectId, worktreePath: params.worktreePath });
	const project = await data.getProject(params.projectId);
	const configPath = params.worktreePath || project.path;
	const repo = repoConfig.loadRepoConfigRaw(configPath);
	const local = repoConfig.loadLocalConfigRaw(configPath);
	const app = repoConfig.loadAppConfig(project.path);
	log.info("← getProjectConfigs");
	return { repo, local, app };
}

async function getProjectConfigFiles(params: { projectId: string }): Promise<{ hasRepoConfig: boolean; hasLocalConfig: boolean }> {
	const project = await data.getProject(params.projectId);
	return {
		hasRepoConfig: repoConfig.hasRepoConfig(project.path),
		hasLocalConfig: repoConfig.hasLocalConfig(project.path),
	};
}

async function saveAppConfig(params: { projectId: string } & Dev3RepoConfig): Promise<void> {
	log.info("→ saveAppConfig", { projectId: params.projectId });
	const project = await data.getProject(params.projectId);
	const config = extractConfigFromParams(params) as Dev3RepoConfig;
	await repoConfig.saveAppConfig(project.path, config);
	log.info("← saveAppConfig done");
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
	const sources = await repoConfig.getConfigSources(configPath, project.path);
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
	await saveSettings(params);
	log.info("← saveGlobalSettings done");
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

async function saveUpdateRoute({ route }: { route: string }): Promise<void> {
	log.info("-> saveUpdateRoute");
	await data.saveUpdateRoute(route);
}

async function getUpdateRoute(): Promise<{ route: string | null }> {
	log.info("-> getUpdateRoute");
	const route = await data.loadAndClearUpdateRoute();
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

async function checkSystemRequirements(): Promise<RequirementCheckResult[]> {
	log.info("-> checkSystemRequirements", { PATH: process.env.PATH });
	const settings = await loadSettings();
	const results = getSystemRequirements().map((req) => {
		const customPath = settings.customBinaryPaths?.[req.id];
		const { resolvedPath, customPathError } = resolveBinaryPath(req.id, customPath);

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
		pty.setTmuxBinary(tmuxResult.resolvedPath);
		log.info("tmux binary set to", { path: tmuxResult.resolvedPath });
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

async function setCustomBinaryPath(params: { requirementId: string; path: string }): Promise<void> {
	log.info("-> setCustomBinaryPath", params);
	const settings = await loadSettings();
	const paths = settings.customBinaryPaths ?? {};
	paths[params.requirementId] = params.path;
	await saveSettings({ ...settings, customBinaryPaths: paths });
	log.info("<- setCustomBinaryPath saved");
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
	pty.applyTmuxTheme(params.theme);
}

export const settingsConfigHandlers = {
	getResolvedProject,
	getProjectConfigs,
	getProjectConfigFiles,
	saveAppConfig,
	updateProjectSettings,
	saveRepoConfig,
	saveLocalConfig,
	getRepoConfigSources,
	getGlobalSettings,
	getGitHubCliStatus,
	saveGlobalSettings,
	installDev3Cli,
	getAgents,
	saveAgents,
	checkForUpdate,
	downloadUpdate,
	applyUpdate,
	saveUpdateRoute,
	getUpdateRoute,
	getAppVersion,
	checkSystemRequirements,
	checkGhAvailable,
	setCustomBinaryPath,
	checkAgentAvailability,
	setAgentBinaryPath,
	setTmuxTheme,
};
