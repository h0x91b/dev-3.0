import { existsSync, readdirSync, statSync, mkdirSync, unlinkSync, symlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PATHS, Utils } from "electrobun/bun";
import type { AgentCheckResult, BranchStatus, ChangelogEntry, CodingAgent, ColumnAgentConfig, ConfigSourceEntry, CustomColumn, Dev3RepoConfig, ExternalApp, GlobalSettings, Label, NoteSource, PortInfo, PRInfo, Project, RequirementCheckResult, Task, TaskNote, TaskStatus, TipState, TmuxSessionInfo } from "../shared/types";
import { ACTIVE_STATUSES, DEFAULT_REVIEW_PROMPT, DEFAULT_EXTERNAL_APPS, DEV3_REPO_CONFIG_KEYS, LABEL_COLORS, titleFromDescription, extractRepoName } from "../shared/types";
import * as data from "./data";
import * as git from "./git";
import * as pty from "./pty-server";
import * as agents from "./agents";
import * as updater from "./updater";
import { loadSettings, loadSettingsSync, saveSettings } from "./settings";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { spawn, spawnSync } from "./spawn";
import { getPortsForTask } from "./port-scanner";
import { dlopen, FFIType } from "bun:ffi";
import { clonePaths } from "./cow-clone";
import { setupAgentHooks } from "./agent-hooks";
import { BUNDLED_CHANGELOG } from "./changelog-bundled";
import * as repoConfig from "./repo-config";

const log = createLogger("rpc");

/**
 * Lazy-initialized Objective-C runtime FFI handle.
 * Opened once on first use; libobjc is always loaded in any macOS process
 * so there's no need to close the handle.
 */
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

/** Encode a string as a null-terminated buffer for FFI. */
const encodeCStr = (s: string) => Buffer.from(s + "\0");

/**
 * Hide the app by calling [NSApp hide:nil] via Objective-C runtime FFI.
 * No permissions required — the app hides itself.
 */
