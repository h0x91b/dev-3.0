import { assertTaskWorkspacePresent } from "../../task-workspace-guard";
import type { AgentFamily, Project, Task } from "../../../shared/types";
import * as data from "../../data";
import * as git from "../../git";
import * as pty from "../../pty-server";
import * as agents from "../../agents";
import { autoRoutingContext } from "../../account-router";
import * as portPool from "../../port-pool";
import * as repoConfig from "../../repo-config";
import { recordFavoriteUsages } from "../../settings";
import { assertLaunchAgentsInstalled } from "../../agent-launch-availability";
import { ensureArtifactTemplateEnv } from "../../artifact-template";
import { taskSessionName } from "../../tmux";
import { dev3TaskTempPath } from "../../temp-paths";
import { writeNativeAgentAttribution } from "../../native-agent-attribution";
import { taskTerminalBackendIdentity } from "../../task-terminal-backend";
import { focusNativeTaskPane, nativeTaskPaneLayout, nativeTaskPanesState, setNativeTaskPaneLayout } from "../../native-task-panes";
import { setSplitRatio, splitCreatedBySplitting } from "../../../shared/split-tree";
import { deliverAgentPrompt } from "../../agent-prompt-delivery";
import { agentPromptMayHaveLanded, type AgentPromptDelivery } from "../../../shared/agent-prompt-delivery";
import { closeTaskPane, splitTaskPane, type AuxPaneHandle, type AuxPanePlacement } from "../../task-aux-panes";
import { getPushMessage, AGENT_ENV_DEFAULTS, buildAgentEnv, buildCmdScript, generatedScriptLaunch, generatedScriptName, log, writeLaunchScript } from "../shared-pure";
import { applyAgentHooksToCommand, ensureAgentTrust, handlePaneExited } from "./task-launch";

/** How long the hunter agents get to boot before their prompt is typed in. */
const BUG_HUNTER_AUTOTYPE_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve the comparison ref for bug-hunter scoping, mirroring the renderer's
// getDefaultTaskCompareRef (src/mainview/components/task-info-panel/useTaskBranchStatus.ts)
// so the lightbox path honors the project's configured compare ref instead of
// always assuming origin/<base>.
export async function resolveBugHunterCompareRef(task: Task, project: Project): Promise<string> {
	const projectBaseBranch = project.defaultBaseBranch || "main";
	const taskBaseBranch = task.baseBranch || projectBaseBranch;
	// Task forked from a non-default base → compare against that local branch.
	if (taskBaseBranch !== projectBaseBranch) return taskBaseBranch;
	if (project.defaultCompareRef) return project.defaultCompareRef;
	if (project.defaultCompareRefMode === "local") return taskBaseBranch;
	// Nothing configured: ask git rather than assume a remote, which would send the
	// hunters at `git merge-base origin/<base> HEAD` in a repo that has no origin.
	return git.resolveCompareRef(project.path, taskBaseBranch);
}

export async function buildBugHunterPrompt(task: Task, project: Project, baseCmd = "", family?: AgentFamily): Promise<string> {
	const ref = await resolveBugHunterCompareRef(task, project);
	const branch = task.branchName || "HEAD";
	const prefix = agents.skillInvocationPrefix(baseCmd, family);
	return (
		`${prefix}dev3-bug-hunter ` +
		`You are a read-only helper inside a task owned by the main agent. ` +
		`Do NOT run the dev3 session-start checklist, rename the branch, or change this task's title, description, overview, labels, priority, status, assigned agent, or configuration. ` +
		`The only permitted dev3 write is \`dev3 note add\` for confirmed findings as instructed below; the main agent owns every other task mutation and lifecycle transition. ` +
		`Scope is locked to THIS branch only — only the changes this branch introduced, never commits pulled in from origin. ` +
		`First pin the fork point, then list only this branch's own changed files: ` +
		`run \`BASE=$(git merge-base ${ref} HEAD); git diff --name-only "$BASE" HEAD\`. ` +
		`Use that merge-base two-dot form — do NOT diff against ${ref} directly, because if this branch is not rebased that pulls in unrelated files changed only on ${ref}. ` +
		`Hunt for bugs ONLY in those changed files and the code paths they touch. ` +
		`Do NOT inspect files changed only on ${ref}, and do NOT inspect unrelated parts of the codebase. ` +
		`Branch: ${branch}. Base: ${ref}. ` +
		// In-task hunters run in their own pane, so their stdout report never reaches
		// the main agent — route findings into `[bug-hunt]` dev3 notes instead. Injected
		// only here; standalone skill invocation keeps its stdout report.
		`You are running inside a dev3 task, so your on-screen report will NOT reach the main agent — record it as dev3 notes instead. ` +
		`After presenting your normal report, add EACH confirmed critical/high/medium finding as its own dev3 note (one note per finding) via ` +
		`\`dev3 note add "..."\`, starting every note body with the literal marker "[bug-hunt]" followed by the severity, the "path:lines" location, a short title, the failure mode, and a repro hint. ` +
		`The "[bug-hunt]" marker is mandatory so the main agent can find them. ` +
		`Do NOT ask whether to create dev3 tasks and do NOT create any — recording the notes replaces the Next step offer. ` +
		`Finish with one line: the count of findings recorded and the instruction for the main agent to run \`dev3 note list\` then \`dev3 note show <id>\` and fix each.`
	);
}

