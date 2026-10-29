import { assertTaskWorkspacePresent } from "../../task-workspace-guard";
import type { AgentFamily, ColumnAgentConfig, PermissionMode, Project, Task } from "../../../shared/types";
import * as data from "../../data";
import * as git from "../../git";
import * as pty from "../../pty-server";
import * as agents from "../../agents";
import { codexAccountIdForHome } from "../../agent-accounts";
import { autoRoutingContext, releaseAccountReservation } from "../../account-router";
import { getAgentAdapter } from "../../../shared/agent-adapters/registry";
import { agentKey } from "../../../shared/agent-adapters/families";
import { evaluateCodexModelSupport } from "../../../shared/agent-model-cli-requirements";
import * as portPool from "../../port-pool";
import * as repoConfig from "../../repo-config";
import { loadSettings } from "../../settings";
import { getUserShell } from "../../shell-env";
import { agentInstallCommand } from "../../../shared/agent-install";
import { resolveAgentLaunchBinary } from "../../agent-launch-availability";
import { setupAgentHooks } from "../../agent-hooks";
import { CLAUDE_STATUSLINE_SETTINGS_PATH } from "../../rate-limit-monitor";
import { quoteIfUnsafe } from "../../../shared/agent-adapters/shell";
import { ensureArtifactTemplateEnv } from "../../artifact-template";
import { tmux, DEFAULT_TMUX_SOCKET, TmuxError, taskSessionName } from "../../tmux";
import { markAgentPane } from "../../agent-prompt";
import { noteDev3TypedPrompt } from "../../agent-typed-prompt-claims";
import { clearSetupExitCode, dev3TaskTempPath, setupExitCodePath } from "../../temp-paths";
import { stopSetupFailureWatch, watchSetupFailure } from "../../setup-failure-watch";
import { taskTerminalBackendIdentity } from "../../task-terminal-backend";
import { AGENT_EXITED_METHOD, AGENT_SESSION_STARTED_METHOD, noteAgentLaunched } from "../../agent-session-receipts";
import { hookCliSupports } from "../../hook-cli-capability";
import { claudeSessionStartHookInstalled } from "../../../shared/agent-hooks";
import { openAuxPane } from "../../task-aux-panes";
import { getPushMessage, AGENT_ENV_DEFAULTS, buildAgentEnv, buildAgentRetryWrapper, buildCmdScript, buildModelVersionGateWrapper, buildSetupStartupWrapper, buildScriptRunnerCommand, buildTaskLifecycleEnv, withResolvedCodexBinary, agentExitReportArgv, generatedScriptLaunch, generatedScriptName, log, writeLaunchScript } from "../shared-pure";
import { launchDialect } from "../../../shared/platform-launch";
import { devViewerPaneIds, setTmuxSessionPortEnv } from "./dev-servers";
import { fileBrowserPaneIds, findTaskAcrossProjects } from "./task-state";

const MAIN_AGENT_PANE_CAPTURE_ATTEMPTS = 10;

const MAIN_AGENT_PANE_CAPTURE_INTERVAL_MS = 100;

async function waitForTaskTmuxSession(taskId: string, socket: string): Promise<void> {
	for (let attempt = 0; attempt < MAIN_AGENT_PANE_CAPTURE_ATTEMPTS; attempt++) {
		if (await pty.tmuxSessionExists(taskId, socket)) return;
		if (attempt < MAIN_AGENT_PANE_CAPTURE_ATTEMPTS - 1) {
			await new Promise((resolve) => setTimeout(resolve, MAIN_AGENT_PANE_CAPTURE_INTERVAL_MS));
		}
	}
	const mismatch = tmux.serverVersionMismatch();
	if (mismatch) {
		throw new Error(
			`tmux ${mismatch.clientVersion} cannot attach to the running tmux ${mismatch.serverVersion} server, ` +
			`so ${taskSessionName(taskId)} was not created. Open the tmux Sessions menu in the header, ` +
			"choose Kill All, then retry.",
		);
	}
	throw new Error(
		`tmux started but did not create session ${taskSessionName(taskId)}. ` +
			"Run `dev3 doctor` to verify the selected tmux binary, then retry.",
	);
}

/**
 * Store the initial agent pane before Codex has emitted its first lifecycle
 * hook. Otherwise Create PR may fall back to a focused shell pane.
 *
 * Setup wrappers are excluded because they initially run in a non-agent pane;
 * their eventual agent pane is captured by the lifecycle hook or exit
 * reconciliation instead.
 */
