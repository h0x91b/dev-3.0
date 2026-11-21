/**
 * The Claude folder a newly added project's agents will use, and whether it holds a login,
 * so the add flow can say so once (`decisions/2026/11/11/claude-folder-notice-at-project-add.md`).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { ACTIVE_STATUSES, type Project } from "../shared/types";
import type { ClaudeFolderNotice, ClaudeFolderSwitchImpact } from "../shared/claude-folder-notice";
import { expandAgentEnvDefault, withProjectClaudeConfigDir } from "../shared/agent-env-defaults";
import { launchClaudeConfigLocation, normalizeClaudeConfigDir, pinnedClaudeConfigDir } from "../shared/claude-config-dir";
import * as data from "./data";
import { claudeLoginKeptOutOfGit } from "./claude-config-git";
import { createLogger } from "./logger";
import { resolveProjectEnv } from "./repo-config";
import { loadSettings } from "./settings";
import { spawn } from "./spawn";

const log = createLogger("claude-folder-notice");

/**
 * The macOS Keychain service Claude Code stores a login under when `CLAUDE_CONFIG_DIR` is set:
 * the first 8 hex chars of sha256 over the variable's exact value, NFC-normalized
 * (read from Claude Code 2.1.322; the unpinned `~/.claude` login has no suffix).
 */
export function claudeKeychainService(configDirValue: string): string {
	const hash = createHash("sha256").update(configDirValue.normalize("NFC")).digest("hex").slice(0, 8);
	return `Claude Code-credentials-${hash}`;
}

/** The Keychain account Claude Code writes: `$USER`, or a fixed name when that is unsafe. */
export function claudeKeychainAccount(env: Record<string, string | undefined> = process.env): string {
	let name: string;
	try {
		name = env.USER || userInfo().username;
	} catch {
		return "claude-code-user";
	}
	return /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

/** True when the Keychain holds the item. No `-w`: the secret is never read, so no prompt. */
async function keychainHasItem(service: string): Promise<boolean> {
	try {
		const proc = spawn(["security", "find-generic-password", "-a", claudeKeychainAccount(), "-s", service], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return (await proc.exited) === 0;
	} catch (err) {
		log.warn("Keychain lookup failed", { error: String(err) });
		return false;
	}
}

export interface LoginProbe {
	platform: string;
	fileExists: (file: string) => boolean;
	keychainHasItem: (service: string) => Promise<boolean>;
	loginKeptOutOfGit: (dir: string) => boolean;
}

const realProbe: LoginProbe = {
	platform: process.platform,
	fileExists: existsSync,
	keychainHasItem,
	loginKeptOutOfGit: (dir) => claudeLoginKeptOutOfGit(dir),
};

/**
 * Whether Claude Code has a login for `dir`, reached through the `CLAUDE_CONFIG_DIR` value the
 * launch exports. A `.credentials.json` counts on every OS: macOS falls back to it too.
 */
export async function claudeFolderHasLogin(dir: string, configDirValue: string, probe: LoginProbe = realProbe): Promise<boolean> {
	if (probe.fileExists(join(dir, ".credentials.json"))) return true;
	return probe.platform === "darwin" && (await probe.keychainHasItem(claudeKeychainService(configDirValue)));
}

/** What to tell the user about `project`'s Claude folder, or null when its agents use `~/.claude`. Never throws. */
export async function claudeFolderNotice(project: Project, probe: LoginProbe = realProbe): Promise<ClaudeFolderNotice | null> {
	try {
		if (project.kind === "virtual") return null;
		const home = homedir();
		const env = await resolveProjectEnv(project);
		const value = env.CLAUDE_CONFIG_DIR;
		const dir = pinnedClaudeConfigDir(value, home, project.path);
		if (dir && value !== undefined) {
			// Off macOS the launch drops any pin, the project's own included, whose login git would show.
			if (probe.platform !== "darwin" && !probe.loginKeptOutOfGit(dir)) return { state: "refused", dir };
			return { state: (await claudeFolderHasLogin(dir, value, probe)) ? "ready" : "no-login", dir };
		}
		if ("CLAUDE_CONFIG_DIR" in env) return null;
		// No key at all although the global default names a project folder: the default was refused.
		const fallback = (await loadSettings()).agentEnvDefaults?.CLAUDE_CONFIG_DIR;
		if (!fallback?.includes("{projectPath}")) return null;
		const refusedDir = normalizeClaudeConfigDir(expandAgentEnvDefault(fallback, project, home), home, project.path);
		return refusedDir ? { state: "refused", dir: refusedDir } : null;
	} catch (err) {
		log.warn("Could not work out the project's Claude folder (non-fatal)", { projectId: project.id, error: String(err) });
		return null;
	}
}

/** What turning the switch to `enabled` does to tasks that are already running or waiting. Never throws. */
export async function claudeFolderSwitchImpact(enabled: boolean): Promise<ClaudeFolderSwitchImpact> {
	const impact: ClaudeFolderSwitchImpact = { taskCount: 0, projectNames: [] };
	const current = (await loadSettings()).agentEnvDefaults;
	const next = withProjectClaudeConfigDir(current, enabled);
	const home = homedir();
	for (const project of await data.loadProjects()) {
		try {
			const before = await resolveProjectEnv(project);
			const after = await resolveProjectEnv(project, null, { agentEnvDefaults: next });
			if (launchClaudeConfigLocation(before, process.env, home, project.path).dir === launchClaudeConfigLocation(after, process.env, home, project.path).dir) continue;
			const active = (await data.loadTasks(project)).filter((task) => ACTIVE_STATUSES.includes(task.status)).length;
			if (active === 0) continue;
			impact.taskCount += active;
			impact.projectNames.push(project.name);
		} catch (err) {
			log.warn("Could not check a project for the Claude folder switch (non-fatal)", { projectId: project.id, error: String(err) });
		}
	}
	return impact;
}
