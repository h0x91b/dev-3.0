/**
 * The Claude folder a newly added project's agents will use, and whether it holds a login,
 * so the add flow can say so once (`decisions/2026/11/11/claude-folder-notice-at-project-add.md`).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Project } from "../shared/types";
import type { ClaudeFolderNotice } from "../shared/claude-folder-notice";
import { expandAgentEnvDefault } from "../shared/agent-env-defaults";
import { normalizeClaudeConfigDir, pinnedClaudeConfigDir } from "../shared/claude-config-dir";
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
}

const realProbe: LoginProbe = { platform: process.platform, fileExists: existsSync, keychainHasItem };

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