async function persistInitialAgentPaneId(
	project: Project,
	task: Task,
	socket: string,
	paneEntry: NonNullable<Task["sessionState"]>["panes"][number],
): Promise<void> {
	for (let attempt = 0; attempt < MAIN_AGENT_PANE_CAPTURE_ATTEMPTS; attempt++) {
		const paneIds = await pty.listPaneIds(task.id, socket);
		if (paneIds.length === 1 && paneIds[0]) {
			const current = await data.getTask(project, task.id);
			await data.updateTask(project, task.id, {
				sessionState: { panes: [{ ...paneEntry, paneId: paneIds[0] }, ...(current?.sessionState?.panes.slice(1) ?? [])] },
			});
			void markAgentPane(socket, paneIds[0]);
			log.info("Persisted initial agent pane ID", {
				taskId: task.id.slice(0, 8),
				paneId: paneIds[0],
			});
			return;
		}

		if (attempt < MAIN_AGENT_PANE_CAPTURE_ATTEMPTS - 1) {
			await new Promise((resolve) => setTimeout(resolve, MAIN_AGENT_PANE_CAPTURE_INTERVAL_MS));
		}
	}

	log.warn("Could not capture initial agent pane ID", { taskId: task.id.slice(0, 8) });
}

/**
 * Register worktree trust for the resolved agent's CLI before spawning it.
 * `launchEnv` is the env the agent will be launched with, so Claude trust and the
 * dev3 skills land in the config dir its `CLAUDE_CONFIG_DIR` names, if any.
 * Claude trust (with MCP pre-approval) is always ensured; Codex/Gemini trust
 * only for their respective CLIs. Codex trust also re-patches ~/.codex/config.toml
 * — stripping the legacy `[profiles.dev3-*]` tables / top-level `profile = "..."`
 * selectors that codex ≥0.134 rejects and (re)writing the per-profile files. All
 * calls are idempotent and non-fatal: a failure logs and continues so a trust
 * hiccup never blocks the launch.
 *
 * MUST run before EVERY agent spawn. It used to be inlined only in the primary
 * task launch; the extra-agent (`spawnAgentInTask`) and bug-hunter panes skipped
 * it, so a spawned Codex pane launched against a stale config.toml and crashed
 * with `--profile dev3-dark cannot be used while ... contains legacy profile`.
 */
