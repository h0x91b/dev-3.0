/**
 * Pure helper functions with no electrobun or bun:ffi dependencies.
 * Split from shared.ts so that modules like tmux-pty.ts can be imported
 * in standalone bun scripts (e.g. e2e tests) without triggering native deps.
 */
import { existsSync } from "node:fs";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, DEV3_REPO_CONFIG_KEYS } from "../../shared/types";
import { ENV_UNSET } from "../../shared/agent-accounts";
import { createLogger } from "../logger";
import { DEV3_HOME } from "../paths";
import { broadcastToOtherInstances } from "../instance-broadcast";
import { whichSync } from "../which";

export const log = createLogger("rpc");

export function escapeForDoubleQuotes(s: string): string {
	return s.replace(/[\\"$`!]/g, "\\$&");
}

export function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function getScriptShellPath(shellPath?: string): string {
	return shellPath?.trim() || process.env.SHELL || "/bin/zsh";
}

export function buildScriptRunnerCommand(
	scriptPath: string,
	options?: { shellPath?: string; trace?: boolean },
): string {
	const parts = [shellQuote(getScriptShellPath(options?.shellPath))];
	if (options?.trace) {
		parts.push("-x");
	}
	parts.push(shellQuote(scriptPath));
	return parts.join(" ");
}

export function buildEnvExports(env: Record<string, string>): string[] {
	// ENV_UNSET marks a variable for active removal (agent account switcher):
	// the launched shell inherits the long-lived tmux server env, so a stale
	// value must be `unset`, not merely left out of the exports.
	return Object.entries(env).map(([key, value]) => (value === ENV_UNSET ? `unset ${key}` : `export ${key}=${shellQuote(value)}`));
}

/**
 * Emit a shell-portable "read a single keypress silently" snippet.
 *
 * The setup/startup wrapper scripts carry a `#!/bin/bash` shebang but are
 * executed via the user's login shell (`buildScriptRunnerCommand` → `zsh script`,
 * shebang ignored). bash-only `read -n 1 -s` then breaks under zsh with
 * "not an identifier: -s", because zsh spells "read N chars" as `-k N` (not `-n N`).
 * Branch on `$ZSH_VERSION` so the snippet works under both shells.
 */
export function portableReadKey(options?: { timeoutSeconds?: number }): string {
	const t = options?.timeoutSeconds;
	const timeout = typeof t === "number" ? `-t ${t} ` : "";
	return `if [ -n "$ZSH_VERSION" ]; then read ${timeout}-k 1 -s; else read ${timeout}-n 1 -s; fi`;
}

export function buildCmdScript(
	tmuxCmd: string,
	env?: Record<string, string>,
	options?: { paneTitle?: string; keepShell?: boolean; onExitCommand?: string; shellPath?: string },
): string {
	const escaped = escapeForDoubleQuotes(tmuxCmd);
	const exportLines = env && Object.keys(env).length > 0 ? buildEnvExports(env) : [];
	const safePaneTitle = options?.paneTitle?.replace(/'/g, "") ?? "";
	const titleLine = safePaneTitle ? `printf '\\033]2;${safePaneTitle}\\033\\\\'` : "";
	const onExitLines = options?.onExitCommand ? [options.onExitCommand] : [];
	const shellPath = getScriptShellPath(options?.shellPath);
	if (options?.keepShell) {
		return [
			"#!/bin/bash",
			...(titleLine ? [titleLine] : []),
			...exportLines,
			`echo "Starting: ${escaped}" && ${tmuxCmd}`,
			"__EC=$?",
			"if [ $__EC -ne 0 ]; then",
			`  printf '\\n\\033[1;31m✗ Process exited with code %s\\033[0m\\n' "$__EC"`,
			"else",
			`  printf '\\n\\033[2mAgent session ended (exit 0). You are in the worktree shell.\\033[0m\\n'`,
			...onExitLines,
			"fi",
			`exec ${shellQuote(shellPath)}`,
			"",
		].join("\n");
	}
	return [
		"#!/bin/bash",
		...(titleLine ? [titleLine] : []),
		...exportLines,
		`echo "Starting: ${escaped}" && ${tmuxCmd}`,
		"__EC=$?",
		"if [ $__EC -ne 0 ]; then",
		`  printf '\\n\\033[1;31m✗ Process exited with code %s\\033[0m\\n' "$__EC"`,
		`  exec ${shellQuote(shellPath)}`,
		...(onExitLines.length > 0 ? ["else", ...onExitLines] : []),
		"fi",
		"",
	].join("\n");
}

const FALLBACK_BIN_PATHS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/opt/homebrew/sbin",
	"/usr/local/sbin",
	...(process.env.HOME ? [`${process.env.HOME}/.local/bin`, `${process.env.HOME}/bin`] : []),
];

/**
 * Known-good tmux kegs vendored via the h0x91b/dev3 Homebrew tap.
 *
 * tmux 3.7 regressed: its client busy-spins at 100% CPU on a congested server
 * socket (imsg flush loop) instead of waiting for writability, which cascades
 * into 10-35s UI freezes when several dev3 instances share one machine. The
 * dev3 cask/formula therefore depend on the keg-only `h0x91b/dev3/tmux@3.6`,
 * and the app prefers that keg over whatever `tmux` happens to be in PATH.
 * A user-configured custom path still wins over these.
 */
export const VENDORED_TMUX_PATHS = [
	"/opt/homebrew/opt/tmux@3.6/bin/tmux",
	"/usr/local/opt/tmux@3.6/bin/tmux",
	"/home/linuxbrew/.linuxbrew/opt/tmux@3.6/bin/tmux",
];

export function resolveBinaryPath(
	binaryName: string,
	customPath?: string,
	vendoredPaths?: string[],
): { resolvedPath?: string; customPathError: boolean } {
	let resolvedPath: string | undefined;
	let customPathError = false;

	if (customPath) {
		if (existsSync(customPath)) {
			resolvedPath = customPath;
		} else {
			customPathError = true;
		}
	}

	if (!resolvedPath && vendoredPaths) {
		resolvedPath = vendoredPaths.find((p) => existsSync(p));
	}

	if (!resolvedPath) {
		resolvedPath = whichSync(binaryName) ?? undefined;
	}

	if (!resolvedPath) {
		for (const dir of FALLBACK_BIN_PATHS) {
			const candidate = `${dir}/${binaryName}`;
			if (existsSync(candidate)) {
				resolvedPath = candidate;
				if (!process.env.PATH?.split(":").includes(dir)) {
					process.env.PATH = `${dir}:${process.env.PATH}`;
				}
				break;
			}
		}
	}

	return { resolvedPath, customPathError };
}

let pushMessageRaw: ((name: string, payload: any) => void) | null = null;
let pushMessage: ((name: string, payload: any) => void) | null = null;

export function setPushMessage(fn: (name: string, payload: any) => void): void {
	pushMessageRaw = fn;
	pushMessage = (name, payload) => {
		fn(name, payload);
		if (name === "taskUpdated" || name === "projectUpdated") {
			const params: Record<string, string> = { event: name };
			if (payload.projectId) params.projectId = payload.projectId;
			if (payload.project?.id) params.projectId = payload.project.id;
			if (payload.task?.id) params.taskId = payload.task.id;
			broadcastToOtherInstances(name, params);
		}
	};
}

export function getPushMessage(): ((name: string, payload: any) => void) | null {
	return pushMessage;
}

export function getPushMessageLocal(): ((name: string, payload: any) => void) | null {
	return pushMessageRaw;
}

export function isActive(status: TaskStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

export function buildAgentEnv(extraEnv: Record<string, string>, taskId: string): Record<string, string> {
	const dev3Bin = `${DEV3_HOME}/bin`;
	const currentPath = process.env.PATH || "";
	const pathWithDev3 = currentPath.includes(dev3Bin) ? currentPath : `${dev3Bin}:${currentPath}`;
	return { ...extraEnv, DEV3_TASK_ID: taskId, PATH: pathWithDev3 };
}

/**
 * Workspace env vars injected into every project hook (setup script, dev
 * script, cleanup script) and into agent sessions.
 *
 * `DEV3_PROJECT_PATH` is the load-bearing one for git-ignored hooks: a
 * `.dev3/config.local.json` lives only at the project root (a fresh worktree
 * checkout has no copy), so any script it references must be resolved from
 * the root — `"bash \"$DEV3_PROJECT_PATH/.dev3/setup.sh\""` — while the cwd
 * stays the worktree. This mirrors the Superset workspace-hook contract
 * (SUPERSET_ROOT_PATH / SUPERSET_WORKSPACE_NAME / SUPERSET_WORKSPACE_PATH),
 * which lets tooling such as the b44 CLI target both runners with the same
 * per-worktree setup/teardown scripts.
 *
 * `branchName` wins over `task.branchName` because at first launch the task
 * record is persisted only after the PTY starts — callers that just created
 * the worktree pass the fresh branch name explicitly.
 */
export function buildTaskLifecycleEnv(
	project: Project,
	task: Task,
	worktreePath: string,
	branchName?: string | null,
): Record<string, string> {
	return {
		DEV3_PROJECT_PATH: project.path,
		DEV3_PROJECT_NAME: project.name,
		DEV3_TASK_ID: task.id,
		DEV3_TASK_TITLE: task.title,
		DEV3_WORKTREE_PATH: worktreePath,
		DEV3_BRANCH_NAME: branchName ?? task.branchName ?? "",
	};
}

export function extractConfigFromParams(params: Record<string, any>): Record<string, any> {
	const config: Record<string, any> = {};
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		const val = params[key];
		if (val !== undefined) {
			config[key] = val;
		}
	}
	return config;
}