async function spawnSingleBugHunterPane(opts: {
	project: Project;
	task: Task;
	socket: string;
	tmuxSession: string;
	worktreePath: string;
	agentId: string | null;
	configId: string | null;
	accountId?: string | null;
	split: { placement: AuxPanePlacement; size: string; tmuxTarget: string; nativeAnchor?: string };
}): Promise<{ handle: AuxPaneHandle; baseCmd: string; agentFamily: AgentFamily | undefined }> {
	assertTaskWorkspacePresent(opts.project, opts.worktreePath, opts.task);
	const ctx: agents.TemplateContext = {
		taskTitle: "",
		taskDescription: "",
		projectName: opts.project.name,
		projectPath: opts.project.path,
		worktreePath: opts.worktreePath,
	};

	const freshSessionId = crypto.randomUUID();
	const projectEnv = await repoConfig.resolveProjectEnv(opts.project, opts.worktreePath, { foreignCode: opts.task.foreignCode });
	const cmdOptions: agents.CommandOptions = {
		sessionId: freshSessionId,
		accountId: opts.accountId,
		autoRouting: await autoRoutingContext(opts.project, `${opts.task.id}:hunter:${freshSessionId}`, projectEnv),
	};
	let launchAccountId = opts.accountId;

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedAgentFamily: AgentFamily | undefined;
	let launchedAgentId = opts.agentId;
	let launchedConfigId = opts.configId;
	if (opts.agentId) {
		const resolved = await agents.resolveCommandForAgent(opts.agentId, opts.configId, ctx, cmdOptions);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedAgentFamily = resolved.agentFamily;
		if (resolved.resolvedAccountId !== undefined) launchAccountId = resolved.resolvedAccountId;
		launchedAgentId = resolved.agent?.id ?? opts.agentId;
		launchedConfigId = resolved.config?.id ?? opts.configId;
	} else {
		const resolved = await agents.resolveCommandForProject(
			opts.project,
			opts.task.title,
			opts.task.description,
			opts.worktreePath,
			undefined,
			cmdOptions,
		);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedAgentFamily = resolved.agentFamily;
		if (resolved.resolvedAccountId !== undefined) launchAccountId = resolved.resolvedAccountId;
		launchedAgentId = resolved.agent?.id ?? null;
		launchedConfigId = resolved.config?.id ?? null;
	}

	// Same trust/config-ensure the primary launch does — a Codex bug-hunter pane
	// otherwise launches against a stale config.toml and crashes.
	const env: Record<string, string> = {
		...AGENT_ENV_DEFAULTS,
		...projectEnv,
		...buildAgentEnv(extraEnv, opts.task.id),
		...ensureArtifactTemplateEnv(opts.project, opts.task, opts.worktreePath),
	};
	await ensureAgentTrust(opts.worktreePath, opts.project.path, resolvedBaseCmd, launchAccountId, opts.task.foreignCode, resolvedAgentFamily, env);
	tmuxCmd = await applyAgentHooksToCommand(opts.worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget: opts.project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
		family: resolvedAgentFamily,
	});

	const existingPorts = portPool.getPortAssignments(opts.task.id);
	if (existingPorts.length > 0) {
		Object.assign(env, portPool.buildPortEnv(existingPorts));
	}

	const scriptPath = dev3TaskTempPath(
		opts.task.id,
		generatedScriptName(`bughunt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
	);
	await writeLaunchScript(scriptPath, buildCmdScript(tmuxCmd, env));

	const handle = await splitTaskPane({
		task: opts.task,
		placement: opts.split.placement,
		size: opts.split.size,
		cwd: opts.worktreePath,
		socket: opts.socket,
		tmuxTarget: opts.split.tmuxTarget,
		nativeAnchor: opts.split.nativeAnchor,
		tmuxCommand: `bash "${scriptPath}"`,
		nativeLaunch: generatedScriptLaunch(scriptPath),
	});

	// sessionState.panes is the tmux pane registry — recovery and `handlePaneExited`
	// reconcile it against live tmux panes. A native pane is owned by the
	// coordinator record instead, so writing it here would leave a permanent
	// phantom entry that no tmux pane can ever match.
	if (handle.backend === "tmux") {
		const paneEntry = {
			paneId: handle.paneId,
			agentCmd: resolvedBaseCmd,
			sessionId: agents.supportsPreAssignedSessionId(resolvedBaseCmd, resolvedAgentFamily) ? freshSessionId : null,
			agentId: launchedAgentId,
			configId: launchedConfigId,
			accountId: launchAccountId,
			agentFamily: resolvedAgentFamily,
		};
		try {
			const freshTask = await data.getTask(opts.project, opts.task.id);
			const existingPanes = freshTask.sessionState?.panes ?? [];
			const updated = await data.updateTask(opts.project, opts.task.id, {
				sessionState: { panes: [...existingPanes, paneEntry] },
			});
			getPushMessage()?.("taskUpdated", { projectId: opts.project.id, task: updated });
		} catch (err) {
			log.error("Failed to append bug hunter pane to sessionState (non-fatal)", { error: String(err) });
		}
	} else {
		await writeNativeAgentAttribution(scriptPath, {
			agentCmd: resolvedBaseCmd,
			agentId: launchedAgentId,
			configId: launchedConfigId,
			accountId: launchAccountId,
			agentFamily: resolvedAgentFamily,
		});
	}

	return { handle, baseCmd: resolvedBaseCmd, agentFamily: resolvedAgentFamily };
}

/**
 * The ratio each split of a hunter column needs so the panes end up equal.
 *
 * The splits form a right-nested chain: the first one holds hunter 1 against
 * everything below it, the next holds hunter 2 against what is left, and so on.
 * So split `i` (0-based) must give its first child `1 / (count - i)` of what it
 * received. For 3 hunters → 1/3 then 1/2; for 6 → 1/6, 1/5, 1/4, 1/3, 1/2.
 */
export function nativeHunterColumnRatios(count: number): number[] {
	return Array.from({ length: Math.max(0, count - 1) }, (_, i) => 1 / (count - i));
}

/**
 * Even out the hunter column of a native task, touching only the splits this
 * launch created. `anchors[i]` is the pane that was split to open hunter `i + 2`,
 * which is how each split is re-found without remembering generated split ids.
 *
 * Throws rather than settling for whatever geometry it found: a column reported
 * as launched but drawn 50/25/25 is a silently wrong result, and the caller can
 * still undo the whole launch at this point.
 */
async function equalizeNativeHunterColumn(taskId: string, anchors: string[]): Promise<void> {
	const tree = await nativeTaskPaneLayout(taskId);
	if (!tree) throw new Error("the task's native pane layout could not be read back");
	const ratios = nativeHunterColumnRatios(anchors.length + 1);
	let equalized = tree;
	anchors.forEach((anchor, i) => {
		const split = splitCreatedBySplitting(equalized, anchor);
		if (!split) throw new Error(`the split opened off ${anchor} is no longer in the layout`);
		equalized = setSplitRatio(equalized, split.id, ratios[i]);
	});
	await setNativeTaskPaneLayout(taskId, equalized);
}

/**
 * Undo a hunter launch that went wrong, on whichever backend it ran, and build the
 * error the user sees. `headline` says what actually failed; this adds what the
 * cleanup achieved.
 *
 * A close that fails is NAMED — claiming the launch was rolled back while panes
 * are still on screen is the one outcome this must never produce.
 */
async function rollBackHunterLaunch(
	task: Task,
	handles: AuxPaneHandle[],
	socket: string,
	focusedBefore: string | null,
	headline: string,
): Promise<Error> {
	const stuck: string[] = [];
	for (const handle of handles) {
		try {
			await closeTaskPane(task, handle, socket);
		} catch (err) {
			stuck.push(handle.paneId);
			log.error("Rolling back a bug hunter pane failed — it is still open", {
				taskId: task.id.slice(0, 8),
				paneId: handle.paneId,
				error: String(err),
			});
			continue;
		}
		// kill-pane does not fire tmux's pane-exited hook, so the pane this launch
		// appended to sessionState has to be retired here or it outlives the rollback.
		if (handle.backend === "tmux") {
			await handlePaneExited(task.id, handle.paneId).catch((err) =>
				log.warn("Could not retire a rolled-back hunter pane from sessionState", { paneId: handle.paneId, error: String(err) }),
			);
		}
	}
	if (focusedBefore) await focusNativeTaskPane(task.id, focusedBefore).catch(() => {});

	if (stuck.length > 0) {
		return new Error(
			`${headline}; the rollback could not close ${stuck.join(", ")} — ` +
				`${stuck.length === 1 ? "that pane is" : "those panes are"} still open, close ${stuck.length === 1 ? "it" : "them"} by hand.`,
		);
	}
	return new Error(`${headline}; launch rolled back.`);
}

/**
 * One hunter's prompt, as a verdict rather than an exception. A throw carries no
 * verdict — nothing can then say whether the text landed — so it becomes
 * `unconfirmed` and keeps the pane, instead of joining the proven failures that
 * undo the launch.
 */
async function deliverHunterPrompt(task: Task, paneId: string, prompt: string): Promise<AgentPromptDelivery> {
	try {
		return await deliverAgentPrompt(task, prompt, { kind: "pane", paneId });
	} catch (err) {
		return { status: "unconfirmed", reason: "backend-failure", detail: String(err) };
	}
}

export async function spawnBugHuntersInTask(params: { taskId: string; projectId: string; agentId: string | null; configId: string | null; count: number; accountId?: string | null }): Promise<{ spawned: number }> {
	log.info("→ spawnBugHuntersInTask", { taskId: params.taskId.slice(0, 8), count: params.count, agentId: params.agentId });

	const requestedCount = Math.max(1, Math.min(6, Math.floor(params.count)));

	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (!task.worktreePath) {
		throw new Error("Task has no worktree — cannot spawn bug hunters");
	}
	await assertLaunchAgentsInstalled([{ agentId: params.agentId, configId: params.configId }]);

	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = taskSessionName(params.taskId);
	const native = taskTerminalBackendIdentity(task) === "native";

	// The pane that had focus before the hunters landed — the agent's own. Read
	// before the first split, because splitting makes the NEW pane active.
	const focusedBefore = native ? (await nativeTaskPanesState(params.taskId))?.activePaneId || null : null;

	const handles: AuxPaneHandle[] = [];

	// First hunter: split the task terminal horizontally, taking the right 50%.
	const first = await spawnSingleBugHunterPane({
		project,
		task,
		socket,
		tmuxSession,
		worktreePath: task.worktreePath,
		agentId: params.agentId,
		configId: params.configId,
		accountId: params.accountId,
		split: { placement: "right", size: "50%", tmuxTarget: tmuxSession, nativeAnchor: focusedBefore ?? undefined },
	});
	if (first.handle.paneId) handles.push(first.handle);
	const resolvedBaseCmd = first.baseCmd;
	const resolvedHunterFamily = first.agentFamily;

	// Subsequent hunters: split the right column vertically off the previous
	// hunter's pane. tmux needs an explicit -p per split so the whole right column
	// ends up equal-sized WITHOUT calling select-layout on the window (that command
	// would also shrink the main left pane to 1/N of the window, which broke the
	// layout in the first iteration). Formula: at split i (1-indexed, 1..N-1), the
	// new pane takes (N-i)/(N-i+1) of the target's current size. For N=3 → 67, 50.
	// For N=6 → 83, 80, 75, 67, 50. The native SplitTree ignores the size and always
	// halves, which is why the native path re-publishes the column ratios below.
	const nativeAnchors: string[] = [];
	for (let i = 1; i < requestedCount; i++) {
		const previous = handles[handles.length - 1] ?? first.handle;
		if (!previous.paneId) break;
		const remaining = requestedCount - i;
		const percent = Math.round((remaining / (remaining + 1)) * 100);
		try {
			const { handle } = await spawnSingleBugHunterPane({
				project,
				task,
				socket,
				tmuxSession,
				worktreePath: task.worktreePath,
				agentId: params.agentId,
				configId: params.configId,
				accountId: params.accountId,
				split: { placement: "below", size: `${percent}%`, tmuxTarget: previous.paneId, nativeAnchor: previous.paneId },
			});
			if (handle.paneId) {
				nativeAnchors.push(previous.paneId);
				handles.push(handle);
			}
		} catch (err) {
			if (!native) {
				// tmux: a failed split leaves nothing behind, and the panes that did
				// open are usable — keep going, exactly as this path always has.
				log.warn("Bug hunter split failed (continuing with remaining)", { index: i, error: String(err) });
				continue;
			}
			// Native: a half-filled pane set is worse than none — the user asked for N
			// hunters, got fewer, and nothing on screen says so. Undo and report.
			log.error("Native bug hunter split failed — rolling back the panes already opened", {
				taskId: params.taskId.slice(0, 8),
				opened: handles.length,
				error: String(err),
			});
			throw await rollBackHunterLaunch(
				task,
				handles,
				socket,
				focusedBefore,
				`Only ${handles.length} of ${requestedCount} bug hunters could be started (${String(err)})`,
			);
		}
	}

	// Native only: the SplitTree halves whatever it splits, so the chain above lands
	// at 50/25/25 instead of the equal thirds the tmux path produces. Re-publish the
	// ratios of exactly the splits this launch created — the agent's own pane and
	// anything that was open before keep their geometry untouched.
	if (native && nativeAnchors.length > 0) {
		try {
			await equalizeNativeHunterColumn(params.taskId, nativeAnchors);
		} catch (err) {
			log.error("Could not even out the native bug hunter column — rolling the launch back", {
				taskId: params.taskId.slice(0, 8),
				error: String(err),
			});
			throw await rollBackHunterLaunch(
				task,
				handles,
				socket,
				focusedBefore,
				`All ${handles.length} hunter panes opened, but the column could not be laid out evenly (${String(err)})`,
			);
		}
	}

	// After the agents have had time to boot, paste the branch-scoped bug-hunter
	// slash command into each pane. The scope clause is mandatory: hunters must
	// only inspect files changed in this branch, never the whole codebase.
	const prompt = await buildBugHunterPrompt(task, project, resolvedBaseCmd, resolvedHunterFamily);

	// The agent keeps the keyboard: a hunter pane became active on every split, and
	// the main agent must not lose input just because hunters started.
	if (focusedBefore) {
		await focusNativeTaskPane(params.taskId, focusedBefore).catch((err) =>
			log.warn("Could not restore focus to the agent pane after launching bug hunters", {
				taskId: params.taskId.slice(0, 8),
				error: String(err),
			}),
		);
	}

	// The prompt decides the launch on BOTH backends. Delivery runs through the guarded
	// seam (`201-backend-neutral-pane-input`): the pane is pinned to one backend generation, and the answer
	// is one of three — landed, cannot say, or provably nothing sent. Only the last one
	// undoes the launch, because a hunter that never got its prompt is a pane the user
	// has to notice and close by hand, while a pane that may have got it must not be
	// killed on a guess.
	await sleep(BUG_HUNTER_AUTOTYPE_DELAY_MS);
	const undelivered: string[] = [];
	for (const handle of handles) {
		const delivery = await deliverHunterPrompt(task, handle.paneId, prompt);
		if (!agentPromptMayHaveLanded(delivery)) {
			undelivered.push(`${handle.paneId} (${delivery.reason ?? "no reason given"})`);
			continue;
		}
		if (delivery.status === "unconfirmed") {
			log.warn("Bug hunter prompt could not be confirmed — keeping the pane", {
				taskId: params.taskId.slice(0, 8),
				paneId: handle.paneId,
				reason: delivery.reason,
				detail: delivery.detail,
			});
		}
	}
	if (undelivered.length > 0) {
		log.error("Bug hunter prompt was not delivered — rolling the launch back", {
			taskId: params.taskId.slice(0, 8),
			native,
			undelivered,
		});
		throw await rollBackHunterLaunch(
			task,
			handles,
			socket,
			focusedBefore,
			`All ${handles.length} hunter ${handles.length === 1 ? "pane" : "panes"} opened, ` +
				`but the hunt prompt never reached ${undelivered.join(", ")}`,
		);
	}

	// Bump favorite usage — one per hunter actually spawned (all share the combo). Best-effort.
	void recordFavoriteUsages(
		Array.from({ length: handles.length }, () => ({ agentId: params.agentId, configId: params.configId })),
	);

	log.info("← spawnBugHuntersInTask done", { taskId: params.taskId.slice(0, 8), spawned: handles.length, native });
	return { spawned: handles.length };
}