export async function ensureAgentTrust(
	worktreePath: string,
	projectPath: string,
	resolvedBaseCmd: string,
	accountId?: string | null,
	foreignCode?: boolean,
	family?: AgentFamily,
	launchEnv?: Record<string, string>,
): Promise<void> {
	// dev3's own skills and settings, not a grant to the branch - so foreign code gets them too.
	try {
		if (agents.isClaudeCommand(resolvedBaseCmd, family)) agents.ensureClaudeConfigDir(launchEnv, worktreePath);
	} catch (err) {
		log.warn("ensure Claude config dir failed (non-fatal)", { worktreePath, error: String(err) });
	}
	// A worktree standing on someone else's branch gets nothing pre-granted: its
	// committed `.claude/settings.json` hooks and `.mcp.json` servers must face the
	// agent's own approval prompts, which is precisely what those prompts are for.
	// The user sees one trust dialog per reviewed branch — the intended cost.
	if (foreignCode) {
		log.info("agent trust skipped — task is marked as foreign code", { worktreePath });
		return;
	}
	// The agent adapter declares which trust routines this agent needs, in order
	// (decision 124). Every adapter includes "claude" first — dev3 has always
	// registered the worktree in ~/.claude.json (harmless superset + MCP
	// pre-approval) for every agent — then any agent-native trust (codex/gemini).
	for (const kind of getAgentAdapter(resolvedBaseCmd, family).trustKinds) {
		try {
			if (kind === "claude") await agents.ensureClaudeTrust(worktreePath, projectPath, accountId, launchEnv);
			else if (kind === "codex") await agents.ensureCodexTrust(worktreePath);
			else if (kind === "gemini") await agents.ensureGeminiTrust(worktreePath);
			else if (kind === "copilot") await agents.ensureCopilotTrust(worktreePath, projectPath);
			log.info(`${kind} trust ensured`, { worktreePath });
		} catch (err) {
			log.error(`ensure ${kind} trust failed (non-fatal)`, {
				worktreePath,
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
		}
	}
}

export async function applyAgentHooksToCommand(
	worktreePath: string,
	baseCommand: string,
	command: string,
	options?: {
		stopTarget?: Task["status"];
		permissionMode?: PermissionMode;
		family?: AgentFamily;
	},
): Promise<string> {
	try {
		const managedArg = `--settings ${quoteIfUnsafe(CLAUDE_STATUSLINE_SETTINGS_PATH)}`;
		const passesManaged = command.includes(managedArg);
		const launch = await setupAgentHooks(worktreePath, baseCommand, {
			...options,
			...(passesManaged ? { claudeSettingsFile: CLAUDE_STATUSLINE_SETTINGS_PATH } : {}),
		});
		let next = command;
		if (launch?.claudeSettingsFile) {
			const swapped = `--settings ${quoteIfUnsafe(launch.claudeSettingsFile)}`;
			next = next.replace(managedArg, () => swapped);
		}
		const hookFlag = launch?.flag;
		if (!hookFlag) return next;
		// Codex gets a bare flag by design: its hook definitions live in the user's
		// config.toml, because the payload that used to travel here as
		// `-c hooks={...}` never survived the Windows command line. omp gets
		// `--hook <path>` — one short path to the generated extension.
		const firstSeparator = next.search(/\s/);
		if (firstSeparator < 0) return `${next} ${hookFlag}`;
		return `${next.slice(0, firstSeparator)} ${hookFlag}${next.slice(firstSeparator)}`;
	} catch (err) {
		log.warn("setupAgentHooks failed (non-fatal)", {
			worktreePath,
			error: String(err),
		});
		return command;
	}
}

/**
 * Start a task's primary terminal on the native backend (seq 1292).
 *
 * Runs the SAME wrapper script the tmux path runs, handed over as an explicit
 * executable + argv so no shell re-parses it. It creates no tmux session and
 * probes none, which also means the tmux-only follow-ups are absent by
 * construction: there is no pane id to persist, session-environment already
 * arrives through the wrapper's exports, and the virtual-project side shell is a
 * multi-view feature the native backend does not serve yet.
 */
async function launchNativeTaskSession(
	project: Project,
	task: Task,
	worktreePath: string,
	runScriptPath: string,
	env: Record<string, string>,
	userShell: string,
): Promise<void> {
	// The dialect decides how the wrapper is invoked: a POSIX login shell running
	// the `.sh`, or `powershell.exe -File` running the `.ps1`.
	const launch = launchDialect().scriptLaunch(runScriptPath, { cwd: worktreePath, env, shellPath: userShell });
	await pty.createNativeTaskSession(
		task.id,
		project.id,
		worktreePath,
		{ executable: launch.executable, argv: launch.argv },
		env,
	);
	if (project.kind === "virtual") {
		log.info("Native task terminal: skipping the virtual-project side shell (single view)", {
			taskId: task.id.slice(0, 8),
		});
	}
	log.info("launchTaskPty DONE — native session created", { taskId: task.id.slice(0, 8) });
}

/** How to raise the Codex version. Deliberately not a single command: dev3 does
 *  not know which package manager put the binary there, and a `brew upgrade` line
 *  printed to an npm install is worse than naming both. */
const CODEX_UPGRADE_COMMAND = "brew upgrade codex   (npm: npm install -g @openai/codex@latest)";

/**
 * Prefix a Codex launch with the model/CLI mismatch notice when the installed
 * binary predates the model the preset pins (#1667). Returns `command`
 * untouched for every other case — another agent, an unreadable
 * `codex --version`, a model with no known floor, a third-party backend.
 */
export async function applyModelVersionNotice(
	taskId: string,
	command: string,
	opts: { baseCmd: string; family: AgentFamily | undefined; launchModel: string | undefined; userShell?: string },
): Promise<string> {
	if (agentKey(opts.baseCmd, opts.family) !== "codex") return command;
	const support = evaluateCodexModelSupport(opts.launchModel, await agents.getCodexVersionCached());
	if (support.status !== "too-old") return command;

	log.warn("Codex CLI predates the launch model", {
		taskId: taskId.slice(0, 8),
		model: support.model,
		installed: support.installed,
		required: support.required,
	});
	const script = buildModelVersionGateWrapper({
		model: support.model,
		installedVersion: support.installed,
		requiredVersion: support.required,
		binaryName: "codex",
		upgradeCmd: CODEX_UPGRADE_COMMAND,
		alternativeHint: "Or pick a preset on an older model — those run on the installed version.",
		command,
	});
	const scriptPath = dev3TaskTempPath(taskId, generatedScriptName("model-version-notice"));
	await writeLaunchScript(scriptPath, script);
	return buildScriptRunnerCommand(scriptPath, { shellPath: opts.userShell });
}

export async function launchTaskPty(
	project: Project,
	task: Task,
	worktreePath: string,
	agentId?: string | null,
	configId?: string | null,
	runSetup = false,
	resume = false,
	opts?: {
		sessionId?: string;
		skipSessionPersist?: boolean;
		branchName?: string;
		accountId?: string | null;
		codexHome?: string;
		/** Open a plain shell headed by this line instead of the agent, parking the stored panes
		 *  for a later resume: a Codex reopen that cannot pick a conversation, or a wake with a plain shell. */
		shellNotice?: string;
		/** A resume whose pane has no conversation left of its own: start it on this
		 *  new id, with no brief, rather than `--continue` into another pane's. */
		freshSessionId?: string;
	},
): Promise<void> {
	// First, before any trust/hook/config write: tmux would start a missing cwd in $HOME.
	assertTaskWorkspacePresent(project, worktreePath, task);
	const sessionId = opts?.sessionId;
	const accountId = opts?.codexHome
		? codexAccountIdForHome(opts.codexHome) ?? null
		: opts?.accountId !== undefined ? opts.accountId : task.accountId;
	const skipSessionPersist = opts?.skipSessionPersist ?? false;
	const artifactTemplateEnv = ensureArtifactTemplateEnv(project, task, worktreePath);
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

	// Any launch supersedes the previous run's setup verdict — including the
	// "start anyway" relaunch, which is itself the answer to that verdict.
	if (task.setupFailedExitCode != null) {
		await data.updateTask(project, task.id, { setupFailedExitCode: null, setupFailedAgentRunning: null });
		task.setupFailedExitCode = null;
		task.setupFailedAgentRunning = null;
	}
	stopSetupFailureWatch(task.id);
	clearSetupExitCode(task.id);

	const resumeFresh = resume && !!opts?.freshSessionId;
	const ctx: agents.TemplateContext = {
		taskTitle: task.title,
		taskDescription: resumeFresh ? "" : task.description,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};
	// The brief reaches the agent as a launch argument, and Claude Code fires
	// UserPromptSubmit for it exactly as if the user had typed it. Leave the
	// receipt here or every task's own description is recorded as the user's
	// first message.
	noteDev3TypedPrompt(task.id, ctx.taskDescription);

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedPermissionMode: PermissionMode | undefined;
	let resolvedAgentFamily: AgentFamily | undefined;
	let resolvedLaunchModel: string | undefined;
	let mainPaneEntry: NonNullable<Task["sessionState"]>["panes"][number] | null = null;
	const projectEnv = await repoConfig.resolveProjectEnv(project, worktreePath, { foreignCode: task.foreignCode });
	const reservationKey = `${task.id}:${crypto.randomUUID()}`;
	// The account the session really runs on: the default applied, or Auto's pick.
	let launchAccountId = accountId;
	let accountPick: agents.ResolvedAgentCommand["accountPick"];
	let freshLaunchSessionId: string | null = null;

	try {
		// Recovery carries the pane's account alongside its session id. Older pane
		// snapshots fall back to the task selection; undefined uses the default.
		const cmdOptions: agents.CommandOptions = { accountId };
		let freshSessionId: string | null = null;
		if (!resume && !skipSessionPersist && !opts?.shellNotice) {
			cmdOptions.autoRouting = await autoRoutingContext(project, reservationKey, projectEnv);
		}

		if (resumeFresh) {
			cmdOptions.sessionId = opts?.freshSessionId;
		} else if (resume) {
			cmdOptions.resume = true;
			if (sessionId) cmdOptions.sessionId = sessionId;
		} else {
			// Fresh launch — always generate a new UUID.
			// Claude rejects --session-id if the UUID was already used;
			// stored session IDs are only for --resume.
			freshSessionId = crypto.randomUUID();
			freshLaunchSessionId = freshSessionId;
			cmdOptions.sessionId = freshSessionId;
		}

		if (opts?.shellNotice) {
			// A normal launch that runs no agent: throwing instead would fail a
			// preparation and let its cleanup remove the worktree.
			tmuxCmd = launchDialect().print(opts.shellNotice);
			extraEnv = {};
		} else if (agentId) {
			log.info("Resolving command for agent", { agentId, configId });
			const resolved = await agents.resolveCommandForAgent(agentId, configId ?? null, ctx, Object.keys(cmdOptions).length ? cmdOptions : undefined);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
			resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
			resolvedPermissionMode = resolved.config?.permissionMode;
			resolvedAgentFamily = resolved.agentFamily;
			resolvedLaunchModel = resolved.launchModel;
			if (resolved.resolvedAccountId !== undefined) launchAccountId = resolved.resolvedAccountId;
			accountPick = resolved.accountPick;
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
			resolvedPermissionMode = resolved.config?.permissionMode;
			resolvedAgentFamily = resolved.agentFamily;
			resolvedLaunchModel = resolved.launchModel;
			if (resolved.resolvedAccountId !== undefined) launchAccountId = resolved.resolvedAccountId;
			accountPick = resolved.accountPick;
		}

		if (opts?.codexHome) extraEnv.CODEX_HOME = opts.codexHome;

		// Persist session state as pane[0] for the main agent pane.
		// Skip when reconnecting to an existing tmux session (sessionState is already correct).
		if (!skipSessionPersist && !opts?.shellNotice) {
			const effectiveSessionId = resumeFresh ? opts?.freshSessionId
				: resume ? sessionId
				: (agents.supportsPreAssignedSessionId(resolvedBaseCmd, resolvedAgentFamily) ? freshSessionId : null);
			// This write replaces pane[0] wholesale, so an origin store the resolver
			// still needs has to be carried across it. It belongs to one specific id:
			// a substituted id was found in this worktree's own store, so it drops.
			const priorMain = task.sessionState?.panes?.[0];
			const carriedOriginCwd = resume && effectiveSessionId && effectiveSessionId === priorMain?.sessionId
				? priorMain.sessionOriginCwd ?? undefined
				: undefined;
			const paneEntry = {
				agentCmd: resolvedBaseCmd,
				sessionId: effectiveSessionId ?? null,
				agentId: agentId ?? task.agentId,
				configId: configId ?? task.configId,
				accountId: resume ? accountId : (agentKey(resolvedBaseCmd, resolvedAgentFamily) === "codex"
					? codexAccountIdForHome(extraEnv.CODEX_HOME) : undefined) ?? launchAccountId,
				agentFamily: resolvedAgentFamily,
				sessionOriginCwd: carriedOriginCwd,
			};
			mainPaneEntry = paneEntry;
			const sessionState = { panes: [paneEntry, ...(resume ? task.sessionState?.panes.slice(1).map((pane) => ({ ...pane, paneId: null })) ?? [] : [])] };
			// A routed launch pins its pick on the task too, so Start Fresh, reconnect
			// and legacy-pane resume read a concrete account instead of routing again.
			const routedPatch: Partial<Task> = accountPick
				? { accountId: accountPick.accountId, accountPick: { reason: accountPick.reason, at: new Date().toISOString() } }
				: {};
			try {
				await data.updateTask(project, task.id, { sessionState, ...routedPatch });
				log.info("Persisted sessionState", { taskId: task.id.slice(0, 8), sessionId: paneEntry.sessionId });
			} catch (err) {
				log.error("Failed to persist sessionState (non-fatal)", { taskId: task.id.slice(0, 8), error: String(err) });
			}
		} else if (!skipSessionPersist && opts?.shellNotice && task.sessionState?.panes.length) {
			// No live pane runs these any more: their paneIds name the dead session, and
			// the pane reconciler would drop every entry the moment a split exits.
			const panes = task.sessionState.panes.map((pane) => ({ ...pane, paneId: null, parked: true }));
			await data.updateTask(project, task.id, { sessionState: { panes } });
		}

		log.info("Command resolved", { tmuxCmd, envKeys: Object.keys(extraEnv) });
	} catch (err) {
		releaseAccountReservation(reservationKey);
		log.error("Failed to resolve command", {
			taskId: task.id.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}

	// Lifecycle env first so an explicit agent-config extraEnv can override it.
	// These vars reach the agent session, and — crucially — the setup script
	// below: a git-ignored hook (e.g. installed by the b44 CLI into
	// .dev3/config.local.json) only exists at the project root, so the script
	// command must be resolvable as "$DEV3_PROJECT_PATH/.dev3/<hook>.sh".
	// dev3's own defaults first, then project env (Project Settings / .dev3
	// config) — overridable by lifecycle DEV3_* vars and per-agent-config env.
	const env = {
		...AGENT_ENV_DEFAULTS,
		...projectEnv,
		...buildTaskLifecycleEnv(project, task, worktreePath, opts?.branchName),
		...buildAgentEnv(extraEnv, task.id),
		...artifactTemplateEnv,
	};
	const userShell = getUserShell();
	const dialect = launchDialect();

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

	// A plain shell runs no agent, so there is nothing to trust — and nothing to write into ~/.claude.json.
	if (!opts?.shellNotice) {
		await ensureAgentTrust(worktreePath, project.path, resolvedBaseCmd, launchAccountId, task.foreignCode, resolvedAgentFamily, env);
	}

	// Hooks splice a flag after the command's FIRST token, so they must land on the
	// agent's own command line — applied after the retry wrapper below, `--hook`
	// went to the wrapper's shell (`zsh --hook …`: "no such option").
	const stopTarget = project.autoReviewEnabled ? "review-by-ai" : "review-by-user";
	tmuxCmd = await applyAgentHooksToCommand(worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget,
		permissionMode: resolvedPermissionMode,
		family: resolvedAgentFamily,
	});

	// A fresh Claude session reports SessionStart once it is past its startup
	// dialogs; remember the spawn so the handoff and the wrapper's exit report can
	// tell "still at the trust prompt" from "running" (#2034).
	// Never on a reconnect: the agent already running there kept its old session.
	const trackedSessionId = opts?.shellNotice || skipSessionPersist ? null
		: resumeFresh ? opts?.freshSessionId ?? null
		: resume ? null
		: freshLaunchSessionId;
	let exitReport: string[] | undefined;
	if (trackedSessionId && agents.supportsPreAssignedSessionId(resolvedBaseCmd, resolvedAgentFamily)
		&& getAgentAdapter(resolvedBaseCmd, resolvedAgentFamily).hooksSpec()?.kind === "claude"
		&& claudeSessionStartHookInstalled(worktreePath)
		// An older shared CLI sends neither receipt: gating on it would drop the
		// handoff and print "Unknown command" at every exit, so keep today's path.
		&& await hookCliSupports(AGENT_SESSION_STARTED_METHOD) && await hookCliSupports(AGENT_EXITED_METHOD)) {
		noteAgentLaunched(task.id, trackedSessionId);
		exitReport = agentExitReportArgv(task.id, trackedSessionId);
	}

	if (resolvedBaseCmd && resolvedBaseCmd !== "bash") {
		const settings = await loadSettings();
		const allAgents = await agents.getAllAgents();
		const launchedAgentId = agentId ?? task.agentId ?? "";
		const matchedAgent = allAgents.find((agent) => agent.id === launchedAgentId)
			?? allAgents.find((agent) => agent.baseCommand === resolvedBaseCmd);
		// A path cached for a previous base command must not vouch for the new
		// one; a path the user set is theirs and always counts.
		const { binaryName, resolvedPath: binaryPath } = resolveAgentLaunchBinary(matchedAgent?.id ?? launchedAgentId, resolvedBaseCmd, settings);
		if (!binaryPath) {
			// Only reachable past the launch-boundary check (a resume, or a binary
			// removed mid-preparation): the pane waits for the install instead.
			const installCmd = (matchedAgent && agentInstallCommand(matchedAgent, process.platform))
				?? `Install "${binaryName}" and make sure it's on your PATH`;

			log.warn("Agent binary not found, creating retry wrapper", { binaryName, installCmd });

			const originalCmdPath = dev3TaskTempPath(task.id, `original-cmd${dialect.scriptExtension}`);
			await writeLaunchScript(originalCmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true, shellPath: userShell, exitReport }));
			// The retry wrapper hands over to that script; nothing outside it may report again.
			exitReport = undefined;

			const retryScript = buildAgentRetryWrapper({ binaryName, installCmd, originalCmdPath, shellPath: userShell });

			const retryScriptPath = dev3TaskTempPath(task.id, `agent-check${dialect.scriptExtension}`);
			await writeLaunchScript(retryScriptPath, retryScript);
			tmuxCmd = buildScriptRunnerCommand(retryScriptPath, { shellPath: userShell });
			log.info("Replaced tmuxCmd with agent-check retry wrapper");
		} else if (binaryName === "codex") {
			const launched = withResolvedCodexBinary(tmuxCmd, binaryName, binaryPath);
			if (launched !== tmuxCmd) log.info("Codex launched by its resolved path", { binaryPath });
			tmuxCmd = launched;
		}
	}

	tmuxCmd = await applyModelVersionNotice(task.id, tmuxCmd, {
		baseCmd: resolvedBaseCmd,
		family: resolvedAgentFamily,
		launchModel: resolvedLaunchModel,
		userShell,
	});

	const nativeBackend = taskTerminalBackendIdentity(task) === "native";

	let isSetupWrapper = false;
	if (runSetup && project.setupScript.trim()) {
		const setupScriptLaunchMode = project.setupScriptLaunchMode ?? "parallel";
		const prefix = dev3TaskTempPath(task.id);
		const ext = dialect.scriptExtension;
		const setupPath = `${prefix}-setup${ext}`;
		const cmdPath = `${prefix}-cmd${ext}`;
		const startupPath = `${prefix}-startup${ext}`;

		await writeLaunchScript(setupPath, project.setupScript + "\n");
		await writeLaunchScript(cmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true, shellPath: userShell, exitReport }));
		exitReport = undefined;

		const startupScript = buildSetupStartupWrapper({
			setupPath,
			cmdPath,
			worktreePath,
			shellPath: userShell,
			nativeBackend,
			launchMode: setupScriptLaunchMode,
			setupExitPath: setupExitCodePath(task.id),
		});
		await writeLaunchScript(startupPath, startupScript);
		tmuxCmd = buildScriptRunnerCommand(startupPath, { shellPath: userShell });
		isSetupWrapper = true;
		// Which offer the pane may make is decided HERE, where the wrapper's shape is
		// known — a parallel tmux launch has already split the agent pane above, so a
		// later failure finds it alive. Native ignores launchMode and always gates.
		const agentRunning = !nativeBackend && setupScriptLaunchMode === "parallel";
		// Only this process can see the wrapper's verdict — see setup-failure-watch.
		watchSetupFailure(task.id, async (exitCode) => {
			const updated = await data.updateTask(project, task.id, {
				setupFailedExitCode: exitCode,
				setupFailedAgentRunning: agentRunning,
			});
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		});
	}

	const runScriptPath = dev3TaskTempPath(task.id, `run${dialect.scriptExtension}`);
	await writeLaunchScript(runScriptPath, buildCmdScript(tmuxCmd, env, { keepShell: !isSetupWrapper, shellPath: userShell, exitReport }));
	const wrapperCmd = buildScriptRunnerCommand(runScriptPath, { shellPath: userShell });

	log.info("Creating PTY session", {
		taskId: task.id.slice(0, 8),
		worktreePath,
		command: tmuxCmd.slice(0, 200),
		scriptPath: runScriptPath,
		envKeys: Object.keys(env),
	});

	// Everything above is backend-neutral on purpose: the same resolved agent
	// command, hooks, trust, account, env, ports, and wrapper script feed both
	// backends. Only the session itself differs.
	if (nativeBackend) {
		await launchNativeTaskSession(project, task, worktreePath, runScriptPath, env, userShell);
		return;
	}

	try {
		const sessionSocket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
		// For virtual ops, only add the split-right shell on a FRESH session — not
		// when reconnecting to an existing one (recovery) — to avoid duplicate panes.
		let sessionPreexisted = false;
		if (project.kind === "virtual") {
			sessionPreexisted = await tmux.hasSession(taskSessionName(task.id), { socket: sessionSocket });
		}
		pty.createSession(task.id, project.id, worktreePath, wrapperCmd, env, sessionSocket);
		// Bun.spawn returning only proves that the client process started. A broken
		// binary or dynamic-loader failure can still make it exit immediately without
		// creating a tmux session. Gate preparation on the session itself so those
		// asynchronous launch failures are reverted and surfaced like spawn errors.
		await waitForTaskTmuxSession(task.id, sessionSocket);
		log.info("launchTaskPty DONE — PTY session created", { taskId: task.id.slice(0, 8) });
		if (!skipSessionPersist && !isSetupWrapper && mainPaneEntry) {
			await persistInitialAgentPaneId(project, task, sessionSocket, mainPaneEntry);
		}
		await setTmuxSessionPortEnv(task.id, sessionSocket);
		if (project.kind === "virtual" && !sessionPreexisted) {
			await addVirtualShellPane(task, worktreePath, sessionSocket, userShell);
		}
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
 * For a virtual ("Operations") task: after the main agent PTY session is up, add
 * a split-right interactive shell pane in the same working dir, so every
 * operation has both the agent (left) and a ready shell (right). Non-fatal: any
 * failure just leaves the agent pane alone. Waits for the freshly-created tmux
 * session to come up before splitting.
 */
export async function addVirtualShellPane(task: Task, worktreePath: string, socket: string, userShell: string): Promise<void> {
	const session = taskSessionName(task.id);
	try {
		let ready = false;
		for (let i = 0; i < 40; i++) {
			if (await tmux.hasSession(session, { socket })) { ready = true; break; }
			await new Promise((r) => setTimeout(r, 100));
		}
		if (!ready) {
			log.warn("Virtual shell pane: session never came up, skipping split", { taskId: task.id.slice(0, 8) });
			return;
		}
		let paneId: string | null = null;
		try {
			({ paneId } = await tmux.splitWindow({
				target: session,
				orientation: "horizontal",
				size: "40%",
				printPaneId: true,
				env: { DEV3_TASK_ID: task.id, DEV3_WORKTREE_ROOT: worktreePath },
				cwd: worktreePath,
				command: userShell,
				socket,
			}));
		} catch (err) {
			if (!(err instanceof TmuxError)) throw err;
			log.warn("Virtual shell pane split failed (non-fatal)", { taskId: task.id.slice(0, 8), exitCode: err.exitCode });
			return;
		}
		if (paneId) {
			tmux.setOption(session, "pane-border-status", "top", { socket }).catch(() => {});
			// `select-pane -t` sets a pane's title but ALSO makes it the active pane.
			// Title the shell first and the agent (pane 0) LAST, awaited in order, so
			// focus deterministically lands on the agent — not the freshly-split shell.
			await tmux.selectPane(paneId, { socket, title: "Shell" }).catch(() => {});
			await tmux.selectPane(`${session}.0`, { socket, title: "Agent" }).catch(() => {});
			log.info("Virtual shell pane created", { taskId: task.id.slice(0, 8), paneId });
		} else {
			log.warn("Virtual shell pane split failed (non-fatal)", { taskId: task.id.slice(0, 8), exitCode: 0 });
		}
	} catch (err) {
		log.warn("Virtual shell pane creation failed (non-fatal)", { taskId: task.id.slice(0, 8), error: String(err) });
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
	assertTaskWorkspacePresent(project, worktreePath, task);

	const { agentId, configId, prompt: rawPrompt } = agentConfig;
	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	// `{baseBranch}` becomes the ref this task is actually compared against — a
	// column agent told to diff against `origin/<base>` in a repo with no remote
	// reviews nothing at all.
	const prompt = rawPrompt.replace(/\{baseBranch\}/g, await git.resolveCompareRef(project.path, baseBranch));

	log.info("launchColumnAgent START", {
		taskId: task.id.slice(0, 8),
		agentId,
		configId,
		paneTitle: options.paneTitle,
	});

	const socket = pty.getSessionSocket(task.id);
	const tmuxSession = taskSessionName(task.id);

	const ctx: agents.TemplateContext = {
		taskTitle: `${options.paneTitle}: ${task.title}`,
		taskDescription: prompt,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};
	// A column agent runs in the same worktree, so its own launch prompt reaches
	// the prompt-submit hook under this task's id too.
	noteDev3TypedPrompt(task.id, prompt);

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedPermissionMode: PermissionMode | undefined;
	let resolvedAgentFamily: AgentFamily | undefined;
	let launchAccountId: string | null | undefined;
	const projectEnv = await repoConfig.resolveProjectEnv(project, worktreePath, { foreignCode: task.foreignCode });
	const reservationKey = `${task.id}:column:${crypto.randomUUID()}`;

	try {
		// A column agent is a fresh session nobody picked an account for: it follows
		// the default, which routes when the default is Auto.
		const resolved = await agents.resolveCommandForAgent(agentId, configId, ctx, {
			skipSystemPrompt: true,
			autoRouting: await autoRoutingContext(project, reservationKey, projectEnv),
		});
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedPermissionMode = resolved.config?.permissionMode;
		resolvedAgentFamily = resolved.agentFamily;
		launchAccountId = resolved.resolvedAccountId;
	} catch (err) {
		releaseAccountReservation(reservationKey);
		log.error("launchColumnAgent: failed to resolve command", { error: String(err) });
		throw err;
	}
	const env = {
		...AGENT_ENV_DEFAULTS,
		...projectEnv,
		...buildAgentEnv(extraEnv, task.id),
		...ensureArtifactTemplateEnv(project, task, worktreePath),
	};
	await ensureAgentTrust(worktreePath, project.path, resolvedBaseCmd, launchAccountId, task.foreignCode, resolvedAgentFamily, env);
	tmuxCmd = await applyAgentHooksToCommand(worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
		permissionMode: resolvedPermissionMode,
		family: resolvedAgentFamily,
	});

	const scriptPath = dev3TaskTempPath(task.id, generatedScriptName("col-agent"));
	await writeLaunchScript(scriptPath, buildCmdScript(tmuxCmd, env, {
		paneTitle: options.paneTitle,
		onExitCommand: options.onExitCommand,
	}));

	// The seam owns placement and dedup: the `columnAgent` purpose keeps at most one
	// live pane per task, re-found by the command it was launched with, so a repeated
	// activation REPLACES the review agent — and refuses to launch if it cannot prove
	// the old one is gone. A native task never reaches tmux from here.
	const handle = await openAuxPane({
		task,
		purpose: "columnAgent",
		placement: "right",
		size: "40%",
		cwd: worktreePath,
		env: { DEV3_TASK_ID: task.id, DEV3_WORKTREE_ROOT: worktreePath },
		socket,
		title: options.paneTitle,
		tmuxCommand: `bash "${scriptPath}"`,
		nativeLaunch: generatedScriptLaunch(scriptPath),
	});

	// tmux hands focus to the freshly split pane; the agent (pane 0) keeps it, as it
	// always has. The native path restores focus inside the seam.
	if (handle.backend === "tmux") {
		try {
			await tmux.selectPane(`${tmuxSession}:.0`, { socket, bestEffort: true });
		} catch {}
	}

	log.info("launchColumnAgent DONE", { taskId: task.id.slice(0, 8), backend: handle.backend, paneId: handle.paneId });
}

export function cleanupTaskTmuxState(taskId: string): void {
	fileBrowserPaneIds.delete(taskId);
	// One viewer pane per dev server, all keyed under this task.
	for (const key of [...devViewerPaneIds.keys()]) {
		if (key.startsWith(`${taskId}::`)) devViewerPaneIds.delete(key);
	}
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

		const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
		const livePaneIds = new Set(await pty.listPaneIds(taskId, socket));

		// Parked entries belong to no live pane (a plain-shell wake): never adopted, never dropped.
		// Step 1: remove entries with a known paneId that is no longer alive
		let surviving = panes.filter(p => p.parked || !p.paneId || livePaneIds.has(p.paneId));

		// Step 2: try to assign paneId to null entries via 1:1 matching
		const matchedIds = new Set(surviving.filter(p => p.paneId).map(p => p.paneId!));
		const unmatchedLive = [...livePaneIds].filter(id => !matchedIds.has(id));
		const nullEntries = surviving.filter(p => !p.paneId && !p.parked);

		if (nullEntries.length === 1 && unmatchedLive.length === 1) {
			// High confidence: the one unmatched live pane is the one null entry's agent
			const adopted = { ...nullEntries[0], paneId: unmatchedLive[0] };
			surviving = surviving.map(p => p === nullEntries[0] ? adopted : p);
			log.info("Reconciled paneId for unmatched entry", { taskId: taskId.slice(0, 8), paneId: unmatchedLive[0] });
		} else if (unmatchedLive.length === 0 && nullEntries.length > 0) {
			// No live panes left to match — these agents are dead
			surviving = surviving.filter(p => p.parked || !!p.paneId);
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
