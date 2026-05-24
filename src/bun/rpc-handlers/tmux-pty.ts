import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { ColumnAgentConfig, DevServerStatus, PortInfo, Project, Task, TmuxSessionInfo } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import * as data from "../data";
import * as pty from "../pty-server";
import * as agents from "../agents";
import * as portPool from "../port-pool";
import * as repoConfig from "../repo-config";
import { getPortsForTask, getSessionPanePids, scanTaskPorts } from "../port-scanner";
import { getResourceUsage } from "../resource-monitor";
import { loadSettings } from "../settings";
import { getUserShell } from "../shell-env";
import { spawn } from "../spawn";
import { setupAgentHooks } from "../agent-hooks";
import { isActive, buildAgentEnv, buildCmdScript, buildEnvExports, buildScriptRunnerCommand, escapeForDoubleQuotes, log, resolveBinaryPath, shellQuote } from "./shared-pure";
import { resolveOperationalProjectConfig } from "./settings-config";

const devViewerPaneIds = new Map<string, string>();
const fileBrowserPaneIds = new Map<string, string>();

function devServerSessionName(taskId: string): string {
	return `dev3-dev-${taskId.slice(0, 8)}`;
}

async function isDevServerRunning(taskId: string, socket: string): Promise<boolean> {
	const devSession = devServerSessionName(taskId);
	const check = spawn(pty.tmuxArgs(socket, "has-session", "-t", devSession), { stdout: "pipe", stderr: "pipe" });
	const exitCode = await check.exited;
	return exitCode === 0;
}

async function findDevServerViewerPaneId(taskId: string, taskSession: string, devSession: string, socket: string): Promise<string | null> {
	let viewerPaneId = devViewerPaneIds.get(taskId);
	if (viewerPaneId) {
		return viewerPaneId;
	}

	const listProc = spawn(pty.tmuxArgs(socket,
		"list-panes", "-t", taskSession,
		"-F", "#{pane_id} #{pane_start_command}",
	), { stdout: "pipe", stderr: "pipe" });
	const listOutput = await new Response(listProc.stdout).text();
	await listProc.exited;
	for (const line of listOutput.trim().split("\n")) {
		if (!line.includes(devSession)) continue;
		viewerPaneId = line.split(" ")[0];
		break;
	}

	return viewerPaneId ?? null;
}

async function killDevServerViewerPane(taskId: string, taskSession: string, devSession: string, socket: string): Promise<void> {
	const viewerPaneId = await findDevServerViewerPaneId(taskId, taskSession, devSession, socket);
	if (!viewerPaneId) return;

	const killPane = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", viewerPaneId), { stdout: "pipe", stderr: "pipe" });
	await killPane.exited;
	devViewerPaneIds.delete(taskId);
	log.info("Killed dev server viewer pane", { taskId: taskId.slice(0, 8), viewerPaneId });
}

export async function killDevServerSession(taskId: string, socket: string): Promise<void> {
	const devSession = devServerSessionName(taskId);
	const taskSession = `dev3-${taskId.slice(0, 8)}`;
	await killDevServerViewerPane(taskId, taskSession, devSession, socket);
	const kill = spawn(pty.tmuxArgs(socket, "kill-session", "-t", devSession), { stdout: "pipe", stderr: "pipe" });
	await kill.exited;
	log.info("Killed dev server session", { taskId: taskId.slice(0, 8), devSession });
}

async function buildDevServerStatus(task: Task, projectId: string, hasDevScript: boolean, socket?: string): Promise<DevServerStatus> {
	const resolvedSocket = socket ?? task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	const taskSessionName = `dev3-${task.id.slice(0, 8)}`;
	const devSessionName = devServerSessionName(task.id);
	const running = await isDevServerRunning(task.id, resolvedSocket);
	const assignedPorts = portPool.getPortAssignments(task.id);
	const viewerPaneId = running
		? await findDevServerViewerPaneId(task.id, taskSessionName, devSessionName, resolvedSocket)
		: null;
	const panePids = running ? getSessionPanePids(resolvedSocket, devSessionName) : [];
	const ports = running
		? (() => {
			const cached = getPortsForTask(task.id);
			return cached.length > 0 ? cached : scanTaskPorts(resolvedSocket, taskSessionName);
		})()
		: [];
	const resourceUsage = running ? getResourceUsage(task.id) : undefined;

	return {
		projectId,
		taskId: task.id,
		running,
		hasDevScript,
		worktreePath: task.worktreePath ?? null,
		tmuxSocket: resolvedSocket,
		taskSessionName,
		devSessionName,
		viewerPaneId,
		panePids,
		assignedPorts,
		ports,
		resourceUsage,
	};
}

async function setTmuxSessionPortEnv(taskId: string, socket: string): Promise<void> {
	const ports = portPool.getPortAssignments(taskId);
	if (ports.length === 0) return;

	const tmuxSession = `dev3-${taskId.slice(0, 8)}`;
	const envVars = portPool.buildPortEnv(ports);

	for (const [key, value] of Object.entries(envVars)) {
		const args = pty.tmuxArgs(socket, "set-environment", "-t", tmuxSession, key, value);
		const proc = spawn(args, { stdout: "pipe", stderr: "pipe" });
		await proc.exited;
	}

	log.info("Port env vars set on tmux session", { taskId: taskId.slice(0, 8), vars: Object.keys(envVars) });
}