function hideAppNative(): void {
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

/**
 * Escape a string for safe use inside a double-quoted shell context.
 * Handles: ", $, `, \, !
 */
export function escapeForDoubleQuotes(s: string): string {
	return s.replace(/[\\"$`!]/g, "\\$&");
}

/** Single-quote a value for safe use in shell `export` statements. */
export function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build `export KEY='value'` lines for a set of environment variables.
 * These are placed at the top of wrapper scripts so that the agent command
 * running inside a shared tmux server always sees the correct env vars,
 * regardless of when the server was originally started.
 */
export function buildEnvExports(env: Record<string, string>): string[] {
	return Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
}

/**
 * Build a bash script that echoes the command and then exec's it.
 * Used when a setup script is present and the main command runs in a split pane.
 *
 * When `env` is provided, `export` statements are written before the command
 * so the process sees config-level environment variables even when the tmux
 * server was started by a different task.
 */
export function buildCmdScript(tmuxCmd: string, env?: Record<string, string>, options?: { paneTitle?: string; keepShell?: boolean; onExitCommand?: string }): string {
	const escaped = escapeForDoubleQuotes(tmuxCmd);
	const exportLines = env && Object.keys(env).length > 0 ? buildEnvExports(env) : [];
	// Strip single quotes to prevent shell injection — paneTitle is embedded inside single-quoted printf.
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

const SYSTEM_REQUIREMENTS = [
	{ id: "git", name: "Git", checkCommand: "git", installHint: "requirements.installGit", installCommand: "xcode-select --install", brewInstallable: false },
	{ id: "tmux", name: "tmux", checkCommand: "tmux", installHint: "requirements.installTmux", installCommand: "brew install tmux", brewInstallable: true },
];

// Common paths where package managers install binaries
const FALLBACK_BIN_PATHS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/opt/homebrew/sbin",
	"/usr/local/sbin",
	// User-local dirs (pip, pipx, Claude CLI, etc.)
	...(process.env.HOME ? [`${process.env.HOME}/.local/bin`, `${process.env.HOME}/bin`] : []),
];

/**
 * Resolve a binary path using 3-step strategy:
 * 1. Custom path from settings (if provided)
 * 2. `which` (uses current PATH)
 * 3. Fallback: common Homebrew / user-local paths
 */
export function resolveBinaryPath(binaryName: string, customPath?: string): { resolvedPath?: string; customPathError: boolean } {
	let resolvedPath: string | undefined;
	let customPathError = false;

	// 1. Check custom path
	if (customPath) {
		if (existsSync(customPath)) {
			resolvedPath = customPath;
		} else {
			customPathError = true;
		}
	}

	// 2. Try `which`
	if (!resolvedPath) {
		const proc = spawnSync(["which", binaryName]);
		if (proc.exitCode === 0) {
			const whichOutput = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : "";
			resolvedPath = whichOutput || binaryName;
		}
	}

	// 3. Fallback: check common paths
	if (!resolvedPath) {
		for (const dir of FALLBACK_BIN_PATHS) {
			const candidate = `${dir}/${binaryName}`;
			if (existsSync(candidate)) {
				resolvedPath = candidate;
				if (!process.env.PATH?.includes(dir)) {
					process.env.PATH = `${dir}:${process.env.PATH}`;
				}
				break;
			}
		}
	}

	return { resolvedPath, customPathError };
}

// Will be set by index.ts after window creation
let pushMessage: ((name: string, payload: any) => void) | null = null;

function devServerSessionName(taskId: string): string {
	return `dev3-dev-${taskId.slice(0, 8)}`;
}

async function isDevServerRunning(taskId: string, socket: string): Promise<boolean> {
	const devSession = devServerSessionName(taskId);
	const check = spawn(pty.tmuxArgs(socket, "has-session", "-t", devSession), { stdout: "pipe", stderr: "pipe" });
	const exitCode = await check.exited;
	return exitCode === 0;
}

// Track viewer pane IDs for dev server sessions (task ID → tmux pane ID).
// Used to kill the viewer pane before the dev session so the trap EXIT in the
// viewer pane shell cannot fire after the new session is already running (restart race).
const devViewerPaneIds = new Map<string, string>();

async function killDevServerViewerPane(taskId: string, taskSession: string, devSession: string, socket: string): Promise<void> {
	// First try in-memory map (fast, always available unless app restarted)
	let viewerPaneId = devViewerPaneIds.get(taskId);
	if (!viewerPaneId) {
		// Fallback: scan the task session for a pane running attach-session to our dev session.
		// This handles app restarts where the map was lost.
		const listProc = spawn(pty.tmuxArgs(socket,
			"list-panes", "-t", taskSession,
			"-F", "#{pane_id} #{pane_start_command}",
		), { stdout: "pipe", stderr: "pipe" });
		const listOutput = await new Response(listProc.stdout).text();
		await listProc.exited;
		for (const line of listOutput.trim().split("\n")) {
			if (line.includes(devSession)) {
				viewerPaneId = line.split(" ")[0];
				break;
			}
		}
	}
	if (viewerPaneId) {
		const killPane = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", viewerPaneId), { stdout: "pipe", stderr: "pipe" });
		await killPane.exited;
		devViewerPaneIds.delete(taskId);
		log.info("Killed dev server viewer pane", { taskId: taskId.slice(0, 8), viewerPaneId });
	}
}

async function killDevServerSession(taskId: string, socket: string): Promise<void> {
	const devSession = devServerSessionName(taskId);
	const taskSession = `dev3-${taskId.slice(0, 8)}`;
	// Kill the viewer pane first so its trap EXIT cannot fire on the new session.
	await killDevServerViewerPane(taskId, taskSession, devSession, socket);
	const kill = spawn(pty.tmuxArgs(socket, "kill-session", "-t", devSession), { stdout: "pipe", stderr: "pipe" });
	await kill.exited;
	log.info("Killed dev server session", { taskId: taskId.slice(0, 8), devSession });
}
// Track file browser (yazi) tmux pane IDs per task
const fileBrowserPaneIds = new Map<string, string>();

// Track git operation tmux pane IDs per task
const gitOpPaneIds = new Map<string, string>();

// Track tasks whose merge was already detected (avoid repeated popups)
const mergeNotifiedTasks = new Set<string>();

// Dedup in-flight getBranchStatus requests per task to prevent stampedes
const branchStatusInFlight = new Map<string, Promise<{
	ahead: number; behind: number; canRebase: boolean;
	insertions: number; deletions: number; unpushed: number; mergedByContent: boolean;
	diffFiles: number; diffInsertions: number; diffDeletions: number; diffFileNames: string[];
	prNumber: number | null;
}>>();

/** Build the env object for a task's wrapper script, ensuring dev3 binary is on PATH. */
function buildAgentEnv(extraEnv: Record<string, string>, taskId: string): Record<string, string> {
	const dev3Bin = `${DEV3_HOME}/bin`;
	const currentPath = process.env.PATH || "";
	const pathWithDev3 = currentPath.includes(dev3Bin) ? currentPath : `${dev3Bin}:${currentPath}`;
	return { ...extraEnv, DEV3_TASK_ID: taskId, PATH: pathWithDev3 };
}

async function killExistingGitPane(taskId: string, tmuxSession: string, socket: string): Promise<void> {
	const existingPane = gitOpPaneIds.get(taskId);
	if (existingPane) {
		const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", existingPane));
		await kill.exited;
		gitOpPaneIds.delete(taskId);
		log.info("Killed existing git op pane (from map)", { taskId: taskId.slice(0, 8), paneId: existingPane });
	} else {
		// Fallback: find panes running git op scripts for this task
		const listProc = spawn(pty.tmuxArgs(socket,
			"list-panes", "-t", tmuxSession,
			"-F", "#{pane_id} #{pane_start_command}",
		), { stdout: "pipe", stderr: "pipe" });
		const listOutput = await new Response(listProc.stdout).text();
		await listProc.exited;
		for (const line of listOutput.trim().split("\n")) {
			if (line.includes(`dev3-${taskId}-git-`)) {
				const paneId = line.split(" ")[0];
				const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", paneId));
				await kill.exited;
				log.info("Killed existing git op pane (from tmux scan)", { taskId: taskId.slice(0, 8), paneId });
			}
		}
	}
}

async function openGitOpPane(tmuxSession: string, cwd: string, scriptPath: string, socket: string): Promise<string | null> {
	const proc = spawn(pty.tmuxArgs(socket,
		"split-window", "-v", "-l", "20%",
		"-t", tmuxSession,
		"-c", cwd,
		"-P", "-F", "#{pane_id}",
		`bash "${scriptPath}"`,
	), { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(proc.stdout).text();
	const stderrOutput = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (stderrOutput.trim()) {
		log.warn("openGitOpPane tmux stderr", { stderr: stderrOutput.trim() });
	}
	if (exitCode !== 0) {
		throw new Error(`tmux split-window failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
	}

	return output.trim() || null;
}

function monitorGitPane(paneId: string | null, taskId: string, projectId: string, operation: string, socket: string): void {
	if (!paneId) return;
	const tmuxSession = `dev3-${taskId.slice(0, 8)}`;
	const exitFilePath = `/tmp/dev3-${taskId}-git-${operation}.sh.exit`;

	let interval: ReturnType<typeof setInterval> | undefined;
	let safetyTimeout: ReturnType<typeof setTimeout> | undefined;

	function cleanup() {
		if (interval !== undefined) clearInterval(interval);
		if (safetyTimeout !== undefined) clearTimeout(safetyTimeout);
		interval = undefined;
		safetyTimeout = undefined;
	}

	try {
		interval = setInterval(async () => {
			try {
				// List all pane IDs in the session and check if ours is still there
				const listProc = spawn(pty.tmuxArgs(socket,
					"list-panes", "-t", tmuxSession, "-F", "#{pane_id}",
				), { stdout: "pipe", stderr: "pipe" });
				const output = await new Response(listProc.stdout).text();
				await listProc.exited;

				const paneStillExists = output.trim().split("\n").includes(paneId);

				if (!paneStillExists) {
					// Pane no longer exists — operation finished
					cleanup();
					gitOpPaneIds.delete(taskId);

					let ok = false;
					try {
						const exitCodeStr = await Bun.file(exitFilePath).text();
						ok = exitCodeStr.trim() === "0";
					} catch { /* file missing = assume failure */ }

					log.info("Git op pane closed", { taskId: taskId.slice(0, 8), operation, ok });
					pushMessage?.("gitOpCompleted", { taskId, projectId, operation, ok });
				}
			} catch {
				cleanup();
			}
		}, 1000);

		// Safety timeout: stop polling after 10 minutes
		safetyTimeout = setTimeout(() => cleanup(), 10 * 60 * 1000);
	} catch {
		cleanup();
	}
}

export function setPushMessage(fn: (name: string, payload: any) => void): void {
	pushMessage = fn;
}

export function getPushMessage(): ((name: string, payload: any) => void) | null {
	return pushMessage;
}

export function isActive(status: TaskStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

/**
 * Background poller: detect when a "review-by-user" task's branch has been
 * merged into the base branch (squash, rebase, or regular merge).
 * Sends a `branchMerged` push message so the renderer can offer completion.
 */
let mergePollerInterval: ReturnType<typeof setInterval> | null = null;

export function startMergeDetectionPoller(): void {
	// Clear any existing poller to prevent stacking
	stopMergeDetectionPoller();
	const POLL_INTERVAL = 5 * 60_000; // 5 minutes

	mergePollerInterval = setInterval(async () => {
		try {
			await checkMergedBranches();
		} catch (err) {
			log.error("Merge detection poller error", { error: String(err) });
		}
	}, POLL_INTERVAL);

	log.info("Merge detection poller started", { intervalMs: POLL_INTERVAL });
}

export function stopMergeDetectionPoller(): void {
	if (mergePollerInterval) {
		clearInterval(mergePollerInterval);
		mergePollerInterval = null;
		log.info("Merge detection poller stopped");
	}
}

async function checkMergedBranches(): Promise<void> {
	if (!pushMessage) return;

	const projects = await data.loadProjects();

	// Sweep: remove stale entries from mergeNotifiedTasks and prPromotedTasks
	// for task IDs that no longer exist in any project.
	if (mergeNotifiedTasks.size > 0 || prPromotedTasks.size > 0) {
		const allTaskIds = new Set<string>();
		for (const p of projects) {
			const tasks = await data.loadTasks(p);
			for (const t of tasks) allTaskIds.add(t.id);
		}
		for (const id of mergeNotifiedTasks) {
			if (!allTaskIds.has(id)) mergeNotifiedTasks.delete(id);
		}
		for (const id of prPromotedTasks) {
			if (!allTaskIds.has(id)) prPromotedTasks.delete(id);
		}
	}

	for (const project of projects) {
		const tasks = await data.loadTasks(project);
		const reviewTasks = tasks.filter(
			(t) => (t.status === "review-by-user" || t.status === "review-by-colleague") && t.worktreePath && !mergeNotifiedTasks.has(t.id),
		);

		if (reviewTasks.length === 0) continue;

		// Single fetch per project (covers all branches)
		try {
			await git.fetchOrigin(project.path);
		} catch {
			continue; // offline or no remote — skip this project
		}

		for (const task of reviewTasks) {
			try {
				const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
				const ref = `origin/${baseBranch}`;

				// Check if branch was ever pushed (avoid false positives on new empty branches)
				const branchName = await git.getCurrentBranch(task.worktreePath!);
				if (!branchName) continue;
				const hasRemote = await git.getUnpushedCount(task.worktreePath!, branchName);
				if (hasRemote === -1) continue; // never pushed

				const merged = await git.isContentMergedInto(task.worktreePath!, ref);
				if (merged) {
					mergeNotifiedTasks.add(task.id);
					log.info("Branch merge detected", { taskId: task.id.slice(0, 8), branch: branchName });
					pushMessage("branchMerged", {
						taskId: task.id,
						projectId: project.id,
						taskTitle: task.customTitle || task.title,
						branchName,
					});
				}
			} catch (err) {
				log.warn("Merge check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
			}
		}
	}
}

/** Clear the merge-notified flag when a task leaves review-by-user (e.g. user dismisses). */
export function clearMergeNotification(taskId: string): void {
	mergeNotifiedTasks.delete(taskId);
}

/**
 * Background poller: detect when a "review-by-user" task's branch has an open
 * non-draft PR and automatically move it to "review-by-colleague".
 */
let prPollerInterval: ReturnType<typeof setInterval> | null = null;

// Track tasks already promoted to review-by-colleague (avoids re-checking in same session)
const prPromotedTasks = new Set<string>();

export function startPRDetectionPoller(): void {
	// Clear any existing poller to prevent stacking
	stopPRDetectionPoller();
	const POLL_INTERVAL = 5 * 60_000; // 5 minutes

	prPollerInterval = setInterval(async () => {
		try {
			await checkOpenPRsForPromotion();
		} catch (err) {
			log.error("PR detection poller error", { error: String(err) });
		}
	}, POLL_INTERVAL);

	log.info("PR detection poller started", { intervalMs: POLL_INTERVAL });
}

export function stopPRDetectionPoller(): void {
	if (prPollerInterval) {
		clearInterval(prPollerInterval);
		prPollerInterval = null;
		log.info("PR detection poller stopped");
	}
}

export function _resetPRPollerState(): void {
	prPromotedTasks.clear();
}

export async function checkOpenPRsForPromotion(): Promise<void> {
	if (!pushMessage) return;

	// Safety valve: if the Set grows unreasonably large, clear it entirely
	if (prPromotedTasks.size > 500) {
		log.warn("prPromotedTasks exceeded 500 entries, clearing", { size: prPromotedTasks.size });
		prPromotedTasks.clear();
	}

	const projects = await data.loadProjects();
	for (const project of projects) {
		// Only check projects with peer review enabled (default: true)
		if (project.peerReviewEnabled === false) continue;

		const tasks = await data.loadTasks(project);
		const candidates = tasks.filter(
			(t) => t.status === "review-by-user" && t.worktreePath && !prPromotedTasks.has(t.id),
		);

		if (candidates.length === 0) continue;

		for (const task of candidates) {
			try {
				const branchName = await git.getCurrentBranch(task.worktreePath!);
				if (!branchName) continue;

				// Skip branches that were never pushed (can't have a PR)
				const unpushed = await git.getUnpushedCount(task.worktreePath!, branchName);
				if (unpushed === -1) continue;

				// Check for open non-draft PR for this branch
				const ghResult = await git.run(
					["gh", "pr", "list", "--head", branchName, "--state", "open", "--json", "number,isDraft", "--limit", "1"],
					task.worktreePath!,
				);
				if (!ghResult.ok || !ghResult.stdout) continue;

				let prs: Array<{ number: number; isDraft: boolean }>;
				try {
					prs = JSON.parse(ghResult.stdout);
				} catch {
					continue;
				}

				const hasOpenNonDraftPR = Array.isArray(prs) && prs.length > 0 && !prs[0].isDraft;
				if (!hasOpenNonDraftPR) continue;

				prPromotedTasks.add(task.id);
				log.info("Open PR detected — promoting to review-by-colleague", {
					taskId: task.id.slice(0, 8),
					branch: branchName,
					pr: prs[0].number,
				});

				const updated = await data.updateTask(project, task.id, { status: "review-by-colleague" });
				pushMessage("taskUpdated", { projectId: project.id, task: updated });
			} catch (err) {
				log.warn("PR check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
			}
		}
	}
}

/** Clean up all in-memory tracking state for a task (pane IDs, merge flags). */
function cleanupTaskState(taskId: string): void {
	fileBrowserPaneIds.delete(taskId);
	gitOpPaneIds.delete(taskId);
	devViewerPaneIds.delete(taskId);
	mergeNotifiedTasks.delete(taskId);
	prPromotedTasks.delete(taskId);
	branchStatusInFlight.delete(taskId);
}

/** Run CoW clones for configured paths after worktree creation. */
async function runCowClones(project: Project, worktreePath: string): Promise<void> {
	if (!project.clonePaths?.length) return;
	await clonePaths(project.path, worktreePath, project.clonePaths);
}

/**
 * Shared helper for activating a task: creates worktree (with existingBranch
 * support), runs CoW clones, and launches the PTY session.
 * Returns the worktree info for the caller to persist.
 */
export async function activateTask(
	project: Project,
	task: Task,
	opts?: { isReopen?: boolean },
): Promise<{ worktreePath: string; branchName: string }> {
	const isReopen = opts?.isReopen ?? false;
	// Resolve config from project.path for worktree creation (defaultBaseBranch, etc.)
	const preResolved = await repoConfig.resolveProjectConfig(project);
	const wt = await git.createWorktree(preResolved, task, task.existingBranch ?? undefined);
	// Re-resolve from the worktree to pick up any .dev3/config.json on the branch
	const resolved = await repoConfig.resolveProjectConfig(project, wt.worktreePath);
	if (resolved.sparseCheckoutEnabled && resolved.sparseCheckoutPaths?.length) {
		log.info("activateTask: applying sparse checkout", { worktreePath: wt.worktreePath, paths: resolved.sparseCheckoutPaths });
		await git.applySparseCheckout(wt.worktreePath, resolved.sparseCheckoutPaths);
	} else {
		log.info("activateTask: sparse checkout disabled or no paths", { enabled: resolved.sparseCheckoutEnabled, pathCount: resolved.sparseCheckoutPaths?.length ?? 0 });
	}
	await runCowClones(resolved, wt.worktreePath);
	const taskForLaunch = isReopen ? { ...task, description: "" } : task;
	await launchTaskPty(resolved, taskForLaunch, wt.worktreePath, undefined, undefined, true, isReopen);
	return { worktreePath: wt.worktreePath, branchName: wt.branchName };
}

/**
 * Handle terminal bell notification. When a task is "in-progress" and
 * a BEL is received, auto-move it to "user-questions" — the agent is
 * likely waiting for human input.
 */
export async function handleBellAutoStatus(taskId: string): Promise<void> {
	try {
		const projects = await data.loadProjects();
		for (const project of projects) {
			const tasks = await data.loadTasks(project);
			const task = tasks.find((t) => t.id === taskId);
			if (!task) continue;

			if (task.status !== "in-progress") return;

			log.info("Bell auto-transition: in-progress → user-questions", { taskId: taskId.slice(0, 8) });
			const bellSettings = await loadSettings();
			const updated = await data.updateTask(project, task.id, { status: "user-questions" }, { dropPosition: bellSettings.taskDropPosition });
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			return;
		}
	} catch (err) {
		log.error("handleBellAutoStatus failed", { taskId: taskId.slice(0, 8), error: String(err) });
	}
}

/** Check whether a task is currently in "in-progress" status. */
export async function isTaskInProgress(taskId: string): Promise<boolean> {
	try {
		const projects = await data.loadProjects();
		for (const project of projects) {
			const tasks = await data.loadTasks(project);
			const task = tasks.find((t) => t.id === taskId);
			if (task) return task.status === "in-progress";
		}
	} catch (err) {
		log.error("isTaskInProgress failed", { taskId: taskId.slice(0, 8), error: String(err) });
	}
	return false;
}

const DEFAULT_CLEANUP_SCRIPT = 'echo "Task finished"';

export async function runCleanupScript(task: Task, project: Project): Promise<void> {
	if (!task.worktreePath) return;

	if (!existsSync(task.worktreePath)) {
		log.warn("Skipping cleanup script — worktree directory missing", {
			worktreePath: task.worktreePath,
			taskId: task.id,
		});
		return;
	}

	const resolved = await repoConfig.resolveProjectConfig(project, task.worktreePath);
	const script = resolved.cleanupScript?.trim() || DEFAULT_CLEANUP_SCRIPT;
	const scriptPath = `/tmp/dev3-${task.id}-cleanup.sh`;
	const sessionName = `dev3-cl-${task.id.slice(0, 8)}`;

	await Bun.write(scriptPath, `#!/bin/bash\n${script}\n`);

	log.info("Starting cleanup tmux session", { session: sessionName, worktreePath: task.worktreePath });

	// Run attached (no -d) so proc.exited fires when the script finishes
	// and tmux destroys the session automatically when the shell exits.
	const cleanupSocket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	const cleanupArgs = pty.tmuxArgs(cleanupSocket, "-f", pty.TMUX_CONF_PATH, "new-session", "-s", sessionName, "-c", task.worktreePath, `bash "${scriptPath}"`);
	const proc = spawn(
		cleanupArgs,
		{
			terminal: { cols: 220, rows: 50, data: () => {} },
			env: { TERM: "xterm-256color", HOME: process.env.HOME || "/" },
			cwd: task.worktreePath,
		},
	);

	await proc.exited;

	log.info("Cleanup session finished", { session: sessionName });
}

export function playTaskCompleteSound(status: "completed" | "cancelled"): void {
	const settings = loadSettingsSync();
	if (settings.playSoundOnTaskComplete === false) return;

	const filename = status === "completed" ? "task-completed.mp3" : "task-cancelled.mp3";
	const volume = status === "completed" ? "0.3" : "0.7";
	const prodPath = join(PATHS.VIEWS_FOLDER, "..", "sounds", filename);
	const devPath = join(import.meta.dir, "..", "assets", "sounds", filename);
	const soundPath = existsSync(prodPath) ? prodPath : existsSync(devPath) ? devPath : null;

	if (!soundPath) {
		log.warn("Task complete sound file not found", { prodPath, devPath, status });
		return;
	}

	// Fire and forget — don't block on sound playback
	try {
		spawn(["afplay", "-v", volume, soundPath], {
			env: { HOME: process.env.HOME || "/" },
		});
	} catch (err) {
		log.warn("Failed to play task complete sound", { error: String(err) });
	}
}

export async function launchTaskPty(
	project: Project,
	task: Task,
	worktreePath: string,
	agentId?: string | null,
	configId?: string | null,
	runSetup = false,
	resume = false,
): Promise<void> {
	log.info("launchTaskPty START", {
		taskId: task.id.slice(0, 8),
		projectId: project.id.slice(0, 8),
		worktreePath,
		agentId: agentId ?? "none",
		configId: configId ?? "none",
		runSetup,
		resume,
	});

	const ctx: agents.TemplateContext = {
		taskTitle: task.title,
		taskDescription: task.description,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";

	try {
		const cmdOptions = resume ? { resume } : undefined;
		if (agentId) {
			log.info("Resolving command for agent", { agentId, configId });
			const resolved = await agents.resolveCommandForAgent(agentId, configId ?? null, ctx, cmdOptions);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
			resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		} else {
			log.info("Resolving command for project", { projectName: project.name });
			const resolved = await agents.resolveCommandForProject(
				project,
				task.title,
				task.description,
				worktreePath,
				undefined,
				cmdOptions,
			);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
			resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		}
		log.info("Command resolved", { tmuxCmd, envKeys: Object.keys(extraEnv) });
	} catch (err) {
		log.error("Failed to resolve command", {
			taskId: task.id.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}

	// Build env early so both binary-check and setup paths can use it.
	const env = buildAgentEnv(extraEnv, task.id);

	// Pre-launch validation: check if the agent binary exists
	if (resolvedBaseCmd && resolvedBaseCmd !== "bash") {
		const binaryName = resolvedBaseCmd.split("/").pop() ?? resolvedBaseCmd;
		const { resolvedPath: binaryPath } = resolveBinaryPath(binaryName);
		if (!binaryPath) {
			// Find the agent to get install instructions
			const allAgents = await agents.getAllAgents();
			const matchedAgent = allAgents.find((a) => a.baseCommand === resolvedBaseCmd || a.baseCommand === binaryName);
			const installCmd = matchedAgent?.installCommand ?? `Install "${binaryName}" and make sure it's on your PATH`;

			log.warn("Agent binary not found, creating retry wrapper", { binaryName, installCmd });

			// Save the original agent command to a dedicated file so the retry
			// script can exec it directly (not the run.sh which may contain the
			// startup wrapper with setup scripts — that would re-run setup).
			const originalCmdPath = `/tmp/dev3-${task.id}-original-cmd.sh`;
			await Bun.write(originalCmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true }));

			// Write a retry wrapper script that shows a friendly error
			const retryScript = [
				"#!/bin/bash",
				"",
				"check_and_run() {",
				`  if command -v ${shellQuote(binaryName)} &>/dev/null; then`,
				`    printf '\\n\\033[1;32m✓ Found %s\\033[0m\\n\\n' ${shellQuote(binaryName)}`,
				`    exec bash "${originalCmdPath}"`,
				"  fi",
				"}",
				"",
				"while true; do",
				`  printf '\\033[1;31m✗ Agent not found: %s\\033[0m\\n\\n' ${shellQuote(binaryName)}`,
				`  printf '\\033[1mInstall:\\033[0m %s\\n' ${shellQuote(installCmd)}`,
				`  printf '\\033[2mAfter installing, run \"%s\" once in a terminal to log in.\\033[0m\\n' ${shellQuote(binaryName)}`,
				`  printf '\\033[2mInstallation and setup are not managed by dev-3.0.\\033[0m\\n\\n'`,
				"  printf 'Press \\033[1mEnter\\033[0m to retry...\\n'",
				"  read -r",
				"  check_and_run",
				"done",
				"",
			].join("\n");

			const retryScriptPath = `/tmp/dev3-${task.id}-agent-check.sh`;
			await Bun.write(retryScriptPath, retryScript);
			tmuxCmd = `bash "${retryScriptPath}"`;
			log.info("Replaced tmuxCmd with agent-check retry wrapper");
		}
	}

	// Pre-register worktree as trusted so claude skips the trust dialog
	try {
		await agents.ensureClaudeTrust(worktreePath);
		log.info("Claude trust ensured", { worktreePath });
	} catch (err) {
		log.error("ensureClaudeTrust failed (non-fatal)", {
			worktreePath,
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
	}

	// Pre-register worktree as trusted so gemini skips the trust dialog
	if (agents.isGeminiCommand(resolvedBaseCmd)) {
		try {
			await agents.ensureGeminiTrust(worktreePath);
			log.info("Gemini trust ensured", { worktreePath });
		} catch (err) {
			log.error("ensureGeminiTrust failed (non-fatal)", {
				worktreePath,
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
		}
	}

	// Install agent-native hooks (e.g., Claude Code PermissionRequest/Stop)
	// Primary agent always stops at review-by-user; AI review is triggered manually.
	const stopTarget: TaskStatus = "review-by-user";
	try {
		setupAgentHooks(worktreePath, resolvedBaseCmd, { stopTarget });
	} catch (err) {
		log.warn("setupAgentHooks failed (non-fatal)", {
			worktreePath,
			error: String(err),
		});
	}

	let isSetupWrapper = false;
	if (runSetup && project.setupScript.trim()) {
		const prefix = `/tmp/dev3-${task.id}`;
		const setupPath = `${prefix}-setup.sh`;
		const claudePath = `${prefix}-cmd.sh`;
		const startupPath = `${prefix}-startup.sh`;

		// Write setup script and claude command to separate files
		// to avoid tmux env var propagation issues (tmux server doesn't
		// inherit custom env vars from the client process)
		await Bun.write(setupPath, project.setupScript + "\n");
		await Bun.write(claudePath, buildCmdScript(tmuxCmd, env, { keepShell: true }));

		const splitCmd = `tmux split-window -v -c "${escapeForDoubleQuotes(worktreePath)}" "bash '${claudePath}'"`;
		const setupFail = [
			"  printf '\\033[1;31m✗ Setup failed (exit %s)\\033[0m\\n' \"$S\"",
			"  exec bash",
		].join("\n");
		const setupOkClose = [
			"printf '\\033[1;32m✓ Setup done\\033[0m\\n'",
			"printf '\\033[2mClosing in 15s — press any key to close now\\033[0m\\n'",
			"read -t 15 -n 1 -s",
			"exit 0",
		].join("\n");

		const startupScript = [
			"#!/bin/bash",
			splitCmd,
			`bash -x "${setupPath}"`,
			"S=$?",
			`if [ $S -ne 0 ]; then`,
			setupFail,
			"fi",
			setupOkClose,
		].join("\n");

		await Bun.write(startupPath, startupScript + "\n");
		tmuxCmd = `bash "${startupPath}"`;
		isSetupWrapper = true;
	}

	// Write the command to a temp script instead of passing inline.
	// tmux 3.x limits the shell-command for new-session to ~16 KB;
	// inline commands with long task descriptions easily exceed that.
	const runScriptPath = `/tmp/dev3-${task.id}-run.sh`;
	await Bun.write(runScriptPath, buildCmdScript(tmuxCmd, env, { keepShell: !isSetupWrapper }));
	const wrapperCmd = `bash "${runScriptPath}"`;

	log.info("Creating PTY session", {
		taskId: task.id.slice(0, 8),
		worktreePath,
		command: tmuxCmd.slice(0, 200),
		scriptPath: runScriptPath,
		envKeys: Object.keys(env),
	});
	try {
		pty.createSession(task.id, project.id, worktreePath, wrapperCmd, env, task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET);
		log.info("launchTaskPty DONE — PTY session created", { taskId: task.id.slice(0, 8) });
	} catch (err) {
		log.error("pty.createSession FAILED", {
			taskId: task.id.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}
}

/**
 * Launch a column agent in a new tmux split pane within the task's existing session.
 * Kills any previous column-agent pane first to ensure a fresh start.
 */
export async function launchColumnAgent(
	project: Project,
	task: Task,
	agentConfig: ColumnAgentConfig,
	options: { paneTitle: string; onExitCommand?: string },
): Promise<void> {
	const worktreePath = task.worktreePath;
	if (!worktreePath) {
		log.warn("launchColumnAgent: no worktreePath, skipping", { taskId: task.id.slice(0, 8) });
		return;
	}

	const { agentId, configId, prompt: rawPrompt } = agentConfig;
	const baseBranch = task.baseBranch || "main";
	const prompt = rawPrompt.replace(/\{baseBranch\}/g, `origin/${baseBranch}`);

	log.info("launchColumnAgent START", {
		taskId: task.id.slice(0, 8),
		agentId,
		configId,
		paneTitle: options.paneTitle,
	});

	const socket = pty.getSessionSocket(task.id);
	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;

	// Resolve the agent command
	const ctx: agents.TemplateContext = {
		taskTitle: `${options.paneTitle}: ${task.title}`,
		taskDescription: prompt,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;

	try {
		const resolved = await agents.resolveCommandForAgent(agentId, configId, ctx, { skipSystemPrompt: true });
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
	} catch (err) {
		log.error("launchColumnAgent: failed to resolve command", { error: String(err) });
		throw err;
	}

	// Build wrapper script
	const env = buildAgentEnv(extraEnv, task.id);

	const scriptPath = `/tmp/dev3-${task.id}-col-agent.sh`;
	await Bun.write(scriptPath, buildCmdScript(tmuxCmd, env, {
		paneTitle: options.paneTitle,
		onExitCommand: options.onExitCommand,
	}));

	// Kill previous column-agent pane by saved pane ID
	const paneFile = `/tmp/dev3-${task.id}-col-agent-pane`;
	try {
		const oldPaneId = (await Bun.file(paneFile).text()).trim();
		if (oldPaneId) {
			log.info("launchColumnAgent: killing old pane", { paneId: oldPaneId });
			const killArgs = pty.tmuxArgs(socket, "kill-pane", "-t", oldPaneId);
			spawnSync(killArgs, { stdout: "pipe", stderr: "pipe" });
		}
	} catch {
		// No previous pane — fine
	}

	// Create pane as a horizontal split (40% width on the right)
	const splitArgs = pty.tmuxArgs(
		socket, "split-window",
		"-h", "-l", "40%",
		"-P", "-F", "#{pane_id}",
		"-t", tmuxSession,
		"-c", worktreePath,
		`bash "${scriptPath}"`,
	);
	const proc = spawn(splitArgs, { stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.error("launchColumnAgent: tmux split-window failed", { exitCode, stderr: stderr.trim() });
		throw new Error(`tmux split-window failed: ${stderr.trim() || "unknown error"}`);
	}

	// Save pane ID for cleanup on next run
	const newPaneId = stdout.trim();
	if (newPaneId) {
		await Bun.write(paneFile, newPaneId);
		log.info("launchColumnAgent: pane created", { paneId: newPaneId });
	}

	// Switch focus back to the main pane (left)
	try {
		const focusArgs = pty.tmuxArgs(socket, "select-pane", "-t", `${tmuxSession}:.0`);
		spawnSync(focusArgs, { stdout: "pipe", stderr: "pipe" });
	} catch {
		// Non-fatal
	}

	log.info("launchColumnAgent DONE", { taskId: task.id.slice(0, 8) });
}

/**
 * Trigger a column agent if the task just entered a column with an agent configured.
 * For review-by-ai: uses builtinColumnAgents config, with onExitCommand to move to review-by-user.
 * For custom columns: uses column.agentConfig, no onExitCommand (task stays).
 * Shared between CLI socket and RPC moveTask handlers.
 */
export async function triggerColumnAgentIfNeeded(
	newStatus: TaskStatus,
	project: Project,
	task: Task,
	options?: { customColumn?: CustomColumn },
): Promise<void> {
	if (!task.worktreePath) return;

	let agentConfig: ColumnAgentConfig | undefined;
	let paneTitle = "";
	let onExitCommand: string | undefined;

	if (newStatus === "review-by-ai") {
		// Built-in review-by-ai column
		const config = project.builtinColumnAgents?.["review-by-ai"];
		agentConfig = config ?? {
			agentId: "builtin-claude",
			configId: "claude-bypass-sonnet",
			prompt: DEFAULT_REVIEW_PROMPT,
		};
		paneTitle = "AI Review";
		// After successful exit, move task to review-by-user (only if still in review-by-ai)
		onExitCommand = `${DEV3_HOME}/bin/dev3 task move ${task.id} --status review-by-user --if-status review-by-ai`;
	} else if (options?.customColumn?.agentConfig) {
		// Custom column with agent configured
		agentConfig = options.customColumn.agentConfig;
		paneTitle = options.customColumn.name;
		// No onExitCommand — task stays in custom column
	}

	if (!agentConfig) return;

	try {
		await launchColumnAgent(project, task, agentConfig, { paneTitle, onExitCommand });
	} catch (err) {
		log.error("launchColumnAgent failed", {
			taskId: task.id,
			status: newStatus,
			error: String(err),
		});
		// For review-by-ai: fall back to review-by-user so the task doesn't get stuck
		if (newStatus === "review-by-ai") {
			try {
				const fallback = await data.updateTask(project, task.id, { status: "review-by-user" });
				pushMessage?.("taskUpdated", { projectId: project.id, task: fallback });
			} catch (fallbackErr) {
				log.error("Failed to fall back to review-by-user", { taskId: task.id, error: String(fallbackErr) });
			}
		}
	}
}

async function getBranchStatusImpl(params: { taskId: string; projectId: string; compareRef?: string }): Promise<BranchStatus> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) {
		return { ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0, unpushed: 0, mergedByContent: false, diffFiles: 0, diffInsertions: 0, diffDeletions: 0, diffFileNames: [], prNumber: null, prUrl: null };
	}

	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";

	// Resolve live branch name — it may differ from stored after rename
	const liveBranch = await git.getCurrentBranch(task.worktreePath);
	const branchForPush = liveBranch ?? task.branchName ?? "";

	// Auto-sync stored branchName if it drifted
	if (liveBranch && liveBranch !== task.branchName) {
		log.info("getBranchStatus: branch renamed, syncing stored name", { old: task.branchName, new: liveBranch });
		await data.updateTask(project, task.id, { branchName: liveBranch });
	}

	log.info("getBranchStatus: fetching origin", { worktreePath: task.worktreePath, baseBranch, branchName: branchForPush });
	await git.fetchOrigin(project.path);
	// compareRef lets the UI choose: origin/<baseBranch> (default) or local baseBranch
	const ref = params.compareRef || `origin/${baseBranch}`;
	// Detect open PR (including drafts) in parallel with other git operations (graceful degradation)
	const prDetection: Promise<{ number: number; url: string } | null> = (async () => {
		try {
			const ghResult = await git.run(
				["gh", "pr", "list", "--head", branchForPush, "--state", "open", "--json", "number,url", "--limit", "1"],
				task.worktreePath!,
			);
			if (ghResult.ok && ghResult.stdout) {
				const prs = JSON.parse(ghResult.stdout);
				if (Array.isArray(prs) && prs.length > 0 && typeof prs[0].number === "number") {
					return { number: prs[0].number, url: typeof prs[0].url === "string" ? prs[0].url : "" };
				}
			}
		} catch (err) {
			log.warn("PR detection failed (non-fatal)", { error: String(err) });
		}
		return null;
	})();

	const [status, uncommitted, unpushed, branchDiff, prInfo] = await Promise.all([
		git.getBranchStatus(task.worktreePath, ref),
		git.getUncommittedChanges(task.worktreePath),
		git.getUnpushedCount(task.worktreePath, branchForPush),
		git.getBranchDiffStats(task.worktreePath, ref),
		prDetection,
	]);
	const prNumber = prInfo?.number ?? null;
	const prUrl = prInfo?.url ?? null;
	log.info("getBranchStatus: raw results", { status, uncommitted, unpushed, branchDiff, prNumber, prUrl, ref });
	const canRebase = status.behind > 0 ? await git.canRebaseCleanly(task.worktreePath, ref) : false;
	const mergedByContent = status.ahead > 0 ? await git.isContentMergedInto(task.worktreePath, ref) : false;

	const result = {
		...status, canRebase, ...uncommitted, unpushed, mergedByContent,
		diffFiles: branchDiff.files, diffInsertions: branchDiff.insertions, diffDeletions: branchDiff.deletions, diffFileNames: branchDiff.fileNames,
		prNumber, prUrl,
	};
	log.info("← getBranchStatus", result);

	// Fire-and-forget: save diff snapshot for recovery purposes
	git.saveDiffSnapshot(project, task, ref).catch((err) => {
		log.warn("saveDiffSnapshot failed", { taskId: task.id, error: String(err) });
	});

	return result;
}

const rendererLog = createLogger("renderer");

export const handlers = {
	async logRendererError(params: { description: string; source: "error" | "unhandledrejection" }): Promise<void> {
		rendererLog.warn(`[${params.source}] ${params.description}`);
	},

	async quitApp(): Promise<void> {
		log.info("→ quitApp (Cmd+Q from renderer)");
		Utils.quit();
	},

	async hideApp(): Promise<void> {
		log.info("→ hideApp (Cmd+H from renderer)");
		// Electrobun doesn't expose a hide() API. The menu has { role: "hide" }
		// which creates the native NSMenuItem, but WKWebView swallows the Cmd+H
		// keystroke before it reaches the macOS menu responder chain.
		// Workaround: call [NSApp hide:nil] directly via Objective-C runtime FFI.
		// This requires no permissions (unlike osascript + System Events).
		hideAppNative();
	},

	async showConfirm(params: { title: string; message: string }): Promise<boolean> {
		const { response } = await Utils.showMessageBox({
			type: "question",
			title: params.title,
			message: params.message,
			buttons: ["OK", "Cancel"],
			defaultId: 1,
			cancelId: 1,
		});
		return response === 0;
	},

	async getProjects(): Promise<Project[]> {
		log.info("→ getProjects");
		const rawProjects = await data.loadProjects();
		// One-time migration: create .dev3/config.json from projects.json settings
		await Promise.all(rawProjects.map((p) => repoConfig.migrateProjectConfig(p)));
		const projects = await Promise.all(rawProjects.map((p) => repoConfig.resolveProjectConfig(p)));
		log.info(`← getProjects: ${projects.length} project(s)`);
		return projects;
	},

	async pickFolder(): Promise<string | null> {
		log.info("→ pickFolder (opening native dialog)");
		try {
			const startingFolder = homedir();
			log.info("pickFolder starting from", { startingFolder });

			const paths = await Utils.openFileDialog({
				startingFolder,
				canChooseFiles: false,
				canChooseDirectory: true,
				allowsMultipleSelection: false,
			});
			log.info("← pickFolder", { paths });
			if (!paths || paths.length === 0) return null;

			const picked = paths[0];
			return picked;
		} catch (err) {
			log.error("pickFolder failed", { error: String(err) });
			throw err;
		}
	},

	async addProject(params: {
		path: string;
		name: string;
	}): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
		log.info("→ addProject", params);
		try {
			const isRepo = await git.isGitRepo(params.path);
			if (!isRepo) {
				log.warn("Not a git repo", { path: params.path });
				return { ok: false, error: "Selected folder is not a git repository" };
			}
			const project = await data.addProject(params.path, params.name);
			// Try to detect default branch
			try {
				const defaultBranch = await git.getDefaultBranch(params.path);
				await data.updateProject(project.id, { defaultBaseBranch: defaultBranch });
				project.defaultBaseBranch = defaultBranch;
			} catch (err) {
				log.warn("Could not detect default branch, keeping 'main'", {
					error: String(err),
				});
			}
			log.info("← addProject OK", { projectId: project.id, name: project.name });
			return { ok: true, project };
		} catch (err) {
			log.error("addProject failed", { error: String(err), params });
			return { ok: false, error: String(err) };
		}
	},

	async cloneAndAddProject(params: {
		url: string;
		baseDir: string;
		repoName?: string;
	}): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
		log.info("→ cloneAndAddProject", params);
		try {
			const name = params.repoName || extractRepoName(params.url);
			const targetDir = `${params.baseDir}/${name}`;

			if (existsSync(targetDir)) {
				const isRepo = await git.isGitRepo(targetDir);
				if (isRepo) {
					log.info("Directory already exists and is a git repo, adding as project", { targetDir });
					return handlers.addProject({ path: targetDir, name });
				}
				return { ok: false, error: `Directory already exists: ${targetDir}` };
			}

			const cloneResult = await git.cloneRepo(params.url, targetDir);
			if (!cloneResult.ok) {
				return { ok: false, error: `Clone failed: ${cloneResult.error}` };
			}

			return handlers.addProject({ path: targetDir, name });
		} catch (err) {
			log.error("cloneAndAddProject failed", { error: String(err), params });
			return { ok: false, error: String(err) };
		}
	},

	async removeProject(params: { projectId: string }): Promise<void> {
		log.info("→ removeProject", params);
		// Clean up fetch cache before removing the project
		try {
			const project = await data.getProject(params.projectId);
			git.removeFetchCache(project.path);
		} catch { /* project may already be gone */ }
		await data.removeProject(params.projectId);
		log.info("← removeProject done");
	},

	async detectClonePaths(params: { projectId: string }): Promise<string[]> {
		log.info("→ detectClonePaths", { projectId: params.projectId });
		const project = await data.getProject(params.projectId);
		const { detectClonePaths: detect } = await import("./cow-clone");
		const paths = await detect(project.path);
		log.info("← detectClonePaths", { count: paths.length });
		return paths;
	},

	async getResolvedProject(params: { projectId: string; worktreePath: string }): Promise<Project> {
		log.info("→ getResolvedProject", { projectId: params.projectId, worktreePath: params.worktreePath });
		const project = await data.getProject(params.projectId);
		const resolved = await repoConfig.resolveProjectConfig(project, params.worktreePath);
		log.info("← getResolvedProject");
		return resolved;
	},

	async getProjectConfigs(params: { projectId: string; worktreePath?: string }): Promise<{ repo: Dev3RepoConfig; local: Dev3RepoConfig }> {
		log.info("→ getProjectConfigs", { projectId: params.projectId, worktreePath: params.worktreePath });
		const project = await data.getProject(params.projectId);
		const configPath = params.worktreePath || project.path;
		const repo = repoConfig.loadRepoConfigRaw(configPath);
		const local = repoConfig.loadLocalConfigRaw(configPath);
		log.info("← getProjectConfigs");
		return { repo, local };
	},

	async saveRepoConfig(params: { projectId: string; worktreePath?: string } & Dev3RepoConfig): Promise<void> {
		log.info("→ saveRepoConfig", { projectId: params.projectId, worktreePath: params.worktreePath });
		const project = await data.getProject(params.projectId);
		const configPath = params.worktreePath || project.path;
		const config: Dev3RepoConfig = {};
		for (const key of DEV3_REPO_CONFIG_KEYS) {
			const val = (params as any)[key];
			if (val !== undefined) {
				(config as any)[key] = val;
			}
		}
		await repoConfig.saveRepoConfig(configPath, config);
		log.info("← saveRepoConfig done");
	},

	async saveLocalConfig(params: { projectId: string; worktreePath?: string } & Dev3RepoConfig): Promise<void> {
		log.info("→ saveLocalConfig", { projectId: params.projectId, worktreePath: params.worktreePath });
		const project = await data.getProject(params.projectId);
		const configPath = params.worktreePath || project.path;
		const config: Dev3RepoConfig = {};
		for (const key of DEV3_REPO_CONFIG_KEYS) {
			const val = (params as any)[key];
			if (val !== undefined) {
				(config as any)[key] = val;
			}
		}
		await repoConfig.saveRepoLocalConfig(configPath, config);
		log.info("← saveLocalConfig done");
	},

	async getRepoConfigSources(params: { projectId: string; worktreePath?: string }): Promise<ConfigSourceEntry[]> {
		log.info("→ getRepoConfigSources", { projectId: params.projectId, worktreePath: params.worktreePath });
		const project = await data.getProject(params.projectId);
		const configPath = params.worktreePath || project.path;
		const sources = await repoConfig.getConfigSources(configPath);
		log.info("← getRepoConfigSources", { count: sources.length });
		return sources;
	},

	async getGlobalSettings(): Promise<GlobalSettings> {
		log.info("→ getGlobalSettings");
		const settings = await loadSettings();
		log.info("← getGlobalSettings", { settings });
		return settings;
	},

	async saveGlobalSettings(params: GlobalSettings): Promise<void> {
		log.info("→ saveGlobalSettings", { params });
		await saveSettings(params);
		log.info("← saveGlobalSettings done");
	},

	async installDev3Cli(): Promise<{ installedFrom: string }> {
		log.info("→ installDev3Cli");
		const cliBinDir = `${DEV3_HOME}/bin`;
		const cliDest = `${cliBinDir}/dev3`;
		const prodCli = join(PATHS.VIEWS_FOLDER, "..", "cli", "dev3");
		const devCli = join(import.meta.dir, "..", "cli", "dev3");
		const source = existsSync(prodCli) ? prodCli : devCli;
		if (!existsSync(source)) throw new Error(`CLI binary not found: ${source}`);
		mkdirSync(cliBinDir, { recursive: true });
		// Remove existing file/symlink before creating the new symlink
		try { unlinkSync(cliDest); } catch {}
		symlinkSync(source, cliDest);
		chmodSync(cliDest, 0o755);
		log.info("← installDev3Cli", { from: source, to: cliDest });
		return { installedFrom: source };
	},

	async getAgents(): Promise<CodingAgent[]> {
		log.info("→ getAgents");
		const all = await agents.getAllAgents();
		log.info(`← getAgents: ${all.length} agent(s)`);
		return all;
	},

	async saveAgents(params: { agents: CodingAgent[] }): Promise<void> {
		log.info("→ saveAgents", { count: params.agents.length });
		await agents.saveAllAgents(params.agents);
		log.info("← saveAgents done");
	},

	async getTasks(params: { projectId: string }): Promise<Task[]> {
		log.info("→ getTasks", params);
		const project = await data.getProject(params.projectId);
		const tasks = await data.loadTasks(project);
		log.info(`← getTasks: ${tasks.length} task(s)`);
		return tasks;
	},

	async getAllProjectTasks(): Promise<{ projectId: string; tasks: Task[] }[]> {
		log.info("→ getAllProjectTasks");
		const projects = await data.loadProjects();
		const results = await Promise.all(
			projects.map(async (project) => {
				const tasks = await data.loadTasks(project);
				const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
				return { projectId: project.id, tasks: active };
			}),
		);
		const totalActive = results.reduce((sum, r) => sum + r.tasks.length, 0);
		log.info(`← getAllProjectTasks: ${totalActive} active task(s) across ${projects.length} project(s)`);
		return results;
	},

	async createTask(params: {
		projectId: string;
		description: string;
		status?: TaskStatus;
		existingBranch?: string;
	}): Promise<Task> {
		log.info("→ createTask", params);
		const project = await data.getProject(params.projectId);
		const status = params.status || "todo";
		const task = await data.addTask(project, params.description, status,
			params.existingBranch ? { existingBranch: params.existingBranch } : undefined,
		);

		// If created directly into an active status, set up worktree + PTY
		if (isActive(status)) {
			log.info("Created into active status, creating worktree + PTY", {
				taskId: task.id,
			});
			const wt = await activateTask(project, task);

			const updated = await data.updateTask(project, task.id, {
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
			});
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("← createTask (with worktree)", { taskId: task.id });
			return updated;
		}

		log.info("← createTask", { taskId: task.id });
		return task;
	},

	async moveTask(params: {
		taskId: string;
		projectId: string;
		newStatus: TaskStatus;
		force?: boolean;
	}): Promise<Task> {
		log.info("→ moveTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const oldStatus = task.status;
		const newStatus = params.newStatus;
		const settings = await loadSettings();
		const dropOpts = { dropPosition: settings.taskDropPosition } as const;

		log.info(`Moving task ${oldStatus} → ${newStatus}`, { taskId: task.id, force: !!params.force });

		// Clear merge notification flag so it can re-trigger if task comes back to review-by-user
		clearMergeNotification(task.id);
		// Allow re-promotion if the task returns to review-by-user later
		prPromotedTasks.delete(task.id);

		// todo → active: create worktree + PTY session
		if (!isActive(oldStatus) && isActive(newStatus)) {
			const isReopen = oldStatus === "completed" || oldStatus === "cancelled";
			log.info("Transition: inactive → active, creating worktree + PTY", { isReopen });
			const wt = await activateTask(project, task, { isReopen });

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
				customColumnId: null,
			}, dropOpts);
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("← moveTask done (worktree created)", { taskId: task.id });
			return updated;
		}

		// → completed/cancelled: destroy PTY, run cleanup if configured, then remove worktree
		if (newStatus === "completed" || newStatus === "cancelled") {
			cleanupTaskState(task.id);
			if (params.force) {
				// Force mode: skip PTY destruction, cleanup script, and worktree removal.
				// The environment is already broken — just update the status.
				log.info("Force mode: skipping PTY/cleanup/worktree", { taskId: task.id });
			} else if (isActive(oldStatus) || task.worktreePath) {
				// Active task or task that still has a worktree (e.g. moved back to todo)
				log.info("Transition → terminal, cleaning up PTY + worktree", {
					oldStatus,
					hasWorktree: !!task.worktreePath,
				});
				try {
					pty.destroySession(task.id, task.tmuxSocket ?? undefined);
				} catch (err) {
					log.error("destroySession failed, continuing with task move", {
						taskId: task.id,
						error: String(err),
					});
				}

				// Kill the dev server session if one was started for this task (best-effort)
				killDevServerSession(task.id, task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET).catch((err) => {
					log.warn("killDevServerSession on task move failed (best-effort)", {
						taskId: task.id.slice(0, 8), error: String(err),
					});
				});

				try {
					log.info("Running cleanup script before removing worktree", { taskId: task.id });
					await runCleanupScript(task, project);
				} catch (err) {
					log.error("Cleanup script failed, continuing with task move", {
						taskId: task.id,
						error: String(err),
					});
				}

				playTaskCompleteSound(newStatus as "completed" | "cancelled");

				try {
					await git.removeWorktree(project, task);
				} catch (err) {
					log.error("removeWorktree failed, continuing with task move", {
						taskId: task.id,
						error: String(err),
					});
				}
			}

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: null,
				branchName: null,
				customColumnId: null,
			}, dropOpts);
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("← moveTask done (worktree destroyed)", { taskId: task.id });
			return updated;
		}

		// active → active or todo → todo/completed/cancelled (no worktree changes)
		const updated = await data.updateTask(project, task.id, {
			status: newStatus,
			customColumnId: null,
		}, dropOpts);
		pushMessage?.("taskUpdated", { projectId: project.id, task: updated });

		// Trigger column agent if entering review-by-ai
		await triggerColumnAgentIfNeeded(newStatus, project, updated);

		log.info("← moveTask done (status only)", { taskId: task.id });
		return updated;
	},

	async reorderTask(params: { taskId: string; projectId: string; targetIndex: number }): Promise<Task[]> {
		log.info("→ reorderTask", params);
		const project = await data.getProject(params.projectId);
		const updatedColumnTasks = await data.reorderTasksInColumn(project, params.taskId, params.targetIndex);
		for (const task of updatedColumnTasks) {
			pushMessage?.("taskUpdated", { projectId: project.id, task });
		}
		log.info("← reorderTask done", { count: updatedColumnTasks.length });
		return updatedColumnTasks;
	},

	async deleteTask(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ deleteTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		cleanupTaskState(task.id);

		// Cleanup if active
		if (isActive(task.status)) {
			log.info("Task is active, cleaning up PTY + worktree");
			pty.destroySession(task.id, task.tmuxSocket ?? undefined);
			await git.removeWorktree(project, task);
		}

		await data.deleteTask(project, task.id);
		log.info("← deleteTask done");
	},

	async spawnVariants(params: {
		taskId: string;
		projectId: string;
		targetStatus: TaskStatus;
		variants: Array<{ agentId: string | null; configId: string | null }>;
	}): Promise<Task[]> {
		log.info("→ spawnVariants", { taskId: params.taskId, count: params.variants.length });
		const project = await data.getProject(params.projectId);
		const sourceTask = await data.getTask(project, params.taskId);

		if (sourceTask.status !== "todo") {
			throw new Error(`Task must be in todo status to spawn variants (got ${sourceTask.status})`);
		}

		const groupId = crypto.randomUUID();
		const sharedSeq = sourceTask.seq;
		const resultTasks: Task[] = [];
		const srcBranch = sourceTask.existingBranch ?? undefined;
		const isMultiVariant = params.variants.length > 1;
		const needsWorktree = isActive(params.targetStatus);

		// Phase 1: Create all tasks in DB immediately (fast)
		for (let i = 0; i < params.variants.length; i++) {
			const variant = params.variants[i];

			const task = await data.addTask(
				project,
				sourceTask.description,
				params.targetStatus,
				{
					groupId,
					variantIndex: i + 1,
					agentId: variant.agentId,
					configId: variant.configId,
					seq: sharedSeq,
					existingBranch: srcBranch,
					preparing: needsWorktree,
				},
			);

			resultTasks.push(task);
		}

		// Delete the original TODO task
		await data.deleteTask(project, params.taskId);

		log.info("← spawnVariants returning immediately", { count: resultTasks.length, groupId, needsWorktree });

		// Phase 2: Heavy I/O (worktree + CoW + PTY) runs in the background
		if (needsWorktree) {
			(async () => {
				for (let i = 0; i < resultTasks.length; i++) {
					const task = resultTasks[i];
					const variant = params.variants[i];
					try {
						const variantBranchName = (isMultiVariant && srcBranch)
							? `${srcBranch.replace(/^origin\//, "")}-v${i + 1}`
							: undefined;
						const wt = await git.createWorktree(project, task, task.existingBranch ?? undefined, variantBranchName);
						if (project.sparseCheckoutEnabled && project.sparseCheckoutPaths?.length) {
							await git.applySparseCheckout(wt.worktreePath, project.sparseCheckoutPaths);
						}
						await runCowClones(project, wt.worktreePath);
						await launchTaskPty(project, task, wt.worktreePath, variant.agentId, variant.configId, true);

						const updated = await data.updateTask(project, task.id, {
							worktreePath: wt.worktreePath,
							branchName: wt.branchName,
							preparing: false,
						});
						pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
						log.info("Variant ready", { taskId: task.id, worktreePath: wt.worktreePath });
					} catch (err) {
						log.error("Failed to prepare variant", { taskId: task.id, error: String(err) });
						// Mark as no longer preparing so the card isn't stuck
						try {
							const updated = await data.updateTask(project, task.id, { preparing: false });
							pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
						} catch { /* best effort */ }
					}
				}
			})();
		}

		return resultTasks;
	},

	async addAttempts(params: {
		taskId: string;
		projectId: string;
		variants: Array<{ agentId: string | null; configId: string | null }>;
	}): Promise<Task[]> {
		log.info("→ addAttempts", { taskId: params.taskId, count: params.variants.length });
		const project = await data.getProject(params.projectId);
		const sourceTask = await data.getTask(project, params.taskId);

		// Determine groupId — reuse existing or create new
		let groupId = sourceTask.groupId;
		const allTasks = await data.loadTasks(project);
		let maxVariantIndex = 0;

		if (groupId) {
			// Find max variantIndex among existing group members
			for (const t of allTasks) {
				if (t.groupId === groupId && t.variantIndex !== null && t.variantIndex > maxVariantIndex) {
					maxVariantIndex = t.variantIndex;
				}
			}
		} else {
			// Source task has no group yet — create one and update source task
			groupId = crypto.randomUUID();
			maxVariantIndex = 1;
			await data.updateTask(project, sourceTask.id, { groupId, variantIndex: 1 });
		}

		const sharedSeq = sourceTask.seq;
		const resultTasks: Task[] = [];
		const targetStatus: TaskStatus = "in-progress";
		const needsWorktree = isActive(targetStatus);

		// Phase 1: Create all new attempt tasks in DB
		for (let i = 0; i < params.variants.length; i++) {
			const variant = params.variants[i];
			const variantIndex = maxVariantIndex + i + 1;

			const task = await data.addTask(
				project,
				sourceTask.description,
				targetStatus,
				{
					groupId,
					variantIndex,
					agentId: variant.agentId,
					configId: variant.configId,
					seq: sharedSeq,
					preparing: needsWorktree,
				},
			);

			resultTasks.push(task);
		}

		// Re-read the updated source task (may have been updated with groupId)
		const updatedSource = await data.getTask(project, sourceTask.id);

		log.info("← addAttempts returning", { count: resultTasks.length, groupId, needsWorktree });

		// Phase 2: Heavy I/O in background
		if (needsWorktree) {
			(async () => {
				for (let i = 0; i < resultTasks.length; i++) {
					const task = resultTasks[i];
					const variant = params.variants[i];
					try {
						const wt = await git.createWorktree(project, task);
						if (project.sparseCheckoutEnabled && project.sparseCheckoutPaths?.length) {
							await git.applySparseCheckout(wt.worktreePath, project.sparseCheckoutPaths);
						}
						await runCowClones(project, wt.worktreePath);
						await launchTaskPty(project, task, wt.worktreePath, variant.agentId, variant.configId, true);

						const updated = await data.updateTask(project, task.id, {
							worktreePath: wt.worktreePath,
							branchName: wt.branchName,
							preparing: false,
						});
						pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
						log.info("Attempt ready", { taskId: task.id, worktreePath: wt.worktreePath });
					} catch (err) {
						log.error("Failed to prepare attempt", { taskId: task.id, error: String(err) });
						try {
							const updated = await data.updateTask(project, task.id, { preparing: false });
							pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
						} catch { /* best effort */ }
					}
				}
			})();
		}

		return [updatedSource, ...resultTasks];
	},

	async editTask(params: { taskId: string; projectId: string; description: string }): Promise<Task> {
		log.info("→ editTask", { taskId: params.taskId });
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		if (task.status !== "todo") {
			throw new Error(`Can only edit tasks in todo status (got ${task.status})`);
		}
		const updates: Partial<Task> = { description: params.description };
		// Only recompute auto-title if there's no custom override
		if (!task.customTitle) {
			updates.title = titleFromDescription(params.description);
		}
		const updated = await data.updateTask(project, task.id, updates);
		log.info("← editTask done", { taskId: task.id });
		return updated;
	},

	async renameTask(params: { taskId: string; projectId: string; customTitle: string | null }): Promise<Task> {
		log.info("→ renameTask", { taskId: params.taskId, customTitle: params.customTitle });
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const trimmed = params.customTitle?.trim() || null;
		const updated = await data.updateTask(project, task.id, { customTitle: trimmed });
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		log.info("← renameTask done", { taskId: task.id });
		return updated;
	},

	async runDevServer(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ runDevServer", params);
		try {
			const project = await data.getProject(params.projectId);
			const task = await data.getTask(project, params.taskId);
			const resolved = await repoConfig.resolveProjectConfig(project, task.worktreePath ?? undefined);

			if (!resolved.devScript.trim()) throw new Error("No dev script configured");
			if (!task.worktreePath) throw new Error("Task has no worktree");

			const devSession = devServerSessionName(task.id);
			const devScriptPath = `/tmp/dev3-${task.id}-dev.sh`;
			const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;

			// Kill existing dev server session if still alive
			if (await isDevServerRunning(task.id, socket)) {
				await killDevServerSession(task.id, socket);
			}

			const wrappedScript = [
				`#!/bin/bash`,
				`set -x`,
				resolved.devScript,
				`EXIT_CODE=$?`,
				`set +x`,
				`if [ $EXIT_CODE -ne 0 ]; then`,
				`  echo ""`,
				`  echo "Process exited with code $EXIT_CODE. Press any key to close."`,
				`  read -n 1 -s`,
				`fi`,
			].join("\n") + "\n";
			await Bun.write(devScriptPath, wrappedScript);

			const proc = spawn(pty.tmuxArgs(socket,
				"new-session", "-d",
				"-s", devSession,
				"-c", task.worktreePath,
				`bash "${devScriptPath}"`,
			), { stdout: "pipe", stderr: "pipe" });
			const stderrOutput = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (stderrOutput.trim()) {
				log.warn("runDevServer tmux stderr", { taskId: task.id.slice(0, 8), stderr: stderrOutput.trim() });
			}
			if (exitCode !== 0) {
				log.error("runDevServer tmux exited with non-zero code", { taskId: task.id.slice(0, 8), exitCode, stderr: stderrOutput.trim() });
				throw new Error(`tmux new-session failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
			}

			// Create a viewer pane in the task session that nests the dev server session.
			// TMUX= bypasses the nesting guard so attach works from inside another session.
			// Must include -L <socket> so the attach targets the same tmux server.
			// The trap EXIT kills the dev session when the viewer pane is closed manually —
			// but killDevServerSession kills this pane FIRST (via devViewerPaneIds or a
			// list-panes scan) so the trap never fires during a restart.
			const taskSession = `dev3-${task.id.slice(0, 8)}`;
			const tmuxKill = socket
				? `tmux -L "${socket}" kill-session -t "${devSession}" 2>/dev/null`
				: `tmux kill-session -t "${devSession}" 2>/dev/null`;
			const attachCmd = socket
				? `bash -c 'trap "${tmuxKill}" EXIT; TMUX= tmux -L "${socket}" attach-session -t "${devSession}"'`
				: `bash -c 'trap "${tmuxKill}" EXIT; TMUX= tmux attach-session -t "${devSession}"'`;
			const viewerProc = spawn(pty.tmuxArgs(socket,
				"split-window", "-h",
				"-t", taskSession,
				"-c", task.worktreePath,
				"-l", "50%",
				"-P", "-F", "#{pane_id}",
				attachCmd,
			), { stdout: "pipe", stderr: "pipe" });
			const viewerOut = await new Response(viewerProc.stdout).text();
			await viewerProc.exited;
			const viewerPaneId = viewerOut.trim();

			if (viewerPaneId) {
				// Track so killDevServerSession can kill this pane before the dev session
				devViewerPaneIds.set(task.id, viewerPaneId);
				// Label the pane so the user knows Ctrl+b is captured by the outer session
				// Fire-and-forget: these are instant tmux commands, no need to block the handler
				spawn(pty.tmuxArgs(socket, "select-pane", "-t", viewerPaneId, "-T", "Dev Server  (Ctrl+b Ctrl+b to control inner)")).exited.catch(() => {});
				// Enable pane border titles for the task session
				spawn(pty.tmuxArgs(socket, "set-option", "-t", taskSession, "pane-border-status", "top")).exited.catch(() => {});
			}

			log.info("← runDevServer done", { devSession, viewerPaneId });
		} catch (err) {
			log.error("runDevServer FAILED", {
				taskId: params.taskId.slice(0, 8),
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
			throw err;
		}
	},

	async checkDevServer(params: { taskId: string; projectId: string }): Promise<{ running: boolean }> {
		log.info("→ checkDevServer", params);
		try {
			const project = await data.getProject(params.projectId);
			const task = await data.getTask(project, params.taskId);
			const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
			const running = await isDevServerRunning(task.id, socket);
			log.info("← checkDevServer", { running });
			return { running };
		} catch {
			return { running: false };
		}
	},

	async stopDevServer(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ stopDevServer", params);
		try {
			const project = await data.getProject(params.projectId);
			const task = await data.getTask(project, params.taskId);
			const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
			await killDevServerSession(task.id, socket);
			// Remove pane border titles from the task session now that the viewer pane is gone
			const taskSession = `dev3-${task.id.slice(0, 8)}`;
			spawn(pty.tmuxArgs(socket, "set-option", "-t", taskSession, "pane-border-status", "off")).exited.catch(() => {});
			log.info("← stopDevServer done");
		} catch (err) {
			log.error("stopDevServer FAILED", {
				taskId: params.taskId.slice(0, 8),
				error: String(err),
			});
			throw err;
		}
	},

	async openFileBrowser(params: { taskId: string; projectId: string }): Promise<{ notInstalled: true; installCommand: string; linuxHint?: boolean } | void> {
		log.info("→ openFileBrowser", params);
		try {
			// Check if yazi is available
			const yaziCheck = spawnSync(["which", "yazi"]);
			if (yaziCheck.exitCode !== 0) {
				const brewCmd = "brew install yazi ffmpegthumbnailer sevenzip jq poppler fd ripgrep fzf zoxide imagemagick chafa";
				const installCommand = process.platform === "win32"
					? "scoop install yazi ffmpeg 7zip jq poppler fd ripgrep fzf zoxide imagemagick chafa"
					: brewCmd;
				const linuxHint = process.platform === "linux";
				log.info("← openFileBrowser: yazi not installed", { platform: process.platform });
				return { notInstalled: true, installCommand, linuxHint };
			}

			const project = await data.getProject(params.projectId);
			const task = await data.getTask(project, params.taskId);

			if (!task.worktreePath) throw new Error("Task has no worktree");

			const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
			const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;

			// Toggle: if yazi pane already exists, kill it
			const existingPane = fileBrowserPaneIds.get(task.id);
			if (existingPane) {
				const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", existingPane));
				await kill.exited;
				fileBrowserPaneIds.delete(task.id);
				log.info("← openFileBrowser: toggled off (killed pane)", { taskId: task.id.slice(0, 8), paneId: existingPane });
				return;
			}

			// Check if any existing pane is running yazi (handles app restart losing map)
			const listProc = spawn(pty.tmuxArgs(socket,
				"list-panes", "-t", tmuxSession,
				"-F", "#{pane_id} #{pane_current_command}",
			), { stdout: "pipe", stderr: "pipe" });
			const listOutput = await new Response(listProc.stdout).text();
			await listProc.exited;
			for (const line of listOutput.trim().split("\n")) {
				if (line.includes("yazi")) {
					const paneId = line.split(" ")[0];
					const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", paneId));
					await kill.exited;
					log.info("← openFileBrowser: toggled off (found running yazi)", { taskId: task.id.slice(0, 8), paneId });
					return;
				}
			}

			// Open new horizontal split (bottom pane) with yazi
			const proc = spawn(pty.tmuxArgs(socket,
				"split-window", "-v",
				"-t", tmuxSession,
				"-c", task.worktreePath,
				"-l", "30%",
				"-P", "-F", "#{pane_id}",
				"yazi",
			), { stdout: "pipe", stderr: "pipe" });
			const output = await new Response(proc.stdout).text();
			const stderrOutput = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				log.error("openFileBrowser tmux failed", { taskId: task.id.slice(0, 8), exitCode, stderr: stderrOutput.trim() });
				throw new Error(`tmux split-window failed: ${stderrOutput.trim() || "unknown error"}`);
			}

			const paneId = output.trim();
			if (paneId) {
				fileBrowserPaneIds.set(task.id, paneId);
				log.info("← openFileBrowser done", { paneId });
			} else {
				log.info("← openFileBrowser done (no pane id captured)");
			}
		} catch (err) {
			log.error("openFileBrowser FAILED", {
				taskId: params.taskId.slice(0, 8),
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
			throw err;
		}
	},

	async getBranchStatus(params: { taskId: string; projectId: string; compareRef?: string }) {
		log.info("→ getBranchStatus", params);

		// Dedup: reuse in-flight request for the same task to prevent stampedes
		// (renderer can fire dozens of duplicate calls on reconnect/wake).
		const dedupKey = `${params.taskId}:${params.compareRef ?? ""}`;
		const existing = branchStatusInFlight.get(dedupKey);
		if (existing) {
			log.debug("getBranchStatus: reusing in-flight request", { taskId: params.taskId });
			return existing;
		}

		const promise = getBranchStatusImpl(params);
		branchStatusInFlight.set(dedupKey, promise);
		try {
			return await promise;
		} finally {
			branchStatusInFlight.delete(dedupKey);
		}
	},

	async rebaseTask(params: { taskId: string; projectId: string; compareRef?: string }): Promise<void> {
		log.info("→ rebaseTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) throw new Error("Task has no worktree");

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		const rebaseTarget = params.compareRef || `origin/${baseBranch}`;
		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-rebase.sh`;

		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const script = [
			`#!/bin/bash`,
			`echo "Fetching origin..."`,
			`git fetch origin --quiet`,
			`echo "Rebasing on ${rebaseTarget}..."`,
			`set -x`,
			`git rebase ${rebaseTarget}`,
			`EXIT_CODE=$?`,
			`set +x`,
			`echo $EXIT_CODE > "${scriptPath}.exit"`,
			`echo ""`,
			`if [ $EXIT_CODE -eq 0 ]; then`,
			`  printf '\\033[1;32m✓ Rebase complete\\033[0m\\n'`,
			`  sleep 5`,
			`else`,
			`  printf '\\033[1;31m✗ Rebase failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
			`  echo "Resolve conflicts in the main terminal, then: git rebase --continue"`,
			`  echo "Or abort with: git rebase --abort"`,
			`  echo ""`,
			`  echo "Press any key to close this pane."`,
			`  read -n 1 -s`,
			`fi`,
		].join("\n") + "\n";
		await Bun.write(scriptPath, script);

		const paneId = await openGitOpPane(tmuxSession, task.worktreePath, scriptPath, socket);
		if (paneId) gitOpPaneIds.set(task.id, paneId);
		monitorGitPane(paneId, task.id, params.projectId, "rebase", socket);

		log.info("← rebaseTask (pane opened)", { paneId });
	},

	async mergeTask(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ mergeTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) throw new Error("Task has no worktree");

		// Resolve live branch name — it may differ from task.branchName after rename
		const liveBranch = await git.getCurrentBranch(task.worktreePath);
		const branchForMerge = liveBranch ?? task.branchName;
		if (!branchForMerge) throw new Error("Task has no branch");

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		await git.fetchOrigin(project.path);
		const status = await git.getBranchStatus(task.worktreePath, `origin/${baseBranch}`);
		if (status.behind > 0) throw new Error("Branch is not rebased — rebase first");

		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-merge.sh`;

		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const escapedPath = project.path.replace(/'/g, "'\\''");
		const escapedTitle = task.title.replace(/'/g, "'\\''");

		const script = [
			`#!/bin/bash`,
			`cd '${escapedPath}'`,
			`echo "Squash-merging ${branchForMerge} into $(git branch --show-current)..."`,
			`set -x`,
			`git merge --squash ${branchForMerge}`,
			`MERGE_CODE=$?`,
			`set +x`,
			`if [ $MERGE_CODE -ne 0 ]; then`,
			`  echo $MERGE_CODE > "${scriptPath}.exit"`,
			`  echo ""`,
			`  printf '\\033[1;31m✗ Merge failed (exit %s)\\033[0m\\n' "$MERGE_CODE"`,
			`  echo "Press any key to close."`,
			`  read -n 1 -s`,
			`  exit $MERGE_CODE`,
			`fi`,
			`set -x`,
			`git commit -m '${escapedTitle}'`,
			`EXIT_CODE=$?`,
			`set +x`,
			`echo $EXIT_CODE > "${scriptPath}.exit"`,
			`echo ""`,
			`if [ $EXIT_CODE -eq 0 ]; then`,
			`  printf '\\033[1;32m✓ Merge complete\\033[0m\\n'`,
			`  sleep 5`,
			`else`,
			`  printf '\\033[1;31m✗ Commit failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
			`  echo "Press any key to close."`,
			`  read -n 1 -s`,
			`fi`,
		].join("\n") + "\n";
		await Bun.write(scriptPath, script);

		const paneId = await openGitOpPane(tmuxSession, project.path, scriptPath, socket);
		if (paneId) gitOpPaneIds.set(task.id, paneId);
		monitorGitPane(paneId, task.id, params.projectId, "merge", socket);

		log.info("← mergeTask (pane opened)", { paneId });
	},

	async pushTask(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ pushTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) throw new Error("Task has no worktree");

		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-push.sh`;

		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const script = [
			`#!/bin/bash`,
			`set -x`,
			`git push origin HEAD`,
			`EXIT_CODE=$?`,
			`set +x`,
			`echo $EXIT_CODE > "${scriptPath}.exit"`,
			`echo ""`,
			`if [ $EXIT_CODE -eq 0 ]; then`,
			`  printf '\\033[1;32m✓ Push complete\\033[0m\\n'`,
			`  sleep 2`,
			`else`,
			`  printf '\\033[1;31m✗ Push failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
			`  echo "Press any key to close."`,
			`  read -n 1 -s`,
			`fi`,
		].join("\n") + "\n";
		await Bun.write(scriptPath, script);

		const paneId = await openGitOpPane(tmuxSession, task.worktreePath, scriptPath, socket);
		if (paneId) gitOpPaneIds.set(task.id, paneId);
		monitorGitPane(paneId, task.id, params.projectId, "push", socket);

		log.info("← pushTask (pane opened)", { paneId });
	},

	async createPullRequest(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ createPullRequest", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) throw new Error("Task has no worktree");

		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-createPR.sh`;

		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";

		const script = [
			`#!/bin/bash`,
			`set -x`,
			`gh pr create --base "${baseBranch}" --fill --web 2>&1`,
			`EXIT_CODE=$?`,
			`set +x`,
			`if [ $EXIT_CODE -ne 0 ]; then`,
			`  echo ""`,
			`  printf '\\033[1;33m⚠ PR may already exist — trying to open it...\\033[0m\\n'`,
			`  set -x`,
			`  gh pr view --web 2>&1`,
			`  EXIT_CODE=$?`,
			`  set +x`,
			`fi`,
			`echo $EXIT_CODE > "${scriptPath}.exit"`,
			`echo ""`,
			`if [ $EXIT_CODE -eq 0 ]; then`,
			`  printf '\\033[1;32m✓ PR opened in browser\\033[0m\\n'`,
			`  sleep 5`,
			`else`,
			`  printf '\\033[1;31m✗ Failed to create or open PR (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
			`  echo "Press any key to close."`,
			`  read -n 1 -s`,
			`fi`,
		].join("\n") + "\n";
		await Bun.write(scriptPath, script);

		const paneId = await openGitOpPane(tmuxSession, task.worktreePath, scriptPath, socket);
		if (paneId) gitOpPaneIds.set(task.id, paneId);
		monitorGitPane(paneId, task.id, params.projectId, "createPR", socket);

		log.info("← createPullRequest (pane opened)", { paneId });
	},

	async openPullRequest(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ openPullRequest", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) throw new Error("Task has no worktree");

		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-openPR.sh`;

		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const script = [
			`#!/bin/bash`,
			`set -x`,
			`gh pr view --web 2>&1`,
			`EXIT_CODE=$?`,
			`set +x`,
			`echo $EXIT_CODE > "${scriptPath}.exit"`,
			`echo ""`,
			`if [ $EXIT_CODE -eq 0 ]; then`,
			`  printf '\\033[1;32m✓ PR opened in browser\\033[0m\\n'`,
			`  sleep 5`,
			`else`,
			`  printf '\\033[1;31m✗ Failed to open PR (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
			`  echo "Press any key to close."`,
			`  read -n 1 -s`,
			`fi`,
		].join("\n") + "\n";
		await Bun.write(scriptPath, script);

		const paneId = await openGitOpPane(tmuxSession, task.worktreePath, scriptPath, socket);
		if (paneId) gitOpPaneIds.set(task.id, paneId);
		monitorGitPane(paneId, task.id, params.projectId, "openPR", socket);

		log.info("← openPullRequest (pane opened)", { paneId });
	},

	async showDiff(params: { taskId: string; projectId: string; compareRef?: string }): Promise<void> {
		log.info("→ showDiff", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) throw new Error("Task has no worktree");

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		const ref = params.compareRef || `origin/${baseBranch}`;

		// Fetch fresh refs before showing diff (deduped, won't re-fetch within cooldown)
		await git.fetchOrigin(project.path);

		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-diff.sh`;

		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const script = [
			`#!/bin/bash`,
			`git diff --color=always ${ref}...HEAD | less -R`,
			`EXIT_CODE=\${PIPESTATUS[0]}`,
			`if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 141 ]; then`,
			`  printf '\\033[1;31m✗ git diff failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
			`  echo "Press any key to close."`,
			`  read -n 1 -s`,
			`fi`,
		].join("\n") + "\n";
		await Bun.write(scriptPath, script);

		const proc = spawn(pty.tmuxArgs(socket,
			"split-window", "-h",
			"-t", tmuxSession,
			"-c", task.worktreePath,
			"-P", "-F", "#{pane_id}",
			`bash "${scriptPath}"`,
		), { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(proc.stdout).text();
		const stderrOutput = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (stderrOutput.trim()) {
			log.warn("showDiff tmux stderr", { stderr: stderrOutput.trim() });
		}
		if (exitCode !== 0) {
			throw new Error(`tmux split-window failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
		}

		const paneId = output.trim() || null;
		if (paneId) gitOpPaneIds.set(task.id, paneId);
		log.info("← showDiff (pane opened)", { paneId });
	},

	async showUncommittedDiff(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ showUncommittedDiff", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) throw new Error("Task has no worktree");

		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-uncommitted-diff.sh`;

		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const script = [
			`#!/bin/bash`,
			`{ git diff --color=always --stat && echo "" && git diff --color=always; git diff --cached --color=always --stat && echo "" && git diff --cached --color=always; } | less -R`,
			`EXIT_CODE=\${PIPESTATUS[0]}`,
			`if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 141 ]; then`,
			`  printf '\\033[1;31m✗ git diff failed (exit %s)\\033[0m\\n' "$EXIT_CODE"`,
			`  echo "Press any key to close."`,
			`  read -n 1 -s`,
			`fi`,
		].join("\n") + "\n";
		await Bun.write(scriptPath, script);

		const proc = spawn(pty.tmuxArgs(socket,
			"split-window", "-h",
			"-t", tmuxSession,
			"-c", task.worktreePath,
			"-P", "-F", "#{pane_id}",
			`bash "${scriptPath}"`,
		), { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(proc.stdout).text();
		const stderrOutput = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (stderrOutput.trim()) {
			log.warn("showUncommittedDiff tmux stderr", { stderr: stderrOutput.trim() });
		}
		if (exitCode !== 0) {
			throw new Error(`tmux split-window failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
		}

		const paneId = output.trim() || null;
		if (paneId) gitOpPaneIds.set(task.id, paneId);
		log.info("← showUncommittedDiff (pane opened)", { paneId });
	},

	async getTerminalPreview(params: { taskId: string }): Promise<string | null> {
		return pty.capturePane(params.taskId);
	},

	async checkWorktreeExists(params: { path: string }): Promise<boolean> {
		return existsSync(params.path);
	},

	async getPtyUrl(params: { taskId: string; resume?: boolean }): Promise<string> {
		log.info("→ getPtyUrl", {
			taskId: params.taskId,
			hasExistingSession: pty.hasSession(params.taskId),
			ptyPort: pty.getPtyPort(),
		});

		// If resuming and the session is dead (proc exited but still in map),
		// destroy it so launchTaskPty recreates it with the resume flag.
		if (params.resume && pty.hasDeadSession(params.taskId)) {
			log.info("Resume requested on dead session — destroying to force recreation", {
				taskId: params.taskId.slice(0, 8),
			});
			pty.destroySession(params.taskId);
		}

		// If no PTY session in memory, try to recreate it from persisted task data
		if (!pty.hasSession(params.taskId)) {
			log.info("No PTY session in memory, attempting to restore", {
				taskId: params.taskId.slice(0, 8),
			});

			// Find the task across all projects
			let foundTask: Task | null = null;
			let foundProject: Project | null = null;
			try {
				const projects = await data.loadProjects();
				log.info("Loaded projects for task search", { count: projects.length });
				for (const project of projects) {
					try {
						const task = await data.getTask(project, params.taskId);
						foundTask = task;
						foundProject = project;
						log.info("Found task in project", {
							taskId: params.taskId.slice(0, 8),
							projectId: project.id.slice(0, 8),
							taskStatus: task.status,
							worktreePath: task.worktreePath,
						});
						break;
					} catch {
						// task not in this project
					}
				}
			} catch (err) {
				log.error("Failed to load projects during PTY restore", {
					taskId: params.taskId.slice(0, 8),
					error: String(err),
					stack: (err as Error)?.stack ?? "no stack",
				});
			}

			if (foundTask && foundProject && isActive(foundTask.status) && foundTask.worktreePath) {
				try {
					log.info("Attempting to restore PTY session", {
						taskId: params.taskId.slice(0, 8),
						status: foundTask.status,
						worktreePath: foundTask.worktreePath,
					});
					await launchTaskPty(foundProject, foundTask, foundTask.worktreePath, foundTask.agentId, foundTask.configId, false, params.resume ?? false);
					log.info("Restored PTY session for active task", {
						taskId: params.taskId.slice(0, 8),
						worktreePath: foundTask.worktreePath,
					});
				} catch (err) {
					log.error("Failed to restore PTY session", {
						taskId: params.taskId.slice(0, 8),
						error: String(err),
						stack: (err as Error)?.stack ?? "no stack",
					});
				}
			} else {
				log.warn("Cannot restore PTY session: task not active or no worktree", {
					taskId: params.taskId.slice(0, 8),
					found: !!foundTask,
					status: foundTask?.status ?? "not found",
					worktreePath: foundTask?.worktreePath ?? "none",
					isActiveStatus: foundTask ? isActive(foundTask.status) : false,
				});
			}
		}

		const url = `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
		log.info("← getPtyUrl", {
			url,
			sessionExists: pty.hasSession(params.taskId),
		});
		return url;
	},

	async resolveFilename(params: { filename: string; size: number; lastModified: number }): Promise<string | null> {
		// WKWebView doesn't expose native file paths via drag-and-drop.
		// Use Spotlight (mdfind) to find the full path by filename.
		// Search only common user directories to avoid triggering macOS TCC
		// permission prompts for protected folders (Music, Photos, etc.).
		const home = homedir();
		const searchDirs = [
			`${home}/Desktop`,
			`${home}/Downloads`,
			`${home}/Documents`,
			`${home}/Projects`,
			`${home}/src`,
			`${home}/dev`,
			`${home}/work`,
			`${home}/code`,
			"/tmp",
		].filter((d) => {
			try { return statSync(d).isDirectory(); } catch { return false; }
		});

		const query = `kMDItemFSName == "${params.filename}"`;
		const candidates: string[] = [];
		for (const dir of searchDirs) {
			const proc = spawnSync(["mdfind", "-onlyin", dir, query]);
			const out = proc.stdout.toString().trim();
			if (out) candidates.push(...out.split("\n"));
		}
		if (candidates.length === 0) return null;
		if (candidates.length === 1) return candidates[0];

		// Multiple candidates — verify by size and lastModified
		const sizeMatches: string[] = [];
		for (const path of candidates) {
			try {
				const file = Bun.file(path);
				if (file.size === params.size) {
					sizeMatches.push(path);
				}
			} catch {
				// File inaccessible, skip
			}
		}

		if (sizeMatches.length === 1) return sizeMatches[0];

		// Multiple size matches — narrow down by lastModified
		const pool = sizeMatches.length > 0 ? sizeMatches : candidates;
		for (const path of pool) {
			try {
				const file = Bun.file(path);
				if (file.lastModified === params.lastModified) {
					return path;
				}
			} catch {
				// File inaccessible, skip
			}
		}

		// Fallback: first size match, or first mdfind result
		return sizeMatches[0] ?? candidates[0];
	},

	async checkForUpdate(): Promise<{ updateAvailable: boolean; version: string; error?: string }> {
		log.info("-> checkForUpdate");
		const settings = await loadSettings();
		const result = await updater.checkForUpdateWithChannel(settings.updateChannel);
		log.info("<- checkForUpdate", { ...result });
		return result;
	},

	async downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
		log.info("-> downloadUpdate");
		const settings = await loadSettings();
		const result = await updater.downloadUpdateForChannel(
			settings.updateChannel,
			(status, progress) => {
				pushMessage?.("updateDownloadProgress", { status, progress });
			},
		);
		log.info("<- downloadUpdate", result);
		return result;
	},

	async applyUpdate(): Promise<void> {
		log.info("-> applyUpdate");
		await updater.applyUpdate();
	},

	async saveUpdateRoute({ route }: { route: string }): Promise<void> {
		log.info("-> saveUpdateRoute");
		await data.saveUpdateRoute(route);
	},

	async getUpdateRoute(): Promise<{ route: string | null }> {
		log.info("-> getUpdateRoute");
		const route = await data.loadAndClearUpdateRoute();
		return { route };
	},

	async getAppVersion(): Promise<{ version: string; channel: string; buildChannel: string }> {
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
	},

	async getChangelogs(): Promise<ChangelogEntry[]> {
		log.info("-> getChangelogs");

		// Find project root (same pattern as "rebuild" menu handler)
		let root = import.meta.dir ?? "";
		for (let i = 0; i < 20 && root; i++) {
			if (existsSync(join(root, "vite.config.ts"))) break;
			const parent = dirname(root);
			if (parent === root) break;
			root = parent;
		}

		const changeLogsDir = join(root, "change-logs");
		if (!existsSync(changeLogsDir)) {
			// Production fallback 1: try reading changelog.json from the app bundle
			const prodJson = PATHS.VIEWS_FOLDER ? join(PATHS.VIEWS_FOLDER, "..", "changelog.json") : "";
			const metaDir = import.meta.dir ?? "";
			const devJson = metaDir ? join(metaDir, "..", "changelog.json") : "";
			const jsonPath = (prodJson && existsSync(prodJson)) ? prodJson : devJson;
			if (existsSync(jsonPath)) {
				const entries: ChangelogEntry[] = JSON.parse(await Bun.file(jsonPath).text());
				log.info("<- getChangelogs (from bundled JSON)", { count: entries.length });
				return entries;
			}
			// Production fallback 2: use build-time inlined data.
			// Electrobun 1.14+ packs app resources into a tar archive, so filesystem
			// reads fail. BUNDLED_CHANGELOG is generated by scripts/generate-changelog.ts
			// and inlined by the Bun bundler at build time.
			if (BUNDLED_CHANGELOG.length > 0) {
				log.info("<- getChangelogs (from bundled TS data)", { count: BUNDLED_CHANGELOG.length });
				return BUNDLED_CHANGELOG;
			}
			log.info("<- getChangelogs (no change-logs dir, no bundled data)");
			return [];
		}

		const entries: ChangelogEntry[] = [];

		// Scan YYYY/MM/DD structure
		for (const year of readdirSync(changeLogsDir)) {
			const yearPath = join(changeLogsDir, year);
			if (!/^\d{4}$/.test(year)) continue;
			for (const month of readdirSync(yearPath)) {
				const monthPath = join(yearPath, month);
				if (!/^\d{2}$/.test(month)) continue;
				for (const day of readdirSync(monthPath)) {
					const dayPath = join(monthPath, day);
					if (!/^\d{2}$/.test(day)) continue;
					for (const file of readdirSync(dayPath)) {
						if (!file.endsWith(".md") || file === "README.md") continue;
						const basename = file.replace(/\.md$/, "");
						const dashIdx = basename.indexOf("-");
						if (dashIdx === -1) continue;
						const type = basename.slice(0, dashIdx);
						const slug = basename.slice(dashIdx + 1);

						// Read content and extract metadata
						const content = await Bun.file(join(dayPath, file)).text();

						// Extract "Suggested by @username (owner/repo#N)" from any line
						let suggestedBy: string | undefined;
						let issueUrl: string | undefined;
						let issueRef: string | undefined;
						const creditMatch = content.match(/Suggested by @(\S+)\s+\(([^)]+)\)/);
						if (creditMatch) {
							suggestedBy = creditMatch[1];
							const ref = creditMatch[2];
							// ref is like "h0x91b/dev-3.0#191"
							const refMatch = ref.match(/^(.+?)#(\d+)$/);
							if (refMatch) {
								issueRef = `#${refMatch[2]}`;
								issueUrl = `https://github.com/${refMatch[1]}/issues/${refMatch[2]}`;
							}
						}

						// Strip the "Suggested by" line from content before extracting title
						const cleanContent = content.replace(/\n*Suggested by @\S+\s+\([^)]+\)\s*$/, "").trim();
						const firstSentence = cleanContent.split(/\.(?:\s|$)/)[0]?.trim() ?? slug;
						const title = firstSentence.length > 120
							? firstSentence.slice(0, 117) + "..."
							: firstSentence;

						entries.push({
							date: `${year}-${month}-${day}`,
							type,
							slug,
							title: title || slug,
							...(suggestedBy && { suggestedBy }),
							...(issueUrl && { issueUrl }),
							...(issueRef && { issueRef }),
						});
					}
				}
			}
		}

		entries.sort((a, b) => b.date.localeCompare(a.date));
		log.info("<- getChangelogs", { count: entries.length });
		return entries;
	},

	async getTaskPorts(params: { taskId: string }): Promise<PortInfo[]> {
		log.info("→ getTaskPorts", { taskId: params.taskId.slice(0, 8) });
		const ports = getPortsForTask(params.taskId);
		log.info("← getTaskPorts", { taskId: params.taskId.slice(0, 8), count: ports.length });
		return ports;
	},

	async listTmuxSessions(): Promise<TmuxSessionInfo[]> {
		log.info("→ listTmuxSessions");

		// Build shortId → { taskTitle, taskId, projectId } map from all projects/tasks
		const taskMap = new Map<string, { title: string; taskId: string; projectId: string }>();
		try {
			const projects = await data.loadProjects();
			for (const project of projects) {
				const tasks = await data.loadTasks(project);
				for (const task of tasks) {
					taskMap.set(task.id.slice(0, 8), {
						title: task.title,
						taskId: task.id,
						projectId: project.id,
					});
				}
			}
		} catch {
			// Best effort — if loading fails, we just won't have titles
		}

		const FORMAT = "#{session_name}|#{pane_current_path}|#{session_windows}|#{session_created}";
		// Use -L dev3 explicitly so tmux ignores the inherited TMUX env var and always
		// queries the correct socket server regardless of where the app was launched from.
		const proc = spawn(pty.tmuxArgs("dev3", "list-sessions", "-F", FORMAT), { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			log.info("← listTmuxSessions (no tmux server or error)");
			return [];
		}

		const sessions: TmuxSessionInfo[] = [];
		for (const line of output.trim().split("\n")) {
			if (!line) continue;
			const [name, cwd, windowsStr, createdStr] = line.split("|");
			if (!name.startsWith("dev3-")) continue;
		if (name.startsWith("dev3-dev-")) continue; // dev server sessions are internal, not user-visible

			const isCleanup = name.startsWith("dev3-cl-");
			const shortId = isCleanup ? name.slice(8) : name.slice(5);
			const taskInfo = taskMap.get(shortId);

			sessions.push({
				name,
				cwd: cwd || "",
				createdAt: parseInt(createdStr, 10) || 0,
				windowCount: parseInt(windowsStr, 10) || 1,
				isCleanup,
				taskTitle: taskInfo?.title,
				taskId: taskInfo?.taskId,
				projectId: taskInfo?.projectId,
				ports: taskInfo?.taskId ? getPortsForTask(taskInfo.taskId) : undefined,
			});
		}

		sessions.sort((a, b) => b.createdAt - a.createdAt);
		log.info("← listTmuxSessions", { count: sessions.length });
		return sessions;
	},

	async killTmuxSession(params: { sessionName: string }): Promise<void> {
		log.info("→ killTmuxSession", { sessionName: params.sessionName });
		if (!params.sessionName.startsWith("dev3-")) {
			throw new Error("Can only kill dev3-* sessions");
		}
		const proc = spawn(
			pty.tmuxArgs("dev3", "kill-session", "-t", params.sessionName),
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			log.error("killTmuxSession failed", { sessionName: params.sessionName, stderr: stderr.trim() });
			throw new Error(`Failed to kill session: ${stderr.trim()}`);
		}

		// If this was a task session (dev3-<id>), also kill the associated dev server session
		if (!params.sessionName.startsWith("dev3-dev-")) {
			const devSession = `dev3-dev-${params.sessionName.slice("dev3-".length)}`;
			const devKill = spawn(pty.tmuxArgs("dev3", "kill-session", "-t", devSession), { stdout: "pipe", stderr: "pipe" });
			await devKill.exited; // best-effort: ignore exit code
			log.info("killTmuxSession: killed dev server session (best-effort)", { devSession });
		}

		log.info("← killTmuxSession done", { sessionName: params.sessionName });
	},

	async checkSystemRequirements(): Promise<RequirementCheckResult[]> {
		log.info("-> checkSystemRequirements", { PATH: process.env.PATH });
		const settings = await loadSettings();
		const results: RequirementCheckResult[] = SYSTEM_REQUIREMENTS.map((req) => {
			const customPath = settings.customBinaryPaths?.[req.id];
			const { resolvedPath, customPathError } = resolveBinaryPath(req.checkCommand, customPath);

			if (resolvedPath) {
				log.info(`  ${req.id}: found`, { path: resolvedPath });
			} else {
				log.warn(`  ${req.id}: NOT found anywhere`);
			}

			return {
				id: req.id,
				name: req.name,
				installed: !!resolvedPath,
				resolvedPath,
				installHint: req.installHint,
				installCommand: req.installCommand,
				brewInstallable: req.brewInstallable,
				customPathError,
				...((req as any).optional ? { optional: true } : {}),
			};
		});

		// Update tmux binary path in PTY server if found
		const tmuxResult = results.find((r) => r.id === "tmux");
		if (tmuxResult?.resolvedPath) {
			pty.setTmuxBinary(tmuxResult.resolvedPath);
			log.info("tmux binary set to", { path: tmuxResult.resolvedPath });
		}

		log.info("<- checkSystemRequirements", { results: results.map((r) => `${r.id}:${r.installed}:${r.resolvedPath ?? "none"}`) });
		return results;
	},

	async checkGhAvailable(): Promise<{ available: boolean; notInstalled: boolean }> {
		log.info("-> checkGhAvailable");
		const whichResult = spawnSync(["which", "gh"]);
		if (whichResult.exitCode !== 0) {
			log.info("<- checkGhAvailable: gh not installed");
			return { available: false, notInstalled: true };
		}
		const authResult = spawnSync(["gh", "auth", "status"]);
		const available = authResult.exitCode === 0;
		log.info("<- checkGhAvailable", { available });
		return { available, notInstalled: false };
	},

	async setCustomBinaryPath(params: { requirementId: string; path: string }): Promise<void> {
		log.info("-> setCustomBinaryPath", params);
		const settings = await loadSettings();
		const paths = settings.customBinaryPaths ?? {};
		paths[params.requirementId] = params.path;
		await saveSettings({ ...settings, customBinaryPaths: paths });
		log.info("<- setCustomBinaryPath saved");
	},

	async checkAgentAvailability(): Promise<AgentCheckResult[]> {
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

		// Auto-save resolved paths for agents that were found
		const pathsToSave: Record<string, string> = { ...(settings.agentBinaryPaths ?? {}) };
		let changed = false;
		for (const r of results) {
			if (r.resolvedPath && pathsToSave[r.agentId] !== r.resolvedPath) {
				pathsToSave[r.agentId] = r.resolvedPath;
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
	},

	async setAgentBinaryPath(params: { agentId: string; path: string }): Promise<void> {
		log.info("-> setAgentBinaryPath", params);
		if (!existsSync(params.path)) {
			throw new Error(`File not found: ${params.path}`);
		}
		const settings = await loadSettings();
		const paths = settings.agentBinaryPaths ?? {};
		paths[params.agentId] = params.path;
		await saveSettings({ ...settings, agentBinaryPaths: paths });
		log.info("<- setAgentBinaryPath saved");
	},

	async createLabel(params: { projectId: string; name: string; color?: string }): Promise<Label> {
		log.info("→ createLabel", { projectId: params.projectId, name: params.name });
		const project = await data.getProject(params.projectId);
		const labels = project.labels ?? [];
		// Auto-pick next unused color from palette
		const usedColors = new Set(labels.map((l) => l.color));
		const color = params.color ?? LABEL_COLORS.find((c) => !usedColors.has(c)) ?? LABEL_COLORS[labels.length % LABEL_COLORS.length];
		const label: Label = {
			id: crypto.randomUUID(),
			name: params.name.trim(),
			color,
		};
		await data.updateProject(params.projectId, { labels: [...labels, label] });
		log.info("← createLabel done", { labelId: label.id });
		return label;
	},

	async updateLabel(params: { projectId: string; labelId: string; name?: string; color?: string }): Promise<Label> {
		log.info("→ updateLabel", { projectId: params.projectId, labelId: params.labelId });
		const project = await data.getProject(params.projectId);
		const labels = project.labels ?? [];
		const idx = labels.findIndex((l) => l.id === params.labelId);
		if (idx === -1) throw new Error(`Label not found: ${params.labelId}`);
		const updated: Label = {
			...labels[idx],
			...(params.name !== undefined ? { name: params.name.trim() } : {}),
			...(params.color !== undefined ? { color: params.color } : {}),
		};
		const newLabels = [...labels];
		newLabels[idx] = updated;
		await data.updateProject(params.projectId, { labels: newLabels });
		log.info("← updateLabel done", { labelId: updated.id });
		return updated;
	},

	async deleteLabel(params: { projectId: string; labelId: string }): Promise<void> {
		log.info("→ deleteLabel", { projectId: params.projectId, labelId: params.labelId });
		const project = await data.getProject(params.projectId);
		const newLabels = (project.labels ?? []).filter((l) => l.id !== params.labelId);
		await data.updateProject(params.projectId, { labels: newLabels });
		// Remove this labelId from all tasks in the project
		const tasks = await data.loadTasks(project);
		const affectedTasks = tasks.filter((t) => t.labelIds?.includes(params.labelId));
		for (const task of affectedTasks) {
			await data.updateTask(project, task.id, {
				labelIds: (task.labelIds ?? []).filter((id) => id !== params.labelId),
			});
		}
		log.info("← deleteLabel done", { removed_from_tasks: affectedTasks.length });
	},

	async createCustomColumn(params: { projectId: string; name: string; color?: string }): Promise<CustomColumn> {
		log.info("→ createCustomColumn", { projectId: params.projectId, name: params.name });
		const project = await data.getProject(params.projectId);
		const columns = project.customColumns ?? [];
		const usedColors = new Set(columns.map((c) => c.color));
		const color = params.color ?? LABEL_COLORS.find((c) => !usedColors.has(c)) ?? LABEL_COLORS[columns.length % LABEL_COLORS.length];
		const column: CustomColumn = {
			id: crypto.randomUUID(),
			name: params.name.trim(),
			color,
			llmInstruction: "",
		};
		await data.updateProject(params.projectId, { customColumns: [...columns, column] });
		pushMessage?.("projectUpdated", { project: await data.getProject(params.projectId) });
		log.info("← createCustomColumn done", { columnId: column.id });
		return column;
	},

	async updateCustomColumn(params: { projectId: string; columnId: string; name?: string; color?: string; llmInstruction?: string; agentConfig?: ColumnAgentConfig | null }): Promise<CustomColumn> {
		log.info("→ updateCustomColumn", { projectId: params.projectId, columnId: params.columnId });
		const project = await data.getProject(params.projectId);
		const columns = project.customColumns ?? [];
		const idx = columns.findIndex((c) => c.id === params.columnId);
		if (idx === -1) throw new Error(`Custom column not found: ${params.columnId}`);
		const updated: CustomColumn = {
			...columns[idx],
			...(params.name !== undefined ? { name: params.name.trim() } : {}),
			...(params.color !== undefined ? { color: params.color } : {}),
			...(params.llmInstruction !== undefined ? { llmInstruction: params.llmInstruction } : {}),
			...(params.agentConfig !== undefined ? { agentConfig: params.agentConfig ?? undefined } : {}),
		};
		const newColumns = [...columns];
		newColumns[idx] = updated;
		await data.updateProject(params.projectId, { customColumns: newColumns });
		pushMessage?.("projectUpdated", { project: await data.getProject(params.projectId) });
		log.info("← updateCustomColumn done", { columnId: updated.id });
		return updated;
	},

	async renameBuiltinColumn(params: { projectId: string; status: TaskStatus; name: string | null }): Promise<Project> {
		log.info("→ renameBuiltinColumn", { projectId: params.projectId, status: params.status, name: params.name });
		const project = await data.getProject(params.projectId);
		const labels = { ...(project.customStatusLabels ?? {}) };
		if (params.name === null || params.name.trim() === "") {
			delete labels[params.status];
		} else {
			labels[params.status] = params.name.trim();
		}
		const customStatusLabels = Object.keys(labels).length > 0 ? labels : undefined;
		await data.updateProject(params.projectId, { customStatusLabels });
		const updated = await data.getProject(params.projectId);
		pushMessage?.("projectUpdated", { project: updated });
		log.info("← renameBuiltinColumn done", { status: params.status });
		return updated;
	},

	async deleteCustomColumn(params: { projectId: string; columnId: string }): Promise<void> {
		log.info("→ deleteCustomColumn", { projectId: params.projectId, columnId: params.columnId });
		const project = await data.getProject(params.projectId);
		const newColumns = (project.customColumns ?? []).filter((c) => c.id !== params.columnId);
		await data.updateProject(params.projectId, { customColumns: newColumns });
		// Move tasks out of this custom column back to their built-in status
		const tasks = await data.loadTasks(project);
		const affectedTasks = tasks.filter((t) => t.customColumnId === params.columnId);
		for (const task of affectedTasks) {
			const updated = await data.updateTask(project, task.id, { customColumnId: null });
			pushMessage?.("taskUpdated", { projectId: params.projectId, task: updated });
		}
		pushMessage?.("projectUpdated", { project: await data.getProject(params.projectId) });
		log.info("← deleteCustomColumn done", { removed_from_tasks: affectedTasks.length });
	},

	async moveTaskToCustomColumn(params: { taskId: string; projectId: string; customColumnId: string | null }): Promise<Task> {
		log.info("→ moveTaskToCustomColumn", params);
		const project = await data.getProject(params.projectId);
		let column: CustomColumn | undefined;
		if (params.customColumnId !== null) {
			column = (project.customColumns ?? []).find((c) => c.id === params.customColumnId);
			if (!column) throw new Error(`Custom column not found: ${params.customColumnId}`);
		}
		const task = await data.getTask(project, params.taskId);

		// Moving from completed/cancelled into a custom column resumes the task (same as reopening to an active status)
		if (params.customColumnId !== null && (task.status === "completed" || task.status === "cancelled")) {
			log.info("Reopening task into custom column, creating worktree + PTY", { taskId: task.id });
			const settings = await loadSettings();
			const wt = await activateTask(project, task, { isReopen: true });
			const updated = await data.updateTask(project, task.id, {
				status: "in-progress",
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
				customColumnId: params.customColumnId,
			}, { dropPosition: settings.taskDropPosition });
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			// Trigger column agent if configured
			if (column?.agentConfig && updated.worktreePath) {
				await triggerColumnAgentIfNeeded(updated.status, project, updated, { customColumn: column });
			}
			log.info("← moveTaskToCustomColumn done (reopened)", { taskId: params.taskId });
			return updated;
		}

		const updated = await data.updateTask(project, params.taskId, { customColumnId: params.customColumnId });
		pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
		// Trigger column agent if configured
		if (column?.agentConfig && updated.worktreePath) {
			await triggerColumnAgentIfNeeded(updated.status, project, updated, { customColumn: column });
		}
		log.info("← moveTaskToCustomColumn done", { taskId: params.taskId, customColumnId: params.customColumnId });
		return updated;
	},

	async reorderColumns(params: { projectId: string; columnOrder: string[] }): Promise<Project> {
		log.info("→ reorderColumns", { projectId: params.projectId, columnOrder: params.columnOrder });
		const project = await data.getProject(params.projectId);
		const existing = project.customColumns ?? [];
		// Reorder customColumns to match their position in the new columnOrder
		const reordered = params.columnOrder
			.map((id) => existing.find((c) => c.id === id))
			.filter((c): c is CustomColumn => c !== undefined);
		// Append any custom columns not present in columnOrder (safety net)
		for (const col of existing) {
			if (!reordered.find((c) => c.id === col.id)) reordered.push(col);
		}
		const updated = await data.updateProject(params.projectId, {
			customColumns: reordered,
			columnOrder: params.columnOrder,
		});
		pushMessage?.("projectUpdated", { project: updated });
		log.info("← reorderColumns done", { count: reordered.length });
		return updated;
	},

	async setTaskLabels(params: { taskId: string; projectId: string; labelIds: string[] }): Promise<Task> {
		log.info("→ setTaskLabels", { taskId: params.taskId, labelIds: params.labelIds });
		const project = await data.getProject(params.projectId);
		const task = await data.updateTask(project, params.taskId, { labelIds: params.labelIds });
		log.info("← setTaskLabels done", { taskId: params.taskId });
		return task;
	},

	async addTaskNote(params: { taskId: string; projectId: string; content: string; source?: NoteSource }): Promise<Task> {
		log.info("→ addTaskNote", { taskId: params.taskId });
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const now = new Date().toISOString();
		const note: TaskNote = {
			id: crypto.randomUUID(),
			content: params.content,
			source: params.source ?? "user",
			createdAt: now,
			updatedAt: now,
		};
		const notes = [...(task.notes ?? []), note];
		const updated = await data.updateTask(project, params.taskId, { notes });
		log.info("← addTaskNote done", { taskId: params.taskId, noteId: note.id });
		return updated;
	},

	async updateTaskNote(params: { taskId: string; projectId: string; noteId: string; content: string }): Promise<Task> {
		log.info("→ updateTaskNote", { taskId: params.taskId, noteId: params.noteId });
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const notes = (task.notes ?? []).map(n =>
			n.id === params.noteId
				? { ...n, content: params.content, updatedAt: new Date().toISOString() }
				: n
		);
		const updated = await data.updateTask(project, params.taskId, { notes });
		log.info("← updateTaskNote done", { taskId: params.taskId, noteId: params.noteId });
		return updated;
	},

	async deleteTaskNote(params: { taskId: string; projectId: string; noteId: string }): Promise<Task> {
		log.info("→ deleteTaskNote", { taskId: params.taskId, noteId: params.noteId });
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const notes = (task.notes ?? []).filter(n => n.id !== params.noteId);
		const updated = await data.updateTask(project, params.taskId, { notes });
		log.info("← deleteTaskNote done", { taskId: params.taskId, noteId: params.noteId });
		return updated;
	},

	async tmuxAction(params: { taskId: string; action: "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" }): Promise<void> {
		log.info("→ tmuxAction", { taskId: params.taskId.slice(0, 8), action: params.action });
		const socket = pty.getSessionSocket(params.taskId);
		const tmuxSession = `dev3-${params.taskId.slice(0, 8)}`;

		let args: string[];
		switch (params.action) {
			case "splitH":
				args = pty.tmuxArgs(socket, "split-window", "-v", "-c", "#{pane_current_path}", "-t", tmuxSession);
				break;
			case "splitV":
				args = pty.tmuxArgs(socket, "split-window", "-h", "-c", "#{pane_current_path}", "-t", tmuxSession);
				break;
			case "zoom":
				args = pty.tmuxArgs(socket, "resize-pane", "-Z", "-t", tmuxSession);
				break;
			case "killPane":
				args = pty.tmuxArgs(socket, "kill-pane", "-t", tmuxSession);
				break;
			case "nextPane":
				args = pty.tmuxArgs(socket, "select-pane", "-t", `${tmuxSession}:.+`);
				break;
			case "prevPane":
				args = pty.tmuxArgs(socket, "select-pane", "-t", `${tmuxSession}:.-`);
				break;
			case "newWindow":
				args = pty.tmuxArgs(socket, "new-window", "-c", "#{pane_current_path}", "-t", tmuxSession);
				break;
		}

		const proc = spawn(args, { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			log.error("tmuxAction failed", { action: params.action, exitCode, stderr: stderr.trim() });
			throw new Error(`tmux ${params.action} failed: ${stderr.trim() || "unknown error"}`);
		}
		log.info("← tmuxAction done", { taskId: params.taskId.slice(0, 8), action: params.action });
	},

	async spawnAgentInTask(params: { taskId: string; projectId: string; agentId: string | null; configId: string | null }): Promise<void> {
		log.info("→ spawnAgentInTask", { taskId: params.taskId.slice(0, 8), agentId: params.agentId, configId: params.configId });

		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) {
			throw new Error("Task has no worktree — cannot spawn agent");
		}

		// Empty description = bare agent with all flags but no task prompt
		const ctx: agents.TemplateContext = {
			taskTitle: "",
			taskDescription: "",
			projectName: project.name,
			projectPath: project.path,
			worktreePath: task.worktreePath,
		};

		let tmuxCmd: string;
		let extraEnv: Record<string, string>;

		if (params.agentId) {
			const resolved = await agents.resolveCommandForAgent(params.agentId, params.configId, ctx);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
		} else {
			const resolved = await agents.resolveCommandForProject(
				project,
				task.title,
				task.description,
				task.worktreePath,
			);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
		}

		const dev3Bin = `${DEV3_HOME}/bin`;
		const currentPath = process.env.PATH || "";
		const pathWithDev3 = currentPath.includes(dev3Bin) ? currentPath : `${dev3Bin}:${currentPath}`;
		const env = { ...extraEnv, DEV3_TASK_ID: task.id, PATH: pathWithDev3 };

		const scriptPath = `/tmp/dev3-${task.id}-spawn-${Date.now()}.sh`;
		await Bun.write(scriptPath, buildCmdScript(tmuxCmd, env));

		const socket = pty.getSessionSocket(params.taskId);
		const tmuxSession = `dev3-${params.taskId.slice(0, 8)}`;

		const args = pty.tmuxArgs(socket, "split-window", "-h", "-c", task.worktreePath, "-t", tmuxSession, `bash "${scriptPath}"`);
		const proc = spawn(args, { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			log.error("spawnAgentInTask failed", { exitCode, stderr: stderr.trim() });
			throw new Error(`Failed to spawn agent: ${stderr.trim() || "unknown error"}`);
		}

		log.info("← spawnAgentInTask done", { taskId: params.taskId.slice(0, 8) });
	},

	async pasteClipboardImage(params: { projectId: string }): Promise<{ path: string } | null> {
		log.info("→ pasteClipboardImage", { projectId: params.projectId.slice(0, 8) });
		const formats = Utils.clipboardAvailableFormats();
		if (!formats.includes("image")) {
			log.info("← pasteClipboardImage: no image in clipboard");
			return null;
		}
		const pngData = Utils.clipboardReadImage();
		if (!pngData || pngData.length === 0) {
			log.warn("← pasteClipboardImage: clipboardReadImage returned empty");
			return null;
		}
		const project = await data.getProject(params.projectId);
		const slug = project.path.replace(/^\//, "").replaceAll("/", "-");
		const uploadsDir = `${DEV3_HOME}/worktrees/${slug}/uploads`;
		const mkdirProc = spawn(["mkdir", "-p", uploadsDir]);
		await mkdirProc.exited;
		const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
		const filename = `img-${Date.now()}-${hex}.png`;
		const fullPath = `${uploadsDir}/${filename}`;
		await Bun.write(fullPath, pngData);
		log.info("← pasteClipboardImage", { path: fullPath, size: pngData.length });
		return { path: fullPath };
	},

	async readImageBase64(params: { path: string }): Promise<{ dataUrl: string } | null> {
		log.info("→ readImageBase64", { path: params.path });
		if (!params.path.startsWith("/") || params.path.includes("..")) {
			log.warn("← readImageBase64: invalid path, rejected");
			return null;
		}
		try {
			const file = Bun.file(params.path);
			if (!(await file.exists())) {
				log.warn("← readImageBase64: file not found");
				return null;
			}
			const buffer = await file.arrayBuffer();
			const base64 = Buffer.from(buffer).toString("base64");
			const ext = params.path.split(".").pop()?.toLowerCase() ?? "png";
			const mimeMap: Record<string, string> = {
				png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
				gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
			};
			const mime = mimeMap[ext] ?? "image/png";
			return { dataUrl: `data:${mime};base64,${base64}` };
		} catch (err) {
			log.error("readImageBase64 failed", { error: String(err) });
			return null;
		}
	},

	async openImageFile(params: { path: string }): Promise<void> {
		log.info("→ openImageFile", { path: params.path });
		if (!params.path.startsWith("/") || params.path.includes("..")) {
			throw new Error("Invalid file path");
		}
		Utils.openPath(params.path);
	},

	async openFolder(params: { path: string }): Promise<void> {
		log.info("→ openFolder", { path: params.path });
		if (!params.path.startsWith("/") || params.path.includes("..")) {
			throw new Error("Invalid folder path");
		}
		Utils.openPath(params.path);
	},

	async openInApp(params: { appName: string; path: string }): Promise<void> {
		log.info("→ openInApp", { appName: params.appName, path: params.path });
		if (!params.path.startsWith("/") || params.path.includes("..")) {
			throw new Error("Invalid path");
		}
		if (!params.appName || params.appName.includes("/")) {
			throw new Error("Invalid app name");
		}
		// Finder: open the folder directly (not -R which reveals in parent)
		if (params.appName === "Finder") {
			spawn(["open", params.path], { stdout: "ignore", stderr: "ignore" });
			return;
		}
		spawn(["open", "-a", params.appName, params.path], { stdout: "ignore", stderr: "ignore" });
	},

	async getAvailableApps(): Promise<ExternalApp[]> {
		log.info("→ getAvailableApps");
		const settings = await loadSettings();
		const allApps = [...DEFAULT_EXTERNAL_APPS, ...(settings.externalApps ?? [])];

		// Check which apps are installed — parallel async spawn
		const checks = allApps.map(async (app): Promise<ExternalApp | null> => {
			// Finder and Terminal are always available on macOS
			if (app.id === "finder" || app.id === "terminal") return app;
			// Skip apps with empty macAppName (incomplete user config)
			if (!app.macAppName) return null;
			try {
				const proc = spawn(["open", "-Ra", app.macAppName], { stdout: "ignore", stderr: "ignore" });
				const code = await proc.exited;
				return code === 0 ? app : null;
			} catch {
				return null;
			}
		});
		const results = (await Promise.all(checks)).filter((a): a is ExternalApp => a !== null);
		log.info("← getAvailableApps", { count: results.length, apps: results.map((a) => a.name) });
		return results;
	},

	async listBranches(params: { projectId: string }): Promise<Array<{ name: string; isRemote: boolean }>> {
		const project = await data.getProject(params.projectId);
		return git.listBranches(project.path);
	},

	async fetchBranches(params: { projectId: string; forkRef?: string }): Promise<Array<{ name: string; isRemote: boolean }>> {
		const project = await data.getProject(params.projectId);
		if (params.forkRef) {
			// Parse "user:branch" format
			const colonIdx = params.forkRef.indexOf(":");
			if (colonIdx > 0) {
				const forkOwner = params.forkRef.slice(0, colonIdx);
				const branchName = params.forkRef.slice(colonIdx + 1);
				if (forkOwner && branchName) {
					await git.fetchFork(project.path, forkOwner, branchName);
				}
			}
		} else {
			await git.fetchOrigin(project.path);
		}
		return git.listBranches(project.path);
	},

	async getProjectCurrentBranch(params: { projectId: string }): Promise<{ branch: string | null; isBaseBranch: boolean }> {
		const project = await data.getProject(params.projectId);
		const branch = await git.getCurrentBranch(project.path);
		const isBaseBranch = !branch || branch === project.defaultBaseBranch;
		return { branch, isBaseBranch };
	},

	async getTipState(): Promise<TipState> {
		return data.loadTipState();
	},

	async updateTipState(params: Partial<TipState>): Promise<TipState> {
		return data.saveTipState(params);
	},

	async resetTipState(): Promise<TipState> {
		return data.resetTipState();
	},

	async getProjectPRs(params: { projectId: string }) {
		log.info("→ getProjectPRs", params);
		const project = await data.getProject(params.projectId);

		try {
			const result = await git.run(
				["gh", "pr", "list", "--state", "open", "--json", "number,headRefName,url", "--limit", "100"],
				project.path,
			);
			if (result.ok && result.stdout) {
				const prs = JSON.parse(result.stdout);
				if (Array.isArray(prs)) {
					const infos: PRInfo[] = [];
					for (const pr of prs) {
						if (typeof pr.number === "number" && typeof pr.headRefName === "string" && typeof pr.url === "string") {
							infos.push({ number: pr.number, url: pr.url, headRefName: pr.headRefName });
						}
					}
					log.info("← getProjectPRs", { count: infos.length });
					return infos;
				}
			}
		} catch (err) {
			log.warn("getProjectPRs failed (non-fatal)", { error: String(err) });
		}
		const empty: PRInfo[] = [];
		return empty;
	},

};
