import { existsSync } from "node:fs";
import type { ColumnAgentConfig, PortInfo, Project, Task, TmuxSessionInfo } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import * as data from "../data";
import * as pty from "../pty-server";
import * as agents from "../agents";
import * as portPool from "../port-pool";
import * as repoConfig from "../repo-config";
import { getPortsForTask } from "../port-scanner";
import { getResourceUsage } from "../resource-monitor";
import { loadSettings } from "../settings";
import { spawn, spawnSync } from "../spawn";
import { setupAgentHooks } from "../agent-hooks";
import { isActive, buildAgentEnv, buildCmdScript, buildEnvExports, escapeForDoubleQuotes, log, resolveBinaryPath, shellQuote } from "./shared";
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

async function killDevServerViewerPane(taskId: string, taskSession: string, devSession: string, socket: string): Promise<void> {
	let viewerPaneId = devViewerPaneIds.get(taskId);
	if (!viewerPaneId) {
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
	}
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
				ctx.taskDescription,
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

	const env = buildAgentEnv(extraEnv, task.id);

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
			await Bun.write(originalCmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true }));

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
		await Bun.write(cmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true }));

		const splitCmd = `tmux split-window -v -c "${escapeForDoubleQuotes(worktreePath)}" "bash '${cmdPath}'"`;
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

		const startupLines = [
			"#!/bin/bash",
			...(setupScriptLaunchMode === "parallel" ? [splitCmd] : []),
			`bash -x "${setupPath}"`,
			"S=$?",
			`if [ $S -ne 0 ]; then`,
			setupFail,
			"fi",
			...(setupScriptLaunchMode === "blocking" ? [splitCmd] : []),
			setupOkClose,
		];
		await Bun.write(startupPath, startupLines.join("\n") + "\n");
		tmuxCmd = `bash "${startupPath}"`;
		isSetupWrapper = true;
	}

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
			spawnSync(killArgs, { stdout: "pipe", stderr: "pipe" });
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
		spawnSync(focusArgs, { stdout: "pipe", stderr: "pipe" });
	} catch {}

	log.info("launchColumnAgent DONE", { taskId: task.id.slice(0, 8) });
}

export function cleanupTaskTmuxState(taskId: string): void {
	fileBrowserPaneIds.delete(taskId);
	devViewerPaneIds.delete(taskId);
}

async function runDevServer(params: { taskId: string; projectId: string }): Promise<void> {
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

async function stopDevServer(params: { taskId: string; projectId: string }): Promise<void> {
	log.info("→ stopDevServer", params);
	try {
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killDevServerSession(task.id, socket);
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
}

async function openFileBrowser(params: { taskId: string; projectId: string }): Promise<{ notInstalled: true; installCommand: string; linuxHint?: boolean } | void> {
	log.info("→ openFileBrowser", params);
	try {
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

function shouldResumeRestoredTask(task: Task, requestedResume?: boolean): boolean {
	if (requestedResume) return true;
	return isActive(task.status) && !!task.worktreePath;
}

async function getPtyUrl(params: { taskId: string; resume?: boolean }): Promise<string> {
	log.info("→ getPtyUrl", {
		taskId: params.taskId,
		hasExistingSession: pty.hasSession(params.taskId),
		hasDeadSession: pty.hasDeadSession(params.taskId),
		ptyPort: pty.getPtyPort(),
	});

	// Dead in-memory sessions keep the original tmux command, which would
	// replay the initial prompt if the websocket path respawns them directly.
	// Always destroy them and go through the normal restore path instead.
	if (pty.hasDeadSession(params.taskId)) {
		log.info("Dead session detected — destroying to force clean restoration", {
			taskId: params.taskId.slice(0, 8),
			resumeRequested: !!params.resume,
		});
		pty.destroySession(params.taskId);
	}

	if (!pty.hasSession(params.taskId)) {
		log.info("No PTY session in memory, attempting to restore", {
			taskId: params.taskId.slice(0, 8),
		});

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
				} catch {}
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
				const resolvedProject = await repoConfig.resolveProjectConfig(foundProject, foundTask.worktreePath);
				const shouldResume = shouldResumeRestoredTask(foundTask, params.resume);
				log.info("Attempting to restore PTY session", {
					taskId: params.taskId.slice(0, 8),
					status: foundTask.status,
					worktreePath: foundTask.worktreePath,
					resume: shouldResume,
				});
				await launchTaskPty(resolvedProject, foundTask, foundTask.worktreePath, foundTask.agentId, foundTask.configId, false, shouldResume);
				log.info("Restored PTY session for active task", {
					taskId: params.taskId.slice(0, 8),
					worktreePath: foundTask.worktreePath,
					resume: shouldResume,
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
		const userShell = process.env.SHELL || "/bin/zsh";
		pty.createSession(sessionKey, params.projectId, project.path, userShell, {}, pty.DEFAULT_TMUX_SOCKET, "project");
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
	const proc = spawn(pty.tmuxArgs("dev3", "list-sessions", "-F", format), { stdout: "pipe", stderr: "pipe" });
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
		shortId: string;
	}> = [];

	for (const line of output.trim().split("\n")) {
		if (!line) continue;
		const [name, cwd, windowsStr, createdStr] = line.split("|");
		if (!name.startsWith("dev3-")) continue;
		if (name.startsWith("dev3-dev-")) continue;

		const isCleanup = name.startsWith("dev3-cl-");
		const isProjectTerminal = name.startsWith("dev3-pt-");
		const shortId = isProjectTerminal ? name.slice(8) : isCleanup ? name.slice(8) : name.slice(5);
		if (!shortId) continue;

		rawSessions.push({
			name,
			cwd: cwd || "",
			createdAt: parseInt(createdStr, 10) || 0,
			windowCount: parseInt(windowsStr, 10) || 1,
			isCleanup,
			isProjectTerminal,
			shortId,
		});

		if (isProjectTerminal) {
			projectShortIds.add(shortId);
		} else {
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
		const { name, cwd, windowCount, createdAt, isCleanup, isProjectTerminal, shortId } = rawSession;
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
		pty.tmuxArgs("dev3", "kill-session", "-t", params.sessionName),
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
		const devKill = spawn(pty.tmuxArgs("dev3", "kill-session", "-t", devSession), { stdout: "pipe", stderr: "pipe" });
		await devKill.exited;
		log.info("killTmuxSession: killed dev server session (best-effort)", { devSession });
	}

	log.info("← killTmuxSession done", { sessionName: params.sessionName });
}

async function tmuxAction(params: { taskId: string; action: "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" | "nextLayout" | "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV" }): Promise<void> {
	log.info("→ tmuxAction", { taskId: params.taskId.slice(0, 8), action: params.action });
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

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
	log.info("← tmuxAction done", { taskId: params.taskId.slice(0, 8), action: params.action });
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

	const env: Record<string, string> = buildAgentEnv(extraEnv, task.id);

	const existingPorts = portPool.getPortAssignments(task.id);
	if (existingPorts.length > 0) {
		Object.assign(env, portPool.buildPortEnv(existingPorts));
	}

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
}

export const tmuxPtyHandlers = {
	runDevServer,
	checkDevServer,
	stopDevServer,
	openFileBrowser,
	getTerminalPreview,
	checkWorktreeExists,
	getPtyUrl,
	getProjectPtyUrl,
	destroyProjectTerminal,
	getTaskPorts,
	getPortAllocations,
	listTmuxSessions,
	killTmuxSession,
	tmuxAction,
	spawnAgentInTask,
};
