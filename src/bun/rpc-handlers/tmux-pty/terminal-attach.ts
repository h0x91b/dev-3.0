import { existsSync } from "node:fs";
import { assertTaskWorkspacePresent, worktreeAccessState } from "../../task-workspace-guard";
import type { PortInfo, PtyThroughputStats, WorktreeAccessState } from "../../../shared/types";
import * as data from "../../data";
import * as pty from "../../pty-server";
import * as portPool from "../../port-pool";
import * as repoConfig from "../../repo-config";
import { getPortsForTask } from "../../port-scanner";
import { throughputSnapshot } from "../../pty-throughput";
import { getUserShell } from "../../shell-env";
import { which } from "../../which";
import { DEFAULT_TMUX_SOCKET } from "../../tmux";
import { taskTerminalBackendIdentity } from "../../task-terminal-backend";
import { nativeTaskPanesAlive } from "../../native-task-panes";
import { auxPaneAlive, auxPaneTitle, closeAuxPane, openAuxPane } from "../../task-aux-panes";
import { dev3TaskTempPath } from "../../temp-paths";
import { buildProjectTerminalEnv, buildTaskLifecycleEnv, generatedScriptLaunch, generatedScriptName, isActive, log, writeLaunchScript } from "../shared-pure";
import { sessionStateOrLostCodexPane } from "./resume";
import { launchTaskPty } from "./task-launch";
import { findTaskAcrossProjects, markTerminalAttached } from "./task-state";

