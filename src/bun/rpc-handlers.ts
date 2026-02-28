import { existsSync } from "node:fs";
import { Utils } from "electrobun/bun";
import type { CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../shared/types";
import { ACTIVE_STATUSES, titleFromDescription } from "../shared/types";
import * as data from "./data";
import * as git from "./git";
import * as pty from "./pty-server";
import * as agents from "./agents";
import * as updater from "./updater";
import { loadSettings, saveSettings } from "./settings";
import { createLogger } from "./logger";

const log = createLogger("rpc");

// Will be set by index.ts after window creation
let pushMessage: ((name: string, payload: any) => void) | null = null;

// Track dev server tmux pane IDs per task
const devPaneIds = new Map<string, string>();

export function setPushMessage(fn: (name: string, payload: any) => void): void {
	pushMessage = fn;
}

function isActive(status: TaskStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

/**
 * Auto-move a task to "user-questions" when a terminal bell is detected.
 * Only transitions from "in-progress" — other statuses are left untouched.
 */
export async function handleBellAutoStatus(taskId: string): Promise<void> {
	const projectId = pty.getSessionProjectId(taskId);
	if (!projectId) return;

	try {
		const project = await data.getProject(projectId);
		const task = await data.getTask(project, taskId);

		if (task.status !== "in-progress") return;

		log.info("Bell auto-status: in-progress → user-questions", { taskId: taskId.slice(0, 8) });
		const updated = await data.updateTask(project, task.id, { status: "user-questions" });
		pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
	} catch (err) {
		log.error("Bell auto-status failed", { taskId: taskId.slice(0, 8), error: String(err) });
	}
}

async function runCleanupScript(task: Task, project: Project): Promise<void> {
	if (!task.worktreePath || !project.cleanupScript?.trim()) return;

	if (!existsSync(task.worktreePath)) {
		log.warn("Skipping cleanup script — worktree directory missing", {
			worktreePath: task.worktreePath,
			taskId: task.id,
		});
		return;
	}

	const scriptPath = `/tmp/dev3-${task.id}-cleanup.sh`;
	const sessionName = `dev3-cl-${task.id.slice(0, 8)}`;

	await Bun.write(scriptPath, `#!/bin/bash\n${project.cleanupScript}\n`);

	log.info("Starting cleanup tmux session", { session: sessionName, worktreePath: task.worktreePath });

	// Run attached (no -d) so proc.exited fires when the script finishes
	// and tmux destroys the session automatically when the shell exits.
	const proc = Bun.spawn(
		["tmux", "new-session", "-s", sessionName, "-c", task.worktreePath, `bash "${scriptPath}"`],
		{
			terminal: { cols: 220, rows: 50, data: () => {} },
			env: { ...process.env, TERM: "xterm-256color", HOME: process.env.HOME || "/" },
			cwd: task.worktreePath,
		},
	);

	await proc.exited;

	log.info("Cleanup session finished", { session: sessionName });
}

async function launchTaskPty(
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
		await Bun.write(claudePath, `#!/bin/bash\necho "Starting: ${tmuxCmd.replace(/"/g, '\\"')}" && exec ${tmuxCmd}\n`);

		const splitCmd = `tmux split-window -v -c "${worktreePath}" "bash '${claudePath}'"`;
		const setupFail = [
			"  printf '\\033[1;31m✗ Setup failed (exit %s)\\033[0m\\n' \"$S\"",
			"  exec bash",
		].join("\n");
		const setupOkClose = [
			"printf '\\033[1;32m✓ Setup done\\033[0m\\n'",
			"printf '\\033[2mClosing in 15s — press any key to close now\\033[0m\\n'",
			"read -t 15 -n 1 -s",
			"exit",
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

	const env = { ...extraEnv, DEV3_TASK_ID: task.id };
	const echoAndRun = `echo "Starting: ${tmuxCmd.replace(/"/g, '\\"')}" && ${tmuxCmd}`;
	log.info("Creating PTY session", {
		taskId: task.id.slice(0, 8),
		worktreePath,
		command: echoAndRun.slice(0, 200),
		envKeys: Object.keys(env),
	});
	try {
		pty.createSession(task.id, project.id, worktreePath, echoAndRun, env);
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
			log.info("Transition: inactive → active, creating worktree + PTY");
			const wt = await git.createWorktree(project, task);
			await launchTaskPty(project, task, wt.worktreePath, undefined, undefined, true);

			const updated = await data.updateTask(project, task.id, {
				status: newStatus,
				worktreePath: wt.worktreePath,
				branchName: wt.branchName,
			});
			pushMessage?.("taskUpdated", { projectId: project.id, task: updated });
			log.info("← moveTask done (worktree created)", { taskId: task.id });
			return updated;
		}

		// active → completed/cancelled: destroy PTY, run cleanup if configured, then remove worktree
		if (
			isActive(oldStatus) &&
			(newStatus === "completed" || newStatus === "cancelled")
		) {
			if (params.force) {
				// Force mode: skip PTY destruction, cleanup script, and worktree removal.
				// The environment is already broken — just update the status.
				log.info("Force mode: skipping PTY/cleanup/worktree", { taskId: task.id });
			} else {
				log.info("Transition: active → terminal, destroying PTY");
				try {
					pty.destroySession(task.id);
				} catch (err) {
					log.error("destroySession failed, continuing with task move", {
						taskId: task.id,
						error: String(err),
					});
				}

				try {
					if (project.cleanupScript?.trim()) {
						log.info("Running cleanup script before removing worktree", { taskId: task.id });
						await runCleanupScript(task, project);
					}
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
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!project.devScript.trim()) throw new Error("No dev script configured");
		if (!task.worktreePath) throw new Error("Task has no worktree");

		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const devScriptPath = `/tmp/dev3-${task.id}-dev.sh`;

		// Kill existing dev pane for this task if it's still alive
		// Check both in-memory map and tmux directly (map lost on restart)
		const existingPane = devPaneIds.get(task.id);
		if (existingPane) {
			const kill = Bun.spawn(["tmux", "kill-pane", "-t", existingPane]);
			await kill.exited;
			devPaneIds.delete(task.id);
			log.info("Killed existing dev pane (from map)", { taskId: task.id.slice(0, 8), paneId: existingPane });
		} else {
			// Fallback: find panes running the dev script file for this task
			const listProc = Bun.spawn([
				"tmux", "list-panes", "-t", tmuxSession,
				"-F", "#{pane_id} #{pane_start_command}",
			], { stdout: "pipe", stderr: "pipe" });
			const listOutput = await new Response(listProc.stdout).text();
			await listProc.exited;
			for (const line of listOutput.trim().split("\n")) {
				if (line.includes(devScriptPath)) {
					const paneId = line.split(" ")[0];
					const kill = Bun.spawn(["tmux", "kill-pane", "-t", paneId]);
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
		const proc = Bun.spawn([
			"tmux", "split-window", "-h",
			"-t", tmuxSession,
			"-c", task.worktreePath,
			"-P", "-F", "#{pane_id}",
			`bash "${devScriptPath}"`,
		], { stdout: "pipe" });
		const output = await new Response(proc.stdout).text();
		await proc.exited;

		const paneId = output.trim();
		if (paneId) {
			devPaneIds.set(task.id, paneId);
			log.info("← runDevServer done", { paneId });
		} else {
			log.info("← runDevServer done (no pane id captured)");
		}
	},

	async getBranchStatus(params: { taskId: string; projectId: string }) {
		log.info("→ getBranchStatus", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) {
			return { ahead: 0, behind: 0, canRebase: false, insertions: 0, deletions: 0 };
		}

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		const [, status, uncommitted] = await Promise.all([
			git.fetchOrigin(project.path),
			git.getBranchStatus(task.worktreePath, baseBranch),
			git.getUncommittedChanges(task.worktreePath),
		]);
		const canRebase = status.behind > 0 ? await git.canRebaseCleanly(task.worktreePath, baseBranch) : false;

		const result = { ...status, canRebase, ...uncommitted };
		log.info("← getBranchStatus", result);
		return result;
	},

	async rebaseTask(params: { taskId: string; projectId: string }) {
		log.info("→ rebaseTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) {
			return { ok: false, error: "Task has no worktree" };
		}

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		await git.fetchOrigin(project.path);
		const result = await git.rebaseOnBase(task.worktreePath, baseBranch);

		log.info("← rebaseTask", result);
		return result;
	},

	async mergeTask(params: { taskId: string; projectId: string }) {
		log.info("→ mergeTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.branchName) {
			return { ok: false, error: "Task has no branch" };
		}

		const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
		await git.fetchOrigin(project.path);
		const status = await git.getBranchStatus(task.worktreePath!, baseBranch);

		if (status.behind > 0) {
			return { ok: false, error: "Branch is not rebased" };
		}

		const result = await git.mergeBranch(project.path, task.branchName, task.title);
		log.info("← mergeTask", result);
		return result;
	},

	async pushTask(params: { taskId: string; projectId: string }) {
		log.info("→ pushTask", params);
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);

		if (!task.worktreePath) {
			return { ok: false, error: "Task has no worktree" };
		}

		const result = await git.pushBranch(task.worktreePath);
		log.info("← pushTask", result);
		return result;
	},

	async getTerminalPreview(params: { taskId: string }): Promise<string | null> {
		return pty.capturePane(params.taskId);
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
		const proc = Bun.spawnSync([
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
		log.info("<- checkForUpdate", result);
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
};
