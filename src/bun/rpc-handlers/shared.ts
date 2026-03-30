import { existsSync } from "node:fs";
import { extname } from "node:path";
import { Utils } from "electrobun/bun";
import { dlopen, FFIType } from "bun:ffi";
import type { DiffToolId, RequirementCheckResult, Task, TaskStatus } from "../../shared/types";
import { ACTIVE_STATUSES, DEV3_REPO_CONFIG_KEYS, formatStatus, getTaskTitle } from "../../shared/types";
import { createLogger } from "../logger";
import { DEV3_HOME } from "../paths";
import { spawnSync } from "../spawn";
import { broadcastToOtherInstances } from "../instance-broadcast";

export const log = createLogger("rpc");

const rendererLog = createLogger("renderer");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let objcLib: any = null;

function getObjcLib() {
	if (!objcLib) {
		objcLib = dlopen("libobjc.A.dylib", {
			objc_getClass: { args: [FFIType.ptr], returns: FFIType.ptr },
			sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
			objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		});
	}
	return objcLib;
}

const encodeCStr = (s: string) => Buffer.from(s + "\0");

export function hideAppNative(): void {
	try {
		const objc = getObjcLib();
		const NSApplication = objc.symbols.objc_getClass(encodeCStr("NSApplication"));
		const sharedAppSel = objc.symbols.sel_registerName(encodeCStr("sharedApplication"));
		const hideSel = objc.symbols.sel_registerName(encodeCStr("hide:"));

		const app = objc.symbols.objc_msgSend(NSApplication, sharedAppSel);
		objc.symbols.objc_msgSend(app, hideSel);
	} catch (err) {
		log.error("hideAppNative FFI failed", { error: String(err) });
	}
}

export function logRendererError(params: { description: string; source: "error" | "unhandledrejection" }): void {
	rendererLog.warn(`[${params.source}] ${params.description}`);
}

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

const SYSTEM_REQUIREMENTS: RequirementCheckResult[] = [
	{ id: "git", name: "Git", installed: false, installHint: "requirements.installGit", installCommand: "xcode-select --install", brewInstallable: false },
	{ id: "tmux", name: "tmux", installed: false, installHint: "requirements.installTmux", installCommand: "brew install tmux", brewInstallable: true },
];

const FALLBACK_BIN_PATHS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/opt/homebrew/sbin",
	"/usr/local/sbin",
	...(process.env.HOME ? [`${process.env.HOME}/.local/bin`, `${process.env.HOME}/bin`] : []),
];

export const BUILT_IN_DIFF_TOOLS: Array<{
	id: DiffToolId;
	name: string;
	binaryName: string;
	extcmd: string;
}> = [
	{ id: "vscode", name: "VS Code", binaryName: "code", extcmd: "code --wait --diff" },
	{ id: "intellij", name: "IntelliJ IDEA", binaryName: "idea", extcmd: "idea diff" },
	{ id: "webstorm", name: "WebStorm", binaryName: "webstorm", extcmd: "webstorm diff" },
	{ id: "kaleidoscope", name: "Kaleidoscope", binaryName: "ksdiff", extcmd: "ksdiff" },
	{ id: "beyond-compare", name: "Beyond Compare", binaryName: "bcomp", extcmd: "bcomp" },
	{ id: "filemerge", name: "FileMerge", binaryName: "opendiff", extcmd: "opendiff" },
	{ id: "meld", name: "Meld", binaryName: "meld", extcmd: "meld" },
];

export function getSystemRequirements(): RequirementCheckResult[] {
	return SYSTEM_REQUIREMENTS.map((req) => ({ ...req }));
}

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
		const proc = spawnSync(["which", binaryName]);
		if (proc.exitCode === 0) {
			const whichOutput = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : "";
			resolvedPath = whichOutput || binaryName;
		}
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

export function notifyWatchedTaskStatusChange(task: Task, oldStatus: string, newStatus: string, projectName: string): void {
	if (!task.watched || oldStatus === newStatus) return;
	Utils.showNotification({
		title: `#${task.seq} ${getTaskTitle(task)}`,
		body: `${formatStatus(oldStatus)} → ${formatStatus(newStatus)}`,
		subtitle: projectName,
		silent: true,
	});
}

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/bmp": ".bmp",
	"image/svg+xml": ".svg",
};

export function getUploadedImageExtension(filename?: string, mimeType?: string): string {
	const fileExt = filename ? extname(filename).toLowerCase() : "";
	if (fileExt in {
		".png": true,
		".jpg": true,
		".jpeg": true,
		".gif": true,
		".webp": true,
		".bmp": true,
		".svg": true,
	}) {
		return fileExt;
	}

	if (mimeType) {
		return IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()] ?? ".png";
	}

	return ".png";
}