export async function launchTaskPty(
	project: Project,
	task: Task,
	worktreePath: string,
	agentId?: string | null,
	configId?: string | null,
	runSetup = false,
	resume = false,
	opts?: { sessionId?: string; skipSessionPersist?: boolean },
): Promise<void> {
	const sessionId = opts?.sessionId;
	const skipSessionPersist = opts?.skipSessionPersist ?? false;
	log.info("launchTaskPty START", {
		taskId: task.id.slice(0, 8),
		projectId: project.id.slice(0, 8),
		worktreePath,
		agentId: agentId ?? "none",
		configId: configId ?? "none",
		runSetup,
		resume,
		sessionId: sessionId ?? "none",
		skipSessionPersist,
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
		const cmdOptions: agents.CommandOptions = {};
		let freshSessionId: string | null = null;

		if (resume) {
			cmdOptions.resume = true;
			if (sessionId) cmdOptions.sessionId = sessionId;
		} else {
			// Fresh launch — always generate a new UUID.
			// Claude rejects --session-id if the UUID was already used;
			// stored session IDs are only for --resume.
			freshSessionId = crypto.randomUUID();
			cmdOptions.sessionId = freshSessionId;
		}

		if (agentId) {
			log.info("Resolving command for agent", { agentId, configId });
			const resolved = await agents.resolveCommandForAgent(agentId, configId ?? null, ctx, Object.keys(cmdOptions).length ? cmdOptions : undefined);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
			resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		} else {
			log.info("Resolving command for project", { projectName: project.name });
			const resolved = await agents.resolveCommandForProject(
				project,
				task.title,
				ctx.taskDescription,
				worktreePath,
				undefined,
				Object.keys(cmdOptions).length ? cmdOptions : undefined,
			);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
			resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		}

		// Persist session state as pane[0] for the main agent pane.
		// Skip when reconnecting to an existing tmux session (sessionState is already correct).
		if (!skipSessionPersist) {
			const effectiveSessionId = resume ? sessionId
				: (agents.supportsPreAssignedSessionId(resolvedBaseCmd) ? freshSessionId : null);
			const paneEntry = {
				agentCmd: resolvedBaseCmd,
				sessionId: effectiveSessionId ?? null,
				agentId: agentId ?? task.agentId,
				configId: configId ?? task.configId,
			};
			const sessionState = { panes: [paneEntry] };
			try {
				await data.updateTask(project, task.id, { sessionState });
				log.info("Persisted sessionState", { taskId: task.id.slice(0, 8), sessionId: paneEntry.sessionId });
			} catch (err) {
				log.error("Failed to persist sessionState (non-fatal)", { taskId: task.id.slice(0, 8), error: String(err) });
			}
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

	const env = buildAgentEnv(extraEnv, task.id);
	const userShell = getUserShell();

	const portCount = project.portCount ?? 0;
	if (portCount > 0) {
		try {
			const ports = await portPool.allocatePorts(task.id, portCount);
			Object.assign(env, portPool.buildPortEnv(ports));
			log.info("Port env vars injected", { taskId: task.id.slice(0, 8), ports });
		} catch (err) {
			log.error("Port allocation failed (non-fatal)", {
				taskId: task.id.slice(0, 8),
				portCount,
				error: String(err),
			});
		}
	}

	if (resolvedBaseCmd && resolvedBaseCmd !== "bash") {
		const binaryName = resolvedBaseCmd.split("/").pop() ?? resolvedBaseCmd;
		const settings = await loadSettings();
		const customPath = settings.agentBinaryPaths?.[task.agentId ?? ""];
		const { resolvedPath: binaryPath } = resolveBinaryPath(binaryName, customPath);
		if (!binaryPath) {
			const allAgents = await agents.getAllAgents();
			const matchedAgent = allAgents.find((agent) => agent.baseCommand === resolvedBaseCmd || agent.baseCommand === binaryName);
			const installCmd = matchedAgent?.installCommand ?? `Install "${binaryName}" and make sure it's on your PATH`;

			log.warn("Agent binary not found, creating retry wrapper", { binaryName, installCmd });

			const originalCmdPath = `/tmp/dev3-${task.id}-original-cmd.sh`;
			await Bun.write(originalCmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true, shellPath: userShell }));

			const retryScript = [
				"#!/bin/bash",
				"",
				"check_and_run() {",
				`  if command -v ${shellQuote(binaryName)} &>/dev/null; then`,
				`    printf '\\n\\033[1;32m✓ Found %s\\033[0m\\n\\n' ${shellQuote(binaryName)}`,
				`    exec ${buildScriptRunnerCommand(originalCmdPath, { shellPath: userShell })}`,
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
			tmuxCmd = buildScriptRunnerCommand(retryScriptPath, { shellPath: userShell });
			log.info("Replaced tmuxCmd with agent-check retry wrapper");
		}
	}

	try {
		await agents.ensureClaudeTrust(worktreePath, project.path);
		log.info("Claude trust ensured", { worktreePath });
	} catch (err) {
		log.error("ensureClaudeTrust failed (non-fatal)", {
			worktreePath,
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
	}

	if (agents.isCodexCommand(resolvedBaseCmd)) {
		try {
			await agents.ensureCodexTrust(worktreePath);
			log.info("Codex trust ensured", { worktreePath });
		} catch (err) {
			log.error("ensureCodexTrust failed (non-fatal)", {
				worktreePath,
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
		}
	}

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

	const stopTarget = project.autoReviewEnabled ? "review-by-ai" : "review-by-user";
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
		const setupScriptLaunchMode = project.setupScriptLaunchMode ?? "parallel";
		const prefix = `/tmp/dev3-${task.id}`;
		const setupPath = `${prefix}-setup.sh`;
		const cmdPath = `${prefix}-cmd.sh`;
		const startupPath = `${prefix}-startup.sh`;

		await Bun.write(setupPath, project.setupScript + "\n");
		await Bun.write(cmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true, shellPath: userShell }));

		const splitCmd = `tmux split-window -v -c "${escapeForDoubleQuotes(worktreePath)}" "${escapeForDoubleQuotes(buildScriptRunnerCommand(cmdPath, { shellPath: userShell }))}"`;
		const setupFail = [
			"  printf '\\033[1;31m✗ Setup failed (exit %s)\\033[0m\\n' \"$S\"",
			`  exec ${shellQuote(userShell)}`,
		].join("\n");
		const setupOkClose = [
			"printf '\\033[1;32m✓ Setup done\\033[0m\\n'",
			"printf '\\033[2mClosing in 15s — press any key to close now\\033[0m\\n'",
			"read -t 15 -n 1 -s",
			"exit 0",
		].join("\n");

		const startupLines = [
			"#!/bin/bash",
			...(setupScriptLaunchMode === "parallel" ? [splitCmd] : []),
			buildScriptRunnerCommand(setupPath, { shellPath: userShell, trace: true }),
			"S=$?",
			`if [ $S -ne 0 ]; then`,
			setupFail,
			"fi",
			...(setupScriptLaunchMode === "blocking" ? [splitCmd] : []),
			setupOkClose,
		];
		await Bun.write(startupPath, startupLines.join("\n") + "\n");
		tmuxCmd = buildScriptRunnerCommand(startupPath, { shellPath: userShell });
		isSetupWrapper = true;
	}

	const runScriptPath = `/tmp/dev3-${task.id}-run.sh`;
	await Bun.write(runScriptPath, buildCmdScript(tmuxCmd, env, { keepShell: !isSetupWrapper, shellPath: userShell }));
	const wrapperCmd = buildScriptRunnerCommand(runScriptPath, { shellPath: userShell });

	log.info("Creating PTY session", {
		taskId: task.id.slice(0, 8),
		worktreePath,
		command: tmuxCmd.slice(0, 200),
		scriptPath: runScriptPath,
		envKeys: Object.keys(env),
	});
	try {
		const sessionSocket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		pty.createSession(task.id, project.id, worktreePath, wrapperCmd, env, sessionSocket);
		log.info("launchTaskPty DONE — PTY session created", { taskId: task.id.slice(0, 8) });
		await setTmuxSessionPortEnv(task.id, sessionSocket);
	} catch (err) {
		log.error("pty.createSession FAILED", {
			taskId: task.id.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}
}

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
	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	const prompt = rawPrompt.replace(/\{baseBranch\}/g, `origin/${baseBranch}`);

	log.info("launchColumnAgent START", {
		taskId: task.id.slice(0, 8),
		agentId,
		configId,
		paneTitle: options.paneTitle,
	});

	const socket = pty.getSessionSocket(task.id);
	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;

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

	const env = buildAgentEnv(extraEnv, task.id);
	const scriptPath = `/tmp/dev3-${task.id}-col-agent.sh`;
	await Bun.write(scriptPath, buildCmdScript(tmuxCmd, env, {
		paneTitle: options.paneTitle,
		onExitCommand: options.onExitCommand,
	}));

	const paneFile = `/tmp/dev3-${task.id}-col-agent-pane`;
	try {
		const oldPaneId = (await Bun.file(paneFile).text()).trim();
		if (oldPaneId) {
			log.info("launchColumnAgent: killing old pane", { paneId: oldPaneId });
			const killArgs = pty.tmuxArgs(socket, "kill-pane", "-t", oldPaneId);
			const killProc = spawn(killArgs, { stdout: "pipe", stderr: "pipe" });
			await killProc.exited;
		}
	} catch {}

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

	const newPaneId = stdout.trim();
	if (newPaneId) {
		await Bun.write(paneFile, newPaneId);
		log.info("launchColumnAgent: pane created", { paneId: newPaneId });
	}

	try {
		const focusArgs = pty.tmuxArgs(socket, "select-pane", "-t", `${tmuxSession}:.0`);
		const focusProc = spawn(focusArgs, { stdout: "pipe", stderr: "pipe" });
		await focusProc.exited;
	} catch {}

	log.info("launchColumnAgent DONE", { taskId: task.id.slice(0, 8) });
}

export function cleanupTaskTmuxState(taskId: string): void {
	fileBrowserPaneIds.delete(taskId);
	devViewerPaneIds.delete(taskId);
}

export async function runDevServer(params: { taskId: string; projectId: string }): Promise<DevServerStatus> {
	log.info("→ runDevServer", params);
	try {
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const resolved = await resolveOperationalProjectConfig(project, task.worktreePath ?? undefined);

		if (!resolved.devScript.trim()) throw new Error("No dev script configured");
		if (!task.worktreePath) throw new Error("Task has no worktree");

		const devSession = devServerSessionName(task.id);
		const devScriptPath = `/tmp/dev3-${task.id}-dev.sh`;
		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;

		if (await isDevServerRunning(task.id, socket)) {
			await killDevServerSession(task.id, socket);
		}

		const devPorts = portPool.getPortAssignments(task.id);
		const portExports = devPorts.length > 0
			? buildEnvExports(portPool.buildPortEnv(devPorts)).join("\n") + "\n"
			: "";

		const wrappedScript = [
			`#!/bin/bash`,
			...(portExports ? [portExports] : []),
			`set -x`,
			resolved.devScript,
			`EXIT_CODE=$?`,
			`set +x`,
			`if [ $EXIT_CODE -ne 0 ]; then`,
			`  echo ""`,
			`  echo "Process exited with code $EXIT_CODE. Press any key to close."`,
			`  read -n 1 -s`,
			`fi`,
			`# Detach the outer viewer pane before this pane closes so inner tmux redraws`,
			`# without a watching client — prevents escape sequence corruption in outer tmux.`,
			`tmux detach-client 2>/dev/null || true`,
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

		const taskSession = `dev3-${task.id.slice(0, 8)}`;
		const tmuxKill = socket
			? `tmux -L "${socket}" kill-session -t "${devSession}" 2>/dev/null`
			: `tmux kill-session -t "${devSession}" 2>/dev/null`;
		// Re-attach loop: after a deliberate detach (e.g. wrappedScript called
		// tmux detach-client before its pane closed), re-attach if the inner
		// session still exists (e.g. a frontend pane is still running).
		// The HUP trap lets kill-pane from stopDevServer exit cleanly.
		const attachCmd = socket
			? `bash -c 'trap "${tmuxKill}" EXIT; trap "exit" HUP; while TMUX= tmux -L "${socket}" has-session -t "${devSession}" 2>/dev/null; do TMUX= tmux -L "${socket}" attach-session -t "${devSession}"; done'`
			: `bash -c 'trap "${tmuxKill}" EXIT; trap "exit" HUP; while TMUX= tmux has-session -t "${devSession}" 2>/dev/null; do TMUX= tmux attach-session -t "${devSession}"; done'`;
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
			devViewerPaneIds.set(task.id, viewerPaneId);
			spawn(pty.tmuxArgs(socket, "select-pane", "-t", viewerPaneId, "-T", "Dev Server  (Ctrl+b Ctrl+b to control inner)")).exited.catch(() => {});
			spawn(pty.tmuxArgs(socket, "set-option", "-t", taskSession, "pane-border-status", "top")).exited.catch(() => {});
		}

		log.info("← runDevServer done", { devSession, viewerPaneId });
		return buildDevServerStatus(task, project.id, !!resolved.devScript.trim(), socket);
	} catch (err) {
		log.error("runDevServer FAILED", {
			taskId: params.taskId.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}
}

async function checkDevServer(params: { taskId: string; projectId: string }): Promise<{ running: boolean }> {
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
}

export async function stopDevServer(params: { taskId: string; projectId: string }): Promise<DevServerStatus> {
	log.info("→ stopDevServer", params);
	try {
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const resolved = await resolveOperationalProjectConfig(project, task.worktreePath ?? undefined);
		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killDevServerSession(task.id, socket);
		const taskSession = `dev3-${task.id.slice(0, 8)}`;
		spawn(pty.tmuxArgs(socket, "set-option", "-t", taskSession, "pane-border-status", "off")).exited.catch(() => {});
		log.info("← stopDevServer done");
		return buildDevServerStatus(task, project.id, !!resolved.devScript.trim(), socket);
	} catch (err) {
		log.error("stopDevServer FAILED", {
			taskId: params.taskId.slice(0, 8),
			error: String(err),
		});
		throw err;
	}
}

export async function getDevServerStatus(params: { taskId: string; projectId: string }): Promise<DevServerStatus> {
	log.info("→ getDevServerStatus", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const resolved = await resolveOperationalProjectConfig(project, task.worktreePath ?? undefined);
	const status = await buildDevServerStatus(task, project.id, !!resolved.devScript.trim());
	log.info("← getDevServerStatus", { running: status.running, ports: status.ports.length });
	return status;
}

async function openFileBrowser(params: { taskId: string; projectId: string }): Promise<{ notInstalled: true; installCommand: string; linuxHint?: boolean } | void> {
	log.info("→ openFileBrowser", params);
	try {
		const yaziCheckProc = spawn(["which", "yazi"], { stdout: "pipe", stderr: "pipe" });
		const yaziCheckExit = await yaziCheckProc.exited;
		if (yaziCheckExit !== 0) {
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
		const existingPane = fileBrowserPaneIds.get(task.id);
		if (existingPane) {
			const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", existingPane));
			await kill.exited;
			fileBrowserPaneIds.delete(task.id);
			log.info("← openFileBrowser: toggled off (killed pane)", { taskId: task.id.slice(0, 8), paneId: existingPane });
			return;
		}

		const listProc = spawn(pty.tmuxArgs(socket,
			"list-panes", "-t", tmuxSession,
			"-F", "#{pane_id} #{pane_current_command}",
		), { stdout: "pipe", stderr: "pipe" });
		const listOutput = await new Response(listProc.stdout).text();
		await listProc.exited;
		for (const line of listOutput.trim().split("\n")) {
			if (!line.includes("yazi")) continue;
			const paneId = line.split(" ")[0];
			const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", paneId));
			await kill.exited;
			log.info("← openFileBrowser: toggled off (found running yazi)", { taskId: task.id.slice(0, 8), paneId });
			return;
		}

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
}

async function getTerminalPreview(params: { taskId: string }): Promise<string | null> {
	return pty.capturePane(params.taskId);
}

async function checkWorktreeExists(params: { path: string }): Promise<boolean> {
	return existsSync(params.path);
}

async function getPtyUrl(params: { taskId: string; resume?: boolean }) {
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
		pty.destroySession(params.taskId);
	}

	// If session is in memory (alive or dead), verify the tmux session still
	// exists. When the tmux server is killed externally, the proc may or may
	// not have exited yet — but `has-session` is the ground truth.
	if (pty.hasSession(params.taskId)) {
		const socket = pty.getSessionSocket(params.taskId);
		if (!(await pty.tmuxSessionExists(params.taskId, socket))) {
			log.info("Session in memory but tmux session gone — destroying for recovery", {
				taskId: params.taskId.slice(0, 8),
			});
			pty.destroySession(params.taskId);
		}
	}

	// If no PTY session in memory, try to recreate it from persisted task data
	if (!pty.hasSession(params.taskId)) {
		log.info("No PTY session in memory, attempting to restore", {
			taskId: params.taskId.slice(0, 8),
		});

		const { task: foundTask, project: foundProject } = await findTaskAcrossProjects(params.taskId);

		if (foundTask && foundProject && isActive(foundTask.status) && foundTask.worktreePath) {
			const socket = foundTask.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
			const tmuxAlive = await pty.tmuxSessionExists(params.taskId, socket);

			if (tmuxAlive) {
				// Tmux session exists — just reconnect (no resume needed).
				// Skip session persist so we don't overwrite the real session ID.
				try {
					const resolvedProject = await repoConfig.resolveProjectConfig(foundProject, foundTask.worktreePath);
					await launchTaskPty(resolvedProject, foundTask, foundTask.worktreePath, foundTask.agentId, foundTask.configId, false, false, { skipSessionPersist: true });
					log.info("Reconnected to existing tmux session", { taskId: params.taskId.slice(0, 8) });
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
				// No tmux, no session state — launch fresh
				try {
					const resolvedProject = await repoConfig.resolveProjectConfig(foundProject, foundTask.worktreePath);
					await launchTaskPty(resolvedProject, foundTask, foundTask.worktreePath, foundTask.agentId, foundTask.configId, false, false);
					log.info("Launched fresh PTY session", { taskId: params.taskId.slice(0, 8) });
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

/** Find a task by ID across all projects. */
async function findTaskAcrossProjects(taskId: string): Promise<{ task: Task | null; project: Project | null }> {
	try {
		const projects = await data.loadProjects();
		for (const project of projects) {
			try {
				const task = await data.getTask(project, taskId);
				return { task, project };
			} catch {
				// task not in this project
			}
		}
	} catch (err) {
		log.error("Failed to load projects during task search", {
			taskId: taskId.slice(0, 8),
			error: String(err),
		});
	}
	return { task: null, project: null };
}

async function resumeTask(params: { taskId: string }): Promise<string> {
	log.info("→ resumeTask", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project || !task.worktreePath) {
		throw new Error(`Cannot resume: task ${params.taskId} not found or has no worktree`);
	}
	const panes = task.sessionState?.panes;
	if (!panes?.length) {
		throw new Error(`Cannot resume: task ${params.taskId} has no stored pane sessions`);
	}

	// Destroy any dead session in memory
	if (pty.hasSession(params.taskId)) {
		pty.destroySession(params.taskId);
	}

	// Launch main pane (panes[0]) with resume
	const main = panes[0];
	const resolvedProject = await repoConfig.resolveProjectConfig(project, task.worktreePath);
	await launchTaskPty(
		resolvedProject,
		task,
		task.worktreePath,
		main.agentId,
		main.configId,
		false,
		true,
		main.sessionId ? { sessionId: main.sessionId } : undefined,
	);

	// Resume extra panes (panes[1..]) via split-window.
	// Wait for the tmux session to be ready before splitting.
	if (panes.length > 1) {
		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		const maxWaitMs = 3000;
		const pollMs = 100;
		let waited = 0;
		while (!(await pty.tmuxSessionExists(params.taskId, socket)) && waited < maxWaitMs) {
			await new Promise(r => setTimeout(r, pollMs));
			waited += pollMs;
		}
		if (!(await pty.tmuxSessionExists(params.taskId, socket))) {
			log.warn("Tmux session not ready after wait — skipping extra pane resume", { taskId: params.taskId.slice(0, 8) });
		} else {
			const ctx: agents.TemplateContext = {
				taskTitle: task.title,
				taskDescription: "",
				projectName: project.name,
				projectPath: project.path,
				worktreePath: task.worktreePath,
			};
			const paneIdUpdates: Array<{ index: number; paneId: string }> = [];
			for (let i = 1; i < panes.length; i++) {
				const pane = panes[i];
				try {
					const cmdOpts: agents.CommandOptions = { resume: true };
					if (pane.sessionId) cmdOpts.sessionId = pane.sessionId;
					let resumeCmd: string;
					let extraEnv: Record<string, string> = {};
					if (pane.agentId) {
						const resolved = await agents.resolveCommandForAgent(pane.agentId, pane.configId, ctx, cmdOpts);
						resumeCmd = resolved.command;
						extraEnv = resolved.extraEnv;
					} else {
						resumeCmd = agents.buildResumeCommand(pane.agentCmd, pane.sessionId ?? undefined) ?? pane.agentCmd;
					}
					const scriptPath = `/tmp/dev3-${params.taskId}-resume-pane-${i}.sh`;
					await Bun.write(scriptPath, buildCmdScript(resumeCmd, extraEnv, { keepShell: true }));
					const wrappedCmd = `bash "${scriptPath}"`;
					const newPaneId = await pty.splitAndRunCommand(params.taskId, socket, wrappedCmd, task.worktreePath);
					if (newPaneId) paneIdUpdates.push({ index: i, paneId: newPaneId });
					log.info("Resumed extra pane", { taskId: params.taskId.slice(0, 8), paneIndex: i, paneId: newPaneId, command: resumeCmd.slice(0, 100) });
				} catch (err) {
					log.warn("Failed to resume extra pane", { taskId: params.taskId.slice(0, 8), paneIndex: i, error: String(err) });
				}
			}
			// Update pane IDs in sessionState (pane IDs change across tmux server restarts)
			if (paneIdUpdates.length > 0) {
				try {
					const freshTask = await data.getTask(project, params.taskId);
					const updatedPanes = [...(freshTask.sessionState?.panes ?? [])];
					for (const { index, paneId } of paneIdUpdates) {
						if (updatedPanes[index]) updatedPanes[index] = { ...updatedPanes[index], paneId };
					}
					await data.updateTask(project, params.taskId, { sessionState: { panes: updatedPanes } });
				} catch (err) {
					log.warn("Failed to update pane IDs after resume (non-fatal)", { error: String(err) });
				}
			}
		}
	}

	const url = `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
	log.info("← resumeTask", { url });
	return url;
}

async function restartTask(params: { taskId: string }): Promise<string> {
	log.info("→ restartTask", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project || !task.worktreePath) {
		throw new Error(`Cannot restart: task ${params.taskId} not found or has no worktree`);
	}

	// Destroy any dead session in memory
	if (pty.hasSession(params.taskId)) {
		pty.destroySession(params.taskId);
	}

	// Remember agent info before clearing
	const mainPane = task.sessionState?.panes?.[0];
	const agentId = mainPane?.agentId ?? task.agentId;
	const configId = mainPane?.configId ?? task.configId;

	// Clear old session state — a new one will be generated by launchTaskPty
	await data.updateTask(project, task.id, { sessionState: null });

	const resolvedProject = await repoConfig.resolveProjectConfig(project, task.worktreePath);
	await launchTaskPty(
		resolvedProject,
		task,
		task.worktreePath,
		agentId,
		configId,
		false,
		false,
	);

	const url = `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
	log.info("← restartTask", { url });
	return url;
}

async function getProjectPtyUrl(params: { projectId: string }): Promise<string> {
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
		if (!existsSync(project.path)) {
			throw new Error(`Project path does not exist: ${project.path}`);
		}
		pty.createSession(sessionKey, params.projectId, project.path, getUserShell(), {}, pty.DEFAULT_TMUX_SOCKET, "project");
	}

	const url = `ws://localhost:${pty.getPtyPort()}?session=${sessionKey}`;
	log.info("← getProjectPtyUrl", { url });
	return url;
}

async function destroyProjectTerminal(params: { projectId: string }): Promise<void> {
	const sessionKey = `project-${params.projectId}`;
	log.info("→ destroyProjectTerminal", { projectId: params.projectId.slice(0, 8) });
	pty.destroySession(sessionKey);
	log.info("← destroyProjectTerminal done");
}

async function getHomePtyUrl(_params: {}): Promise<string> {
	const sessionKey = pty.HOME_TERMINAL_SESSION_KEY;
	log.info("→ getHomePtyUrl", { hasExistingSession: pty.hasSession(sessionKey) });

	if (pty.hasDeadSession(sessionKey)) {
		log.info("Dead home terminal session — destroying to recreate");
		pty.destroySession(sessionKey);
	}

	if (!pty.hasSession(sessionKey)) {
		const home = homedir();
		if (!existsSync(home)) {
			throw new Error(`Home directory does not exist: ${home}`);
		}
		pty.createSession(sessionKey, "", home, getUserShell(), {}, pty.DEFAULT_TMUX_SOCKET, "home");
	}

	const url = `ws://localhost:${pty.getPtyPort()}?session=${sessionKey}`;
	log.info("← getHomePtyUrl", { url });
	return url;
}

async function destroyHomeTerminal(_params: {}): Promise<void> {
	log.info("→ destroyHomeTerminal");
	pty.destroySession(pty.HOME_TERMINAL_SESSION_KEY);
	log.info("← destroyHomeTerminal done");
}

async function getTaskPorts(params: { taskId: string }): Promise<PortInfo[]> {
	log.info("→ getTaskPorts", { taskId: params.taskId.slice(0, 8) });
	const ports = getPortsForTask(params.taskId);
	log.info("← getTaskPorts", { taskId: params.taskId.slice(0, 8), count: ports.length });
	return ports;
}

async function getPortAllocations(params: { taskId: string }): Promise<number[]> {
	return portPool.getPortAssignments(params.taskId);
}

async function listTmuxSessions(): Promise<TmuxSessionInfo[]> {
	log.debug("→ listTmuxSessions");

	const format = "#{session_name}|#{pane_current_path}|#{session_windows}|#{session_created}";
	const proc = spawn(pty.tmuxArgs(pty.DEFAULT_TMUX_SOCKET, "list-sessions", "-F", format), { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.debug("← listTmuxSessions (no tmux server or error)", { exitCode });
		return [];
	}

	const taskShortIds = new Set<string>();
	const projectShortIds = new Set<string>();
	const rawSessions: Array<{
		name: string;
		cwd: string;
		createdAt: number;
		windowCount: number;
		isCleanup: boolean;
		isProjectTerminal: boolean;
		isHomeTerminal: boolean;
		shortId: string;
	}> = [];

	for (const line of output.trim().split("\n")) {
		if (!line) continue;
		const [name, cwd, windowsStr, createdStr] = line.split("|");
		if (!name.startsWith("dev3-")) continue;
		if (name.startsWith("dev3-dev-")) continue;

		const isCleanup = name.startsWith("dev3-cl-");
		const isProjectTerminal = name.startsWith("dev3-pt-");
		const isHomeTerminal = name === pty.HOME_TERMINAL_TMUX_NAME;
		const shortId = isHomeTerminal
			? "home"
			: isProjectTerminal
				? name.slice(8)
				: isCleanup
					? name.slice(8)
					: name.slice(5);
		if (!shortId) continue;

		rawSessions.push({
			name,
			cwd: cwd || "",
			createdAt: parseInt(createdStr, 10) || 0,
			windowCount: parseInt(windowsStr, 10) || 1,
			isCleanup,
			isProjectTerminal,
			isHomeTerminal,
			shortId,
		});

		if (isProjectTerminal) {
			projectShortIds.add(shortId);
		} else if (!isHomeTerminal) {
			taskShortIds.add(shortId);
		}
	}

	if (rawSessions.length === 0) {
		log.debug("← listTmuxSessions", { count: 0 });
		return [];
	}

	const taskMap = new Map<string, { title: string; taskId: string; projectId: string }>();
	const projectMap = new Map<string, { name: string; projectId: string }>();
	try {
		const projects = await data.loadProjects();
		const pendingTaskIds = new Set(taskShortIds);

		for (const project of projects) {
			const shortProjectId = project.id.slice(0, 8);
			if (projectShortIds.has(shortProjectId)) {
				projectMap.set(shortProjectId, { name: project.name, projectId: project.id });
			}

			if (pendingTaskIds.size === 0) {
				if (projectMap.size === projectShortIds.size) break;
				continue;
			}

			const tasks = await data.loadTasks(project);
			for (const task of tasks) {
				const shortTaskId = task.id.slice(0, 8);
				if (!pendingTaskIds.has(shortTaskId)) continue;
				taskMap.set(shortTaskId, {
					title: getTaskTitle(task),
					taskId: task.id,
					projectId: project.id,
				});
				pendingTaskIds.delete(shortTaskId);
			}

			if (pendingTaskIds.size === 0 && projectMap.size === projectShortIds.size) break;
		}
	} catch {}

	const sessions: TmuxSessionInfo[] = [];
	for (const rawSession of rawSessions) {
		const { name, cwd, windowCount, createdAt, isCleanup, isProjectTerminal, isHomeTerminal, shortId } = rawSession;
		if (isHomeTerminal) {
			sessions.push({
				name,
				cwd,
				createdAt,
				windowCount,
				isCleanup: false,
				isHomeTerminal: true,
			});
			continue;
		}
		if (isProjectTerminal) {
			const projectInfo = projectMap.get(shortId);
			sessions.push({
				name,
				cwd,
				createdAt,
				windowCount,
				isCleanup: false,
				isProjectTerminal: true,
				projectName: projectInfo?.name,
				projectId: projectInfo?.projectId,
			});
			continue;
		}

		const taskInfo = taskMap.get(shortId);

		sessions.push({
			name,
			cwd,
			createdAt,
			windowCount,
			isCleanup,
			taskTitle: taskInfo?.title,
			taskId: taskInfo?.taskId,
			projectId: taskInfo?.projectId,
			ports: taskInfo?.taskId ? getPortsForTask(taskInfo.taskId) : undefined,
			resourceUsage: taskInfo?.taskId ? getResourceUsage(taskInfo.taskId) : undefined,
		});
	}

	sessions.sort((a, b) => b.createdAt - a.createdAt);
	log.debug("← listTmuxSessions", { count: sessions.length });
	return sessions;
}

async function killTmuxSession(params: { sessionName: string }): Promise<void> {
	log.info("→ killTmuxSession", { sessionName: params.sessionName });
	if (!params.sessionName.startsWith("dev3-")) {
		throw new Error("Can only kill dev3-* sessions");
	}
	const proc = spawn(
		pty.tmuxArgs(pty.DEFAULT_TMUX_SOCKET, "kill-session", "-t", params.sessionName),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.error("killTmuxSession failed", { sessionName: params.sessionName, stderr: stderr.trim() });
		throw new Error(`Failed to kill session: ${stderr.trim()}`);
	}

	if (!params.sessionName.startsWith("dev3-dev-")) {
		const devSession = `dev3-dev-${params.sessionName.slice("dev3-".length)}`;
		const devKill = spawn(pty.tmuxArgs(pty.DEFAULT_TMUX_SOCKET, "kill-session", "-t", devSession), { stdout: "pipe", stderr: "pipe" });
		await devKill.exited;
		log.info("killTmuxSession: killed dev server session (best-effort)", { devSession });
	}

	log.info("← killTmuxSession done", { sessionName: params.sessionName });
}

async function tmuxAction(params: { taskId: string; action: "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" | "nextLayout" | "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV"; force?: boolean }): Promise<void> {
	log.info("→ tmuxAction", { taskId: params.taskId.slice(0, 8), action: params.action, force: params.force === true });
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	// For killPane, capture the active pane ID before killing — kill-pane
	// does NOT trigger tmux's pane-exited hook, so we must clean up sessionState here.
	// By default refuse to kill the last remaining pane in the session — otherwise an
	// accidental click on the red button takes down the agent's own pane. The frontend
	// can pass `force: true` after explicit user confirmation to allow it.
	let killedPaneId: string | null = null;
	if (params.action === "killPane") {
		if (!params.force) {
			try {
				const countProc = spawn(pty.tmuxArgs(socket, "list-panes", "-s", "-t", tmuxSession, "-F", "#{pane_id}"), { stdout: "pipe", stderr: "pipe" });
				const countStdout = await new Response(countProc.stdout).text();
				const countExit = await countProc.exited;
				if (countExit === 0) {
					const paneCount = countStdout.trim().split("\n").filter((l) => l.length > 0).length;
					if (paneCount <= 1) {
						log.info("tmuxAction killPane refused — last pane in session", { taskId: params.taskId.slice(0, 8), paneCount });
						return;
					}
				}
			} catch { /* best effort — if counting fails, fall through to the normal kill */ }
		}

		try {
			const idProc = spawn(pty.tmuxArgs(socket, "display-message", "-t", tmuxSession, "-p", "#{pane_id}"), { stdout: "pipe", stderr: "pipe" });
			const idStdout = await new Response(idProc.stdout).text();
			const idExit = await idProc.exited;
			if (idExit === 0) {
				killedPaneId = idStdout.trim() || null;
			}
		} catch { /* best effort */ }
	}

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
		case "nextLayout":
			args = pty.tmuxArgs(socket, "next-layout", "-t", tmuxSession);
			break;
		case "layoutTiled":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "tiled");
			break;
		case "layoutEvenH":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "even-vertical");
			break;
		case "layoutEvenV":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "even-horizontal");
			break;
		case "layoutMainH":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "main-horizontal");
			break;
		case "layoutMainV":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "main-vertical");
			break;
	}

	const proc = spawn(args, { stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.error("tmuxAction failed", { action: params.action, exitCode, stderr: stderr.trim() });
		throw new Error(`tmux ${params.action} failed: ${stderr.trim() || "unknown error"}`);
	}

	// Remove killed pane from sessionState
	if (params.action === "killPane" && killedPaneId) {
		handlePaneExited(params.taskId, killedPaneId).catch((err) => {
			log.warn("Failed to clean up killed pane from sessionState", { error: String(err) });
		});
	}

	log.info("← tmuxAction done", { taskId: params.taskId.slice(0, 8), action: params.action });
}

async function tmuxPaneCount(params: { taskId: string }): Promise<{ count: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);
	try {
		const proc = spawn(pty.tmuxArgs(socket, "list-panes", "-s", "-t", tmuxSession, "-F", "#{pane_id}"), { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return { count: 0 };
		}
		const count = stdout.trim().split("\n").filter((l) => l.length > 0).length;
		return { count };
	} catch {
		return { count: 0 };
	}
}

async function exitCopyModeInSession(socket: string, tmuxSession: string): Promise<number> {
	const listProc = spawn(
		pty.tmuxArgs(socket, "list-panes", "-s", "-t", tmuxSession, "-F", "#{pane_id} #{pane_in_mode}"),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const listOutput = await new Response(listProc.stdout).text();
	const listExit = await listProc.exited;
	if (listExit !== 0) {
		return 0;
	}

	const panesInMode: string[] = [];
	for (const line of listOutput.trim().split("\n")) {
		if (!line) continue;
		const [paneId, inMode] = line.split(" ");
		if (paneId && inMode === "1") {
			panesInMode.push(paneId);
		}
	}

	for (const paneId of panesInMode) {
		const cancelProc = spawn(
			pty.tmuxArgs(socket, "send-keys", "-t", paneId, "-X", "cancel"),
			{ stdout: "pipe", stderr: "pipe" },
		);
		await cancelProc.exited;
	}

	return panesInMode.length;
}

async function exitCopyModeAllPanes(params: { taskId: string }): Promise<{ panesExited: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	const taskSession = pty.getSessionTmuxName(params.taskId);
	const devSession = devServerSessionName(params.taskId);

	// dev-server lives in a separate tmux session (dev3-dev-<id>) — the user's
	// scroll-mode is typically there, not in the agent session. Hit both.
	const sessions: string[] = [];
	if (await pty.tmuxSessionExists(params.taskId, socket)) {
		sessions.push(taskSession);
	}
	if (await isDevServerRunning(params.taskId, socket)) {
		sessions.push(devSession);
	}

	let total = 0;
	for (const session of sessions) {
		total += await exitCopyModeInSession(socket, session);
	}

	if (total > 0) {
		log.info("Exited copy-mode in panes", { taskId: params.taskId.slice(0, 8), count: total, sessions });
	}
	return { panesExited: total };
}

async function spawnAgentInTask(params: { taskId: string; projectId: string; agentId: string | null; configId: string | null }): Promise<void> {
	log.info("→ spawnAgentInTask", { taskId: params.taskId.slice(0, 8), agentId: params.agentId, configId: params.configId });

	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) {
		throw new Error("Task has no worktree — cannot spawn agent");
	}

	const ctx: agents.TemplateContext = {
		taskTitle: "",
		taskDescription: "",
		projectName: project.name,
		projectPath: project.path,
		worktreePath: task.worktreePath,
	};

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";

	// Pre-assign a session ID for Claude so we can recover this pane later
	const freshSessionId = crypto.randomUUID();
	const cmdOptions: agents.CommandOptions = { sessionId: freshSessionId };

	if (params.agentId) {
		const resolved = await agents.resolveCommandForAgent(params.agentId, params.configId, ctx, cmdOptions);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
	} else {
		const resolved = await agents.resolveCommandForProject(
			project,
			task.title,
			task.description,
			task.worktreePath,
			undefined,
			cmdOptions,
		);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
	}

	const env: Record<string, string> = buildAgentEnv(extraEnv, task.id);

	const existingPorts = portPool.getPortAssignments(task.id);
	if (existingPorts.length > 0) {
		Object.assign(env, portPool.buildPortEnv(existingPorts));
	}

	const scriptPath = `/tmp/dev3-${task.id}-spawn-${Date.now()}.sh`;
	await Bun.write(scriptPath, buildCmdScript(tmuxCmd, env));

	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = `dev3-${params.taskId.slice(0, 8)}`;
	const args = pty.tmuxArgs(socket, "split-window", "-h", "-P", "-F", "#{pane_id}", "-c", task.worktreePath, "-t", tmuxSession, `bash "${scriptPath}"`);
	const proc = spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.error("spawnAgentInTask failed", { exitCode, stderr: stderr.trim() });
		throw new Error(`Failed to spawn agent: ${stderr.trim() || "unknown error"}`);
	}

	const newPaneId = stdout.trim() || null;

	// Append this pane to sessionState for recovery
	const paneEntry = {
		paneId: newPaneId,
		agentCmd: resolvedBaseCmd,
		sessionId: agents.supportsPreAssignedSessionId(resolvedBaseCmd) ? freshSessionId : null,
		agentId: params.agentId,
		configId: params.configId,
	};
	const existingPanes = task.sessionState?.panes ?? [];
	try {
		await data.updateTask(project, task.id, {
			sessionState: { panes: [...existingPanes, paneEntry] },
		});
		log.info("Appended pane to sessionState", { taskId: params.taskId.slice(0, 8), paneCount: existingPanes.length + 1 });
	} catch (err) {
		log.error("Failed to append pane to sessionState (non-fatal)", { error: String(err) });
	}

	log.info("← spawnAgentInTask done", { taskId: params.taskId.slice(0, 8) });
}

/**
 * Called when a tmux pane exits. Reconciles sessionState against live panes
 * rather than matching by exact paneId — this handles setup panes, unmanaged
 * panes, and entries that never got a paneId assigned.
 *
 * Algorithm:
 * 1. Remove entries whose paneId is set and not in the live pane set.
 * 2. If exactly one entry has paneId=null and exactly one live pane is
 *    unmatched, assign it (the setup pane exited, leaving the real agent).
 * 3. If no live panes remain and null-paneId entries exist, remove them too.
 */
export async function handlePaneExited(taskId: string, _exitedPaneId: string): Promise<void> {
	try {
		const { task, project } = await findTaskAcrossProjects(taskId);
		if (!task || !project) return;
		const panes = task.sessionState?.panes ?? [];
		if (!panes.length) return;

		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		const livePaneIds = new Set(await pty.listPaneIds(taskId, socket));

		// Step 1: remove entries with a known paneId that is no longer alive
		let surviving = panes.filter(p => !p.paneId || livePaneIds.has(p.paneId));

		// Step 2: try to assign paneId to null entries via 1:1 matching
		const matchedIds = new Set(surviving.filter(p => p.paneId).map(p => p.paneId!));
		const unmatchedLive = [...livePaneIds].filter(id => !matchedIds.has(id));
		const nullEntries = surviving.filter(p => !p.paneId);

		if (nullEntries.length === 1 && unmatchedLive.length === 1) {
			// High confidence: the one unmatched live pane is the one null entry's agent
			nullEntries[0] = { ...nullEntries[0], paneId: unmatchedLive[0] };
			surviving = surviving.map(p => !p.paneId ? nullEntries[0] : p);
			log.info("Reconciled paneId for unmatched entry", { taskId: taskId.slice(0, 8), paneId: unmatchedLive[0] });
		} else if (unmatchedLive.length === 0 && nullEntries.length > 0) {
			// No live panes left to match — these agents are dead
			surviving = surviving.filter(p => !!p.paneId);
		}

		if (surviving.length !== panes.length || surviving.some((p, i) => p.paneId !== panes[i].paneId)) {
			await data.updateTask(project, task.id, { sessionState: { panes: surviving } });
			log.info("Reconciled sessionState after pane exit", {
				taskId: taskId.slice(0, 8),
				before: panes.length,
				after: surviving.length,
				livePanes: [...livePaneIds],
			});
		}
	} catch (err) {
		log.warn("handlePaneExited failed (non-fatal)", { taskId: taskId.slice(0, 8), error: String(err) });
	}
}

export const tmuxPtyHandlers = {
	runDevServer,
	checkDevServer,
	stopDevServer,
	getDevServerStatus,
	openFileBrowser,
	getTerminalPreview,
	checkWorktreeExists,
	getPtyUrl,
	getProjectPtyUrl,
	destroyProjectTerminal,
	getHomePtyUrl,
	destroyHomeTerminal,
	getTaskPorts,
	getPortAllocations,
	listTmuxSessions,
	killTmuxSession,
	tmuxAction,
	tmuxPaneCount,
	exitCopyModeAllPanes,
	spawnAgentInTask,
	resumeTask,
	restartTask,
};
