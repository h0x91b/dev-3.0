import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PATHS } from "../electrobun-platform";
import type { AgentCheckResult, CodingAgent, ConfigSourceEntry, Dev3RepoConfig, GitHubCliStatus, GlobalSettings, Project, ProjectSettingsUpdate, RequirementCheckResult, RosettaWarningInfo } from "../../shared/types";
import * as data from "../data";
import * as agents from "../agents";
import * as github from "../github";
import * as updater from "../updater";
import * as rosetta from "../rosetta";
import * as repoConfig from "../repo-config";
import * as pty from "../pty-server";
import { tmux } from "../tmux";
import { loadSettings, saveSettings } from "../settings";
import { toggleFavorite } from "../../shared/favorites";
import { DEV3_HOME } from "../paths";
import { writeDev3SelfShim } from "../cli-self-install";
import { isFreshStartMode } from "../fresh-start";
import { spawn } from "../spawn";
import { setCurrentUiTheme } from "../theme-state";
import { getAllFeatureFlags, setFeatureFlags as cacheFeatureFlags } from "../feature-flags";
import { resolveAnalyticsDistinctId as resolveDistinctId } from "../analytics-identity";
import { extractConfigFromParams, getPushMessage, getSystemRequirements, log, resolveBinaryPath, setFocusMode } from "./shared";
import { binaryCandidatesOnPath, hasModelProviderSection, tmuxSearchPaths } from "./shared-pure";
import { agentBinaryPathOverride, isExecutableFile } from "../executable";
import { validateEnvMap } from "../../shared/env-text";

/** Reject malformed env maps at the RPC boundary — the UI validates too, but
 *  saves must not depend on the client being well-behaved. */
function assertValidEnvParam(env: unknown): void {
	const problems = validateEnvMap(env);
	if (problems.length > 0) throw new Error(`Invalid env config: ${problems.join("; ")}`);
}

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
	assertValidEnvParam(params.env);
	const project = await data.getProject(params.projectId);
	// Fields a .dev3 file already owns are written back to that file — writing them
	// to projects.json would leave the file shadowing them on the very next read.
	const configUpdates = project.kind === "virtual"
		? extractConfigFromParams(params)
		: await repoConfig.saveConfigToWinningLayer(project.path, extractConfigFromParams(params));
	const updates = {
		...configUpdates,
		...(params.githubAuthHost !== undefined ? { githubAuthHost: params.githubAuthHost } : {}),
		...(params.githubAuthLogin !== undefined ? { githubAuthLogin: params.githubAuthLogin } : {}),
		...(params.sensitive !== undefined ? { sensitive: params.sensitive } : {}),
		// A blank prompt is how the UI clears the override: dropped from the
		// record so the global setting takes over again.
		...(params.reviewModePrompt !== undefined
			? { reviewModePrompt: params.reviewModePrompt.trim() ? params.reviewModePrompt : undefined }
			: {}),
		...(params.coordinatorPrompt !== undefined
			? { coordinatorPrompt: params.coordinatorPrompt.trim() ? params.coordinatorPrompt : undefined }
			: {}),
	};
	const saved = await data.updateProject(params.projectId, updates);
	// Return the RESOLVED project: the caller renders what will actually run,
	// not a raw record a config file may override.
	const updated = saved.kind === "virtual" ? saved : await repoConfig.resolveProjectConfig(saved);
	getPushMessage()?.("projectUpdated", { project: updated });
	log.info("← updateProjectSettings done");
	return updated;
}