export async function openFileBrowser(params: { taskId: string; projectId: string }): Promise<{ notInstalled: true; installCommand: string; linuxHint?: boolean } | void> {
	log.info("→ openFileBrowser", params);
	try {
		if (!(await which("yazi"))) {
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
		assertTaskWorkspacePresent(project, task.worktreePath);

		const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
		if (await auxPaneAlive(task, "fileBrowser", socket)) {
			await closeAuxPane(task, "fileBrowser", socket);
			log.info("← openFileBrowser: toggled off", { taskId: task.id.slice(0, 8) });
			return;
		}
		// Both backends run the same script, so its path is the marker that finds the
		// pane again on either one. A native pane left dead after yazi quits is swept
		// by the next open.
		const scriptPath = dev3TaskTempPath(task.id, generatedScriptName("yazi"));
		await writeLaunchScript(scriptPath, "yazi\n");
		const handle = await openAuxPane({
			task,
			purpose: "fileBrowser",
			focusNewPane: true,
			placement: "below",
			size: "30%",
			cwd: task.worktreePath,
			env: buildTaskLifecycleEnv(project, task, task.worktreePath),
			socket,
			title: auxPaneTitle("fileBrowser"),
			tmuxCommand: `bash "${scriptPath}"`,
			nativeLaunch: generatedScriptLaunch(scriptPath),
		});
		log.info("← openFileBrowser done", { backend: handle.backend, paneId: handle.paneId });
	} catch (err) {
		log.error("openFileBrowser FAILED", {
			taskId: params.taskId.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}
}

export async function getTerminalPreview(params: { taskId: string }): Promise<string | null> {
	return pty.capturePane(params.taskId);
}

export async function checkWorktreeState(params: { path: string; requireGit?: boolean }): Promise<WorktreeAccessState> {
	return worktreeAccessState(params.path, { requireGit: params.requireGit === true });
}

export async function getPtyUrl(params: { taskId: string; resume?: boolean }) {
	log.info("→ getPtyUrl", {
		taskId: params.taskId,
		hasExistingSession: pty.hasSession(params.taskId),
		hasDeadSession: pty.hasDeadSession(params.taskId),
		ptyPort: pty.getPtyPort(),
	});

	// If resuming and the session is dead (proc exited but still in map),
	// destroy it so launchTaskPty recreates it with the resume flag.
	if (params.resume && pty.hasDeadSession(params.taskId)) {
		log.info("Resume requested on dead session — destroying to force recreation", {
			taskId: params.taskId.slice(0, 8),
		});
		await pty.destroySessionAwaited(params.taskId);
	}

	// If session is in memory (alive or dead), verify the backend's session still
	// exists. When the tmux server (or a native host) is killed externally, our
	// handle may or may not have noticed yet — the backend is the ground truth.
	if (pty.hasSession(params.taskId) && !pty.isNativeSessionSettling(params.taskId)) {
		const alive = pty.getSessionBackend(params.taskId) === "native"
			? await nativeTaskPanesAlive(params.taskId)
			: await pty.tmuxSessionExists(params.taskId, pty.getSessionSocket(params.taskId));
		if (!alive) {
			log.info("Session in memory but the backend session is gone — destroying for recovery", {
				taskId: params.taskId.slice(0, 8),
			});
			await pty.destroySessionAwaited(params.taskId);
		}
	}

	// If no PTY session in memory, try to recreate it from persisted task data
	if (!pty.hasSession(params.taskId)) {
		log.info("No PTY session in memory, attempting to restore", {
			taskId: params.taskId.slice(0, 8),
		});

		const { task: foundTask, project: foundProject } = await findTaskAcrossProjects(params.taskId);

		// A hibernated task is never auto-restored: opening it must not undo the
		// hibernation. Report the frozen state so the renderer offers an explicit
		// wake (plain shell or resume the agent's conversation) instead.
		if (foundTask?.hibernated) {
			log.info("Hibernated task — offering an explicit wake instead of restoring", {
				taskId: params.taskId.slice(0, 8),
			});
			return {
				recoverable: true as const,
				sessionState: await sessionStateOrLostCodexPane(foundProject, foundTask) ?? { panes: [] },
				hibernated: true as const,
			};
		}

		if (foundTask && foundProject && isActive(foundTask.status) && foundTask.worktreePath) {
			// Neither a restore, a resume offer nor a fresh launch for a worktree that
			// is gone or unreadable: the renderer shows why instead.
			assertTaskWorkspacePresent(foundProject, foundTask.worktreePath);
			const identity = taskTerminalBackendIdentity(foundTask);
			const sessionAlive = identity === "native"
				? await nativeTaskPanesAlive(params.taskId)
				: await pty.tmuxSessionExists(params.taskId, foundTask.tmuxSocket ?? DEFAULT_TMUX_SOCKET);

			if (sessionAlive && identity === "native") {
				// The host and shell outlived this app process — rebind to them. This
				// must never go through launchTaskPty: creating a second session for a
				// live one is exactly the double-spawn the seam refuses.
				try {
					await pty.reattachNativeTaskSession(params.taskId, foundProject.id, foundTask.worktreePath);
					log.info("Reattached to existing native session", { taskId: params.taskId.slice(0, 8) });
					await markTerminalAttached(foundProject, foundTask);
				} catch (err) {
					log.error("Failed to reattach to native session", { taskId: params.taskId.slice(0, 8), error: String(err) });
				}
			} else if (sessionAlive) {
				// Tmux session exists — just reconnect (no resume needed).
				// Skip session persist so we don't overwrite the real session ID.
				try {
					// Virtual boards have no git repo config to resolve — pass through.
					const resolvedProject = foundProject.kind === "virtual"
						? foundProject
						: await repoConfig.resolveProjectConfig(foundProject, foundTask.worktreePath);
					await launchTaskPty(resolvedProject, foundTask, foundTask.worktreePath, foundTask.agentId, foundTask.configId, false, false, { skipSessionPersist: true });
					log.info("Reconnected to existing tmux session", { taskId: params.taskId.slice(0, 8) });
					await markTerminalAttached(foundProject, foundTask);
				} catch (err) {
					log.error("Failed to reconnect to tmux session", { taskId: params.taskId.slice(0, 8), error: String(err) });
				}
			} else if (foundTask.sessionState?.panes?.length) {
				// No tmux session but we have stored pane sessions — offer recovery
				log.info("Recoverable session detected", {
					taskId: params.taskId.slice(0, 8),
					paneCount: foundTask.sessionState.panes.length,
				});
				return { recoverable: true as const, sessionState: foundTask.sessionState };
			} else {
				// The pane record was lost but the Codex conversation is still on disk —
				// offer to resume it rather than silently starting a new one.
				const lostState = await sessionStateOrLostCodexPane(foundProject, foundTask);
				if (lostState) {
					log.info("Recoverable Codex conversation found without a pane record", { taskId: params.taskId.slice(0, 8) });
					return { recoverable: true as const, sessionState: lostState };
				}
				// No tmux, no session state — launch fresh
				try {
					const resolvedProject = foundProject.kind === "virtual"
						? foundProject
						: await repoConfig.resolveProjectConfig(foundProject, foundTask.worktreePath);
					await launchTaskPty(resolvedProject, foundTask, foundTask.worktreePath, foundTask.agentId, foundTask.configId, false, false);
					log.info("Launched fresh PTY session", { taskId: params.taskId.slice(0, 8) });
					await markTerminalAttached(foundProject, foundTask);
				} catch (err) {
					log.error("Failed to launch fresh PTY session", { taskId: params.taskId.slice(0, 8), error: String(err) });
				}
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
	log.info("← getPtyUrl", { url, sessionExists: pty.hasSession(params.taskId) });
	return { url };
}

export async function getProjectPtyUrl(params: { projectId: string }): Promise<string> {
	const sessionKey = `project-${params.projectId}`;
	log.info("→ getProjectPtyUrl", {
		projectId: params.projectId.slice(0, 8),
		hasExistingSession: pty.hasSession(sessionKey),
	});

	if (pty.hasDeadSession(sessionKey)) {
		log.info("Dead project terminal session — destroying to recreate", {
			projectId: params.projectId.slice(0, 8),
		});
		pty.destroySession(sessionKey);
	}

	if (!pty.hasSession(sessionKey)) {
		const project = await data.getProject(params.projectId);
		// Virtual ("Operations") boards have no repo and no stable project folder
		// (the synthetic ~/.dev3.0/ops/<slug> path is created lazily per-task). A
		// project terminal there is meaningless and would otherwise open a shell in
		// dev3's internal data dir — reject it explicitly. The UI hides the
		// affordance for virtual boards; this is the backend backstop.
		if (project.kind === "virtual") {
			throw new Error("Project terminal is not available for Operations boards");
		}
		if (!existsSync(project.path)) {
			throw new Error(`Project path does not exist: ${project.path}`);
		}
		const env = buildProjectTerminalEnv(project, await repoConfig.resolveProjectEnv(project, project.path));
		pty.createSession(sessionKey, params.projectId, project.path, getUserShell(), env, DEFAULT_TMUX_SOCKET, "project");
	}

	const url = `ws://localhost:${pty.getPtyPort()}?session=${sessionKey}`;
	log.info("← getProjectPtyUrl", { url });
	return url;
}

export async function destroyProjectTerminal(params: { projectId: string }): Promise<void> {
	const sessionKey = `project-${params.projectId}`;
	log.info("→ destroyProjectTerminal", { projectId: params.projectId.slice(0, 8) });
	pty.destroySession(sessionKey);
	log.info("← destroyProjectTerminal done");
}

export async function getTaskPorts(params: { taskId: string }): Promise<PortInfo[]> {
	log.info("→ getTaskPorts", { taskId: params.taskId.slice(0, 8) });
	const ports = getPortsForTask(params.taskId);
	log.info("← getTaskPorts", { taskId: params.taskId.slice(0, 8), count: ports.length });
	return ports;
}

export async function getPortAllocations(params: { taskId: string }): Promise<number[]> {
	return portPool.getPortAssignments(params.taskId);
}

/**
 * What the PTY server read versus what it managed to send, per live session.
 *
 * Read by the Debug → Terminal Performance overlay, which otherwise only sees
 * what the renderer already processed and so cannot tell a quiet shell from a
 * backlog. See `pty-throughput.ts`.
 */
export function terminalPtyStats(): { sessions: Record<string, PtyThroughputStats> } {
	return { sessions: throughputSnapshot() };
}
