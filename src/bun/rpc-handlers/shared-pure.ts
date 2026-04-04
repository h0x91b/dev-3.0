/**
 * Pure helper functions with no electrobun or bun:ffi dependencies.
 * Split from shared.ts so that modules like tmux-pty.ts can be imported
 * in standalone bun scripts (e.g. e2e tests) without triggering native deps.
 */
import { existsSync } from "node:fs";
import type { TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, DEV3_REPO_CONFIG_KEYS } from "../../shared/types";
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

export function buildEnvExports(env: Record<string, string>): string[] {
	return Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
}

export function buildCmdScript(
	tmuxCmd: string,
	env?: Record<string, string>,
	options?: { paneTitle?: string; keepShell?: boolean; onExitCommand?: string },
): string {
	const escaped = escapeForDoubleQuotes(tmuxCmd);
	const exportLines = env && Object.keys(env).length > 0 ? buildEnvExports(env) : [];
	const safePaneTitle = options?.paneTitle?.replace(/'/g, "") ?? "";
	const titleLine = safePaneTitle ? `printf '\\033]2;${safePaneTitle}\\033\\\\'` : "";
	const onExitLines = options?.onExitCommand ? [options.onExitCommand] : [];
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
			`exec "\${SHELL:-bash}"`,
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
		"  exec bash",
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

export function resolveBinaryPath(binaryName: string, customPath?: string): { resolvedPath?: string; customPathError: boolean } {
	let resolvedPath: string | undefined;
	let customPathError = false;

	if (customPath) {
		if (existsSync(customPath)) {
			resolvedPath = customPath;
		} else {
			customPathError = true;
		}
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
