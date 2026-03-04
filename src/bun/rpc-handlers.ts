import { existsSync } from "node:fs";
import { Utils } from "electrobun/bun";
import type { ChangelogEntry, CodingAgent, GlobalSettings, Label, NoteSource, Project, RequirementCheckResult, Task, TaskNote, TaskStatus, TmuxSessionInfo } from "../shared/types";
import { ACTIVE_STATUSES, LABEL_COLORS, titleFromDescription, extractRepoName } from "../shared/types";
import * as data from "./data";
import * as git from "./git";
import * as pty from "./pty-server";
import * as agents from "./agents";
import * as updater from "./updater";
import { loadSettings, saveSettings } from "./settings";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { spawn, spawnSync } from "./spawn";

const log = createLogger("rpc");

/**
 * Escape a string for safe use inside a double-quoted shell context.
 * Handles: ", $, `, \, !
 */
export function escapeForDoubleQuotes(s: string): string {
	return s.replace(/[\\"$`!]/g, "\\$&");
}

/**
 * Build a bash script that echoes the command and then exec's it.
 * Used when a setup script is present and the main command runs in a split pane.
 */
export function buildCmdScript(tmuxCmd: string): string {
	const escaped = escapeForDoubleQuotes(tmuxCmd);
	return [
		"#!/bin/bash",
		`echo "Starting: ${escaped}" && ${tmuxCmd}`,
		"__EC=$?",
		"if [ $__EC -ne 0 ]; then",
		`  printf '\\n\\033[1;31m✗ Process exited with code %s\\033[0m\\n' "$__EC"`,
		"  exec bash",
		"fi",
		"",
	].join("\n");
}

const SYSTEM_REQUIREMENTS = [
	{ id: "git", name: "Git", checkCommand: "git", installHint: "requirements.installGit", installCommand: "xcode-select --install" },
	{ id: "tmux", name: "tmux", checkCommand: "tmux", installHint: "requirements.installTmux", installCommand: "brew install tmux" },
];

// Will be set by index.ts after window creation
let pushMessage: ((name: string, payload: any) => void) | null = null;

// Track dev server tmux pane IDs per task
const devPaneIds = new Map<string, string>();

// Track git operation tmux pane IDs per task
const gitOpPaneIds = new Map<string, string>();

async function killExistingGitPane(taskId: string, tmuxSession: string, socket: string | null): Promise<void> {
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

async function openGitOpPane(tmuxSession: string, cwd: string, scriptPath: string, socket: string | null): Promise<string | null> {
	const proc = spawn(pty.tmuxArgs(socket,
		"split-window", "-v",
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

function monitorGitPane(paneId: string | null, taskId: string, projectId: string, operation: string, socket: string | null): void {
	if (!paneId) return;
	const tmuxSession = `dev3-${taskId.slice(0, 8)}`;
	const exitFilePath = `/tmp/dev3-${taskId}-git-${operation}.sh.exit`;

	const interval = setInterval(async () => {
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
				clearInterval(interval);
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
			clearInterval(interval);
		}
	}, 1000);

	// Safety timeout: stop polling after 10 minutes
	setTimeout(() => clearInterval(interval), 10 * 60 * 1000);
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
			const updated = await data.updateTask(project, task.id, { status: "user-questions" });
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			return;
		}
	} catch (err) {
		log.error("handleBellAutoStatus failed", { taskId: taskId.slice(0, 8), error: String(err) });
	}
}

const DEFAULT_CLEANUP_SCRIPT = 'say "task finished"';

export async function runCleanupScript(task: Task, project: Project): Promise<void> {
	if (!task.worktreePath) return;

	if (!existsSync(task.worktreePath)) {
		log.warn("Skipping cleanup script — worktree directory missing", {
			worktreePath: task.worktreePath,
			taskId: task.id,
		});
		return;
	}

	const script = project.cleanupScript?.trim() || DEFAULT_CLEANUP_SCRIPT;
	const scriptPath = `/tmp/dev3-${task.id}-cleanup.sh`;
	const sessionName = `dev3-cl-${task.id.slice(0, 8)}`;

	await Bun.write(scriptPath, `#!/bin/bash\n${script}\n`);

	log.info("Starting cleanup tmux session", { session: sessionName, worktreePath: task.worktreePath });

	// Run attached (no -d) so proc.exited fires when the script finishes
	// and tmux destroys the session automatically when the shell exits.
	const cleanupSocket = task.tmuxSocket ?? null;
	const cleanupArgs = cleanupSocket
		? pty.tmuxArgs(cleanupSocket, "-f", pty.TMUX_CONF_PATH, "new-session", "-s", sessionName, "-c", task.worktreePath, `bash "${scriptPath}"`)
		: pty.tmuxArgs(null, "new-session", "-s", sessionName, "-c", task.worktreePath, `bash "${scriptPath}"`);
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

export async function launchTaskPty(
	project: Project,
	task: Task,
	worktreePath: string,
	agentId?: string | null,
	configId?: string | null,
	runSetup = false,
): Promise<void> {
	log.info("launchTaskPty START", {
		taskId: task.id.slice(0, 8),
		projectId: project.id.slice(0, 8),
		worktreePath,
		agentId: agentId ?? "none",
		configId: configId ?? "none",
		runSetup,
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

	try {
		if (agentId) {
			log.info("Resolving command for agent", { agentId, configId });
			const resolved = await agents.resolveCommandForAgent(agentId, configId ?? null, ctx);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
		} else {
			log.info("Resolving command for project", { projectName: project.name });
			const resolved = await agents.resolveCommandForProject(
				project,
				task.title,
				task.description,
				worktreePath,
			);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
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

	if (runSetup && project.setupScript.trim()) {
		const prefix = `/tmp/dev3-${task.id}`;
		const setupPath = `${prefix}-setup.sh`;
		const claudePath = `${prefix}-cmd.sh`;
		const startupPath = `${prefix}-startup.sh`;

		// Write setup script and claude command to separate files
		// to avoid tmux env var propagation issues (tmux server doesn't
		// inherit custom env vars from the client process)
		await Bun.write(setupPath, project.setupScript + "\n");
		await Bun.write(claudePath, buildCmdScript(tmuxCmd));

		const splitCmd = `tmux split-window -v -c "${worktreePath}" "bash '${claudePath}'"`;
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
	}

	// Prepend ~/.dev3.0/bin to PATH so `dev3` CLI is available inside the worktree
	const dev3Bin = `${DEV3_HOME}/bin`;
	const currentPath = process.env.PATH || "";
	const pathWithDev3 = currentPath.includes(dev3Bin) ? currentPath : `${dev3Bin}:${currentPath}`;
	const env = { ...extraEnv, DEV3_TASK_ID: task.id, PATH: pathWithDev3 };

	// Write the command to a temp script instead of passing inline.
	// tmux 3.x limits the shell-command for new-session to ~16 KB;
	// inline commands with long task descriptions easily exceed that.
	const runScriptPath = `/tmp/dev3-${task.id}-run.sh`;
	await Bun.write(runScriptPath, buildCmdScript(tmuxCmd));
	const wrapperCmd = `bash "${runScriptPath}"`;

	log.info("Creating PTY session", {
		taskId: task.id.slice(0, 8),
		worktreePath,
		command: tmuxCmd.slice(0, 200),
		scriptPath: runScriptPath,
		envKeys: Object.keys(env),
	});
	try {
		pty.createSession(task.id, project.id, worktreePath, wrapperCmd, env, task.tmuxSocket ?? null);
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

export const handlers = {
	async quitApp(): Promise<void> {
		log.info("→ quitApp (Cmd+Q from renderer)");
		Utils.quit();
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
		const projects = await data.loadProjects();
		log.info(`← getProjects: ${projects.length} project(s)`);
		return projects;
	},

	async pickFolder(): Promise<string | null> {
		log.info("→ pickFolder (opening native dialog)");
		try {
			const paths = await Utils.openFileDialog({
				canChooseFiles: false,
				canChooseDirectory: true,
				allowsMultipleSelection: false,
			});
			log.info("← pickFolder", { paths });
			if (!paths || paths.length === 0) return null;
			return paths[0];
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
		await data.removeProject(params.projectId);
		log.info("← removeProject done");
	},

	async updateProjectSettings(params: {
		projectId: string;
		setupScript: string;
		devScript: string;
		cleanupScript: string;
		defaultBaseBranch: string;
	}): Promise<Project> {
		console.log("[updateProjectSettings] params received:", JSON.stringify(params));
		log.info("→ updateProjectSettings", { projectId: params.projectId });
		const project = await data.updateProject(params.projectId, {
			setupScript: params.setupScript,
			devScript: params.devScript,
			cleanupScript: params.cleanupScript,
			defaultBaseBranch: params.defaultBaseBranch,
		});
		console.log("[updateProjectSettings] saved project:", JSON.stringify(project));
		log.info("← updateProjectSettings done");
		return project;
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

	async createTask(params: {
		projectId: string;
		description: string;
		status?: TaskStatus;
	}): Promise<Task> {
		log.info("→ createTask", params);
		const project = await data.getProject(params.projectId);
		const status = params.status || "todo";
		const task = await data.addTask(project, params.description, status);

		// If created directly into an active status, set up worktree + PTY
		if (isActive(status)) {
			log.info("Created into active status, creating worktree + PTY", {
				taskId: task.id,
			});
			const wt = await git.createWorktree(project, task);
			await launchTaskPty(project, task, wt.worktreePath, undefined, undefined, true);

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

		log.info(`Moving task ${oldStatus} → ${newStatus}`, { taskId: task.id, force: !!params.force });

		// todo → active: create worktree + PTY session
		if (!isActive(oldStatus) && isActive(newStatus)) {
			const isReopen = oldStatus === "completed" || oldStatus === "cancelled";
			log.info("Transition: inactive → active, creating worktree + PTY", { isReopen });
			const wt = await git.createWorktree(project, task);
			const taskForLaunch = isReopen ? { ...task, description: "" } : task;
			await launchTaskPty(project, taskForLaunch, wt.worktreePath, undefined, undefined, true);

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
			});
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("← moveTask done (worktree created)", { taskId: task.id });
			return updated;
		}

		// → completed/cancelled: destroy PTY, run cleanup if configured, then remove worktree
		if (newStatus === "completed" || newStatus === "cancelled") {
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
					pty.destroySession(task.id);
				} catch (err) {
					log.error("destroySession failed, continuing with task move", {
						taskId: task.id,
						error: String(err),
					});
				}

				try {
					log.info("Running cleanup script before removing worktree", { taskId: task.id });
					await runCleanupScript(task, project);
				} catch (err) {
					log.error("Cleanup script failed, continuing with task move", {
						taskId: task.id,
						error: String(err),
					});
				}

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
			});
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("← moveTask done (worktree destroyed)", { taskId: task.id });
			return updated;
		}

		// active → active or todo → todo/completed/cancelled (no worktree changes)
		const updated = await data.updateTask(project, task.id, {
			status: newStatus,
		});
		pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
		log.info("← moveTask done (status only)", { taskId: task.id });
		return updated;
	},

	async deleteTask(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ deleteTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		// Cleanup if active
		if (isActive(task.status)) {
			log.info("Task is active, cleaning up PTY + worktree");
			pty.destroySession(task.id);
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
				},
			);

			if (isActive(params.targetStatus)) {
				const wt = await git.createWorktree(project, task);
				await launchTaskPty(project, task, wt.worktreePath, variant.agentId, variant.configId, true);

				const updated = await data.updateTask(project, task.id, {
					worktreePath: wt.worktreePath,
					branchName: wt.branchName,
				});
				pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
				resultTasks.push(updated);
			} else {
				resultTasks.push(task);
			}
		}

		// Delete the original TODO task
		await data.deleteTask(project, params.taskId);

		log.info("← spawnVariants done", { count: resultTasks.length, groupId });
		return resultTasks;
	},

	async editTask(params: { taskId: string; projectId: string; description: string }): Promise<Task> {
		log.info("→ editTask", { taskId: params.taskId });
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		if (task.status !== "todo") {
			throw new Error(`Can only edit tasks in todo status (got ${task.status})`);
		}
		const title = titleFromDescription(params.description);
		const updated = await data.updateTask(project, task.id, {
			description: params.description,
			title,
		});
		log.info("← editTask done", { taskId: task.id });
		return updated;
	},

	async runDevServer(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ runDevServer", params);
		try {
			const project = await data.getProject(params.projectId);
			const task = await data.getTask(project, params.taskId);

			if (!project.devScript.trim()) throw new Error("No dev script configured");
			if (!task.worktreePath) throw new Error("Task has no worktree");

			const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
			const devScriptPath = `/tmp/dev3-${task.id}-dev.sh`;
			const socket = task.tmuxSocket ?? null;

			// Kill existing dev pane for this task if it's still alive
			// Check both in-memory map and tmux directly (map lost on restart)
			const existingPane = devPaneIds.get(task.id);
			if (existingPane) {
				const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", existingPane));
				await kill.exited;
				devPaneIds.delete(task.id);
				log.info("Killed existing dev pane (from map)", { taskId: task.id.slice(0, 8), paneId: existingPane });
			} else {
				// Fallback: find panes running the dev script file for this task
				const listProc = spawn(pty.tmuxArgs(socket,
					"list-panes", "-t", tmuxSession,
					"-F", "#{pane_id} #{pane_start_command}",
				), { stdout: "pipe", stderr: "pipe" });
				const listOutput = await new Response(listProc.stdout).text();
				await listProc.exited;
				for (const line of listOutput.trim().split("\n")) {
					if (line.includes(devScriptPath)) {
						const paneId = line.split(" ")[0];
						const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", paneId));
						await kill.exited;
						log.info("Killed existing dev pane (from tmux scan)", { taskId: task.id.slice(0, 8), paneId });
					}
				}
			}

			const wrappedScript = [
				`#!/bin/bash`,
				`set -x`,
				project.devScript,
				`EXIT_CODE=$?`,
				`set +x`,
				`if [ $EXIT_CODE -ne 0 ]; then`,
				`  echo ""`,
				`  echo "Process exited with code $EXIT_CODE. Press any key to close."`,
				`  read -n 1 -s`,
				`fi`,
			].join("\n") + "\n";
			await Bun.write(devScriptPath, wrappedScript);

			// Create pane and capture its ID with -P -F
			const proc = spawn(pty.tmuxArgs(socket,
				"split-window", "-h",
				"-t", tmuxSession,
				"-c", task.worktreePath,
				"-P", "-F", "#{pane_id}",
				`bash "${devScriptPath}"`,
			), { stdout: "pipe", stderr: "pipe" });
			const output = await new Response(proc.stdout).text();
			const stderrOutput = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			if (stderrOutput.trim()) {
				log.warn("runDevServer tmux stderr", { taskId: task.id.slice(0, 8), stderr: stderrOutput.trim() });
			}
			if (exitCode !== 0) {
				log.error("runDevServer tmux exited with non-zero code", { taskId: task.id.slice(0, 8), exitCode, stderr: stderrOutput.trim() });
				throw new Error(`tmux split-window failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
			}

			const paneId = output.trim();
			if (paneId) {
				devPaneIds.set(task.id, paneId);
				log.info("← runDevServer done", { paneId });
			} else {
				log.info("← runDevServer done (no pane id captured)");
			}
		} catch (err) {
			log.error("runDevServer FAILED", {
				taskId: params.taskId.slice(0, 8),
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
			throw err;
		}
	},

	async getBranchStatus(params: { taskId: string; projectId: string }) {
		log.info("→ getBranchStatus", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) {
			return { ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0, unpushed: 0 };
		}

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		const [, status, uncommitted, unpushed] = await Promise.all([
			git.fetchOrigin(project.path),
			git.getBranchStatus(task.worktreePath, baseBranch),
			git.getUncommittedChanges(task.worktreePath),
			git.getUnpushedCount(task.worktreePath, task.branchName ?? ""),
		]);
		const canRebase = status.behind > 0 ? await git.canRebaseCleanly(task.worktreePath, baseBranch) : false;

		const result = { ...status, canRebase, ...uncommitted, unpushed };
		log.info("← getBranchStatus", result);
		return result;
	},

	async rebaseTask(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ rebaseTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) throw new Error("Task has no worktree");

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-rebase.sh`;

		const socket = task.tmuxSocket ?? null;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const script = [
			`#!/bin/bash`,
			`echo "Fetching origin..."`,
			`git fetch origin --quiet`,
			`echo "Rebasing on ${baseBranch}..."`,
			`set -x`,
			`git rebase ${baseBranch}`,
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

		if (!task.branchName) throw new Error("Task has no branch");
		if (!task.worktreePath) throw new Error("Task has no worktree");

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		const status = await git.getBranchStatus(task.worktreePath, baseBranch);
		if (status.behind > 0) throw new Error("Branch is not rebased — rebase first");

		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-merge.sh`;

		const socket = task.tmuxSocket ?? null;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const escapedPath = project.path.replace(/'/g, "'\\''");
		const escapedTitle = task.title.replace(/'/g, "'\\''");

		const script = [
			`#!/bin/bash`,
			`cd '${escapedPath}'`,
			`echo "Squash-merging ${task.branchName} into $(git branch --show-current)..."`,
			`set -x`,
			`git merge --squash ${task.branchName}`,
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

		const socket = task.tmuxSocket ?? null;
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
			`  sleep 5`,
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

	async showDiff(params: { taskId: string; projectId: string }): Promise<void> {
		log.info("→ showDiff", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) throw new Error("Task has no worktree");

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const scriptPath = `/tmp/dev3-${task.id}-git-diff.sh`;

		const socket = task.tmuxSocket ?? null;
		await killExistingGitPane(task.id, tmuxSession, socket);

		const script = [
			`#!/bin/bash`,
			`git diff --color=always ${baseBranch}...HEAD | less -R`,
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

		const socket = task.tmuxSocket ?? null;
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

	async getPtyUrl(params: { taskId: string }): Promise<string> {
		log.info("→ getPtyUrl", {
			taskId: params.taskId,
			hasExistingSession: pty.hasSession(params.taskId),
			ptyPort: pty.getPtyPort(),
		});

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
					await launchTaskPty(foundProject, foundTask, foundTask.worktreePath);
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
		const proc = spawnSync([
			"mdfind",
			"-onlyin", "/",
			`kMDItemFSName == "${params.filename}"`,
		]);
		const output = proc.stdout.toString().trim();
		if (!output) return null;

		const candidates = output.split("\n");
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
		const { join, dirname } = await import("path");
		const { readdirSync, existsSync } = await import("fs");

		// Find project root (same pattern as "rebuild" menu handler)
		let root = import.meta.dir;
		for (let i = 0; i < 20; i++) {
			if (existsSync(join(root, "vite.config.ts"))) break;
			const parent = dirname(root);
			if (parent === root) break;
			root = parent;
		}

		const changeLogsDir = join(root, "change-logs");
		if (!existsSync(changeLogsDir)) {
			// Production fallback: read baked JSON from the app bundle
			const jsonPath = join(import.meta.dir, "..", "changelog.json");
			if (existsSync(jsonPath)) {
				const entries: ChangelogEntry[] = JSON.parse(await Bun.file(jsonPath).text());
				log.info("<- getChangelogs (from bundled JSON)", { count: entries.length });
				return entries;
			}
			log.info("<- getChangelogs (no change-logs dir, no bundled JSON)");
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

						// Read first sentence as title
						const content = await Bun.file(join(dayPath, file)).text();
						const firstSentence = content.split(/\.(?:\s|$)/)[0]?.trim() ?? slug;
						const title = firstSentence.length > 120
							? firstSentence.slice(0, 117) + "..."
							: firstSentence;

						entries.push({
							date: `${year}-${month}-${day}`,
							type,
							slug,
							title: title || slug,
						});
					}
				}
			}
		}

		entries.sort((a, b) => b.date.localeCompare(a.date));
		log.info("<- getChangelogs", { count: entries.length });
		return entries;
	},

	async listTmuxSessions(): Promise<TmuxSessionInfo[]> {
		log.info("→ listTmuxSessions");

		// Build shortId → taskTitle map from all projects/tasks
		const titleMap = new Map<string, string>();
		try {
			const projects = await data.loadProjects();
			for (const project of projects) {
				const tasks = await data.loadTasks(project);
				for (const task of tasks) {
					titleMap.set(task.id.slice(0, 8), task.title);
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

			const isCleanup = name.startsWith("dev3-cl-");
			const shortId = isCleanup ? name.slice(8) : name.slice(5);

			sessions.push({
				name,
				cwd: cwd || "",
				createdAt: parseInt(createdStr, 10) || 0,
				windowCount: parseInt(windowsStr, 10) || 1,
				isCleanup,
				taskTitle: titleMap.get(shortId),
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
			["tmux", "kill-session", "-t", params.sessionName],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			log.error("killTmuxSession failed", { sessionName: params.sessionName, stderr: stderr.trim() });
			throw new Error(`Failed to kill session: ${stderr.trim()}`);
		}
		log.info("← killTmuxSession done", { sessionName: params.sessionName });
	},

	async checkSystemRequirements(): Promise<RequirementCheckResult[]> {
		log.info("-> checkSystemRequirements");
		const results: RequirementCheckResult[] = SYSTEM_REQUIREMENTS.map((req) => {
			const proc = spawnSync(["which", req.checkCommand]);
			const installed = proc.exitCode === 0;
			log.info(`  ${req.id}: ${installed ? "found" : "NOT found"}`);
			return {
				id: req.id,
				name: req.name,
				installed,
				installHint: req.installHint,
				installCommand: req.installCommand,
			};
		});
		log.info("<- checkSystemRequirements", { results: results.map((r) => `${r.id}:${r.installed}`) });
		return results;
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

	async tmuxAction(params: { taskId: string; action: "splitH" | "splitV" | "zoom" }): Promise<void> {
		log.info("→ tmuxAction", { taskId: params.taskId.slice(0, 8), action: params.action });
		const socket = pty.getSessionSocket(params.taskId) ?? null;
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

};