async function saveRepoConfig(params: { projectId: string; worktreePath?: string; autoCommit?: boolean } & Dev3RepoConfig): Promise<void> {
	log.info("→ saveRepoConfig", { projectId: params.projectId, worktreePath: params.worktreePath, autoCommit: params.autoCommit });
	assertValidEnvParam(params.env);
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
	assertValidEnvParam(params.env);
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
	// The renderer sends its whole snapshot, taken when it loaded. Anything the host
	// owns and the renderer never edits must survive that: the analytics identity was
	// minted after the snapshot was taken, so trusting the payload erased it on every
	// settings change and the install got a new id on every launch.
	const stored = await loadSettings();
	const next: GlobalSettings = { ...params, analyticsDistinctId: stored.analyticsDistinctId ?? params.analyticsDistinctId };
	await saveSettings(next);
	getPushMessage()?.("globalSettingsUpdated", next);
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

/**
 * Link this build's CLI to the frozen `~/.dev3.0/bin/dev3`, and arm a sibling
 * `dev3-self` aimed at THIS instance.
 *
 * The two halves answer different questions. `bin/dev3` decides which BINARY
 * every shell and every agent hook runs — unchanged behavior, and it must stay
 * instance-neutral. `dev3-self` decides which INSTANCE a human's shell reaches:
 * a dev build booted by this task's devScript owns its own dev-server, and a
 * freshly built CLI talking to the installed app is why new flags look broken.
 * See `writeDev3SelfShim` for why arming the second name — never `bin/dev3` —
 * is what keeps agent hooks out of a guest instance.
 */
async function installDev3Cli(): Promise<{ installedFrom: string; selfShimPath: string; selfInstance: string }> {
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
	// DEV3_TASK_ID is set only when this app instance was itself launched from a
	// task (a devScript dev build, or `dev3 remote` from an agent pane) — exactly
	// the "guest" case worth aiming at. The primary app arms `primary`, which is
	// honest and idempotent rather than a file that quietly means something else.
	const shim = writeDev3SelfShim(DEV3_HOME, source, process.env.DEV3_TASK_ID || null);
	log.info("← installDev3Cli", { from: source, to: cliDest, shim: shim.path, selector: shim.selector });
	return { installedFrom: source, selfShimPath: shim.path, selfInstance: shim.selector };
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
	// The merged list, not what the caller sent: built-in presets and user
	// overrides only exist merged, and every listener renders that view.
	getPushMessage()?.("agentsUpdated", await agents.getAllAgents());
	log.info("← saveAgents done");
}

async function checkForUpdate(): Promise<{ updateAvailable: boolean; version: string; error?: string }> {
	log.info("-> checkForUpdate");
	const settings = await loadSettings();
	const result = await updater.checkForUpdateWithChannel(settings.updateChannel);
	log.info("<- checkForUpdate", { ...result });
	return result;
}

/** True in the `dev3 remote` server, where the bundle-swap updater does not exist. */
function isHeadless(): boolean {
	return process.env.DEV3_HEADLESS === "1";
}

async function downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
	log.info("-> downloadUpdate");
	const settings = await loadSettings();
	// Headless has no bundle to download: the update is a brew upgrade or a CLI
	// tarball, and "download" means pre-fetching it while the server keeps serving.
	if (isHeadless()) {
		const { buildPlan, stageUpdate } = await import("../self-update");
		const { plan } = await buildPlan(settings.updateChannel);
		if (plan.kind === "refused") return { ok: false, error: plan.reason };
		if (plan.kind === "up-to-date") return { ok: true };
		getPushMessage()?.("updateDownloadProgress", { status: "downloading", progress: 0 });
		const staged = await stageUpdate(plan);
		getPushMessage()?.("updateDownloadProgress", { status: staged.ok ? "complete" : "error", progress: 100 });
		return staged.ok ? { ok: true } : { ok: false, error: staged.error };
	}
	const result = await updater.downloadUpdateForChannel(
		settings.updateChannel,
		(status, progress) => {
			getPushMessage()?.("updateDownloadProgress", { status, progress });
		},
	);
	log.info("<- downloadUpdate", result);
	return result;
}

async function applyUpdate(): Promise<{ restarting: boolean; message?: string }> {
	log.info("-> applyUpdate");
	if (isHeadless()) {
		const settings = await loadSettings();
		const { runSelfUpdate } = await import("../self-update");
		const outcome = await runSelfUpdate({ channel: settings.updateChannel, restart: true });
		// Throwing is how the renderer's Restart button reports a failure (it toasts
		// the message), and a refusal IS a failure from the button's point of view.
		if (!outcome.ok) throw new Error(outcome.message);
		// A SUCCESS THAT IS NOT A RESTART STILL HAS TO BE REPORTED. An interactive
		// `dev3 remote --no-detach` has no supervisor, so the update is installed and the
		// process stays alive — resolving silently left the button spinning "Restarting…"
		// with the sentence explaining the manual restart going nowhere.
		return { restarting: outcome.restarting, message: outcome.message };
	}
	await updater.applyUpdate();
	return { restarting: true };
}

/**
 * What the update popover needs to warn before restarting: whether this is a
 * headless box at all, and how many tasks are mid-flight right now.
 *
 * It is a WARNING, not a gate. A restart does not kill an agent — tmux sessions are
 * detached and lifecycles are rehydrated at boot — so the button stays enabled; the
 * count just lets someone on a phone decide to wait a minute.
 */
async function getUpdateRestartContext(): Promise<{ headless: boolean; tasksInProgress: number }> {
	const headless = isHeadless();
	let tasksInProgress = 0;
	try {
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			const tasks = await data.loadTasks(project);
			tasksInProgress += tasks.filter((task) => task.status === "in-progress").length;
		}
	} catch (err) {
		log.warn("getUpdateRestartContext: could not count in-progress tasks", { error: String(err) });
	}
	return { headless, tasksInProgress };
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
	// The app's shim is first in PATH, but a compatible client for a server
	// left by an older release may still exist later (for example Homebrew).
	// Keep every executable candidate so version selection can find that client.
	const pathCandidates = binaryCandidatesOnPath("tmux")
		.map((candidate) => tmux.dereferenceShim(candidate))
		.filter((candidate): candidate is string => Boolean(candidate));
	const fallbacks = [...pathCandidates, ...tmuxSearchPaths()];
	return tmux.selectBinary(preferred, fallbacks);
}

/**
 * Resolve and pin the tmux binary at app startup, before any poller talks to
 * the tmux server. Waiting for the renderer's checkSystemRequirements RPC
 * would leave early tmux calls on the bare PATH `tmux` — which may be a
 * version the running server rejects, or absent entirely (keg-only install).
 */
export async function resolveTmuxBinaryAtStartup(): Promise<string | undefined> {
	const settings = await loadSettings();
	const { resolvedPath } = resolveBinaryPath("tmux", settings.customBinaryPaths?.tmux, tmuxSearchPaths());
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
		// tmux ≥ 3.7 has a client busy-spin regression — prefer the bundled
		// self-contained tmux, then the vendored tmux@3.6 keg, over PATH
		// (see tmuxSearchPaths in shared-pure.ts and decisions/2026/07/16/bundle-tmux-macos.md).
		const vendored = req.id === "tmux" ? tmuxSearchPaths() : undefined;
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

async function getRosettaWarning(): Promise<RosettaWarningInfo> {
	const info = rosetta.getRosettaWarningInfo();
	if (info) {
		log.warn("Rosetta-translated x64 build on Apple Silicon detected", { kind: info.kind });
	}
	return info;
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
	if (params.requirementId === "tmux" && !(await tmux.probeVersion(path))) {
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
		// The user's own path always applies; a path cached for a previous base
		// command is stale, not an error — drop it.
		const overridePath = agentBinaryPathOverride(agent.id, agent.baseCommand, settings.agentBinaryPaths, settings.agentCustomBinaryPaths);
		const { resolvedPath, customPathError } = resolveBinaryPath(agent.baseCommand, overridePath);
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
	// Written to both maps: the custom one is what every launch reads, the cache
	// copy keeps an older app version on the same ~/.dev3.0 pointing at it too.
	await saveSettings({
		...settings,
		agentCustomBinaryPaths: { ...(settings.agentCustomBinaryPaths ?? {}), [params.agentId]: params.path },
		agentBinaryPaths: { ...(settings.agentBinaryPaths ?? {}), [params.agentId]: params.path },
	});
	log.info("<- setAgentBinaryPath saved");
}

/** Preflight for the Codex Bedrock backend: dev3 only routes codex at the
 *  provider via `-c model_provider=...`; the `[model_providers.amazon-bedrock]`
 *  section itself must exist in the user's ~/.codex/config.toml. */
async function checkCodexBedrockConfig(): Promise<{ configured: boolean }> {
	log.info("-> checkCodexBedrockConfig");
	try {
		const toml = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
		return { configured: hasModelProviderSection(toml, "amazon-bedrock") };
	} catch {
		return { configured: false };
	}
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

/**
 * Cache PostHog flag values evaluated by the renderer. Fire-and-forget: the hot
 * paths that read them (e.g. enqueuePtyData) do a synchronous cached lookup.
 */
async function setFeatureFlags(params: { flags: Record<string, boolean> }): Promise<void> {
	log.debug("→ setFeatureFlags", params.flags);
	cacheFeatureFlags(params.flags);
}

/** Read side for Debug -> Feature Flags: what bun actually gates code on. */
async function getFeatureFlags(): Promise<Record<string, boolean>> {
	return getAllFeatureFlags();
}

/** One distinct id per install; the desktop renderer's identity wins (see analytics-identity). */
async function resolveAnalyticsDistinctId(params: { seed?: string; authoritative?: boolean }): Promise<{ distinctId: string }> {
	return { distinctId: await resolveDistinctId(params?.seed, { authoritative: params?.authoritative }) };
}

export const settingsConfigHandlers = {
	getResolvedProject,
	setFeatureFlags,
	getFeatureFlags,
	resolveAnalyticsDistinctId,
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
	getUpdateRestartContext,
	saveLastRoute,
	getLastRoute,
	getAppVersion,
	checkSystemRequirements,
	getRosettaWarning,
	checkGhAvailable,
	setCustomBinaryPath,
	checkAgentAvailability,
	setAgentBinaryPath,
	checkCodexBedrockConfig,
	setTmuxTheme,
};
