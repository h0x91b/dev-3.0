import type { AgentMessageSource, Project, ResetKeptBranch, Task, TaskPriority, TaskResetConsent, TaskResetResult, TaskStatus } from "../../shared/types";
import { agentReplyCommand, seqIsShared } from "../../shared/agent-message-envelope";
import { type ExternalSenderRequester, isExternalSenderRequester } from "../../shared/external-senders";
import { DEFAULT_PRIORITY, agentLaunchAutoApproveMs, buildTaskDialogSubject, getTaskTitle, taskNeedsReset, taskResetConsent } from "../../shared/types";
import { createAgentRequest, getAgentRequestState, joinAgentRequest, setAgentRequestLaunchChoice } from "../agent-requests";
import { DESTRUCTIVE_APPROVAL_TARGET, type AgentApprovalNotAttached, type AgentApprovalStatus, type DestructiveApprovalKind } from "../../shared/agent-approval";
import type { AgentLaunchChoice, LaunchVariant } from "../../shared/types";
import { deliverLaunchHandoff } from "../agent-launch-handoff";
import { getPushMessage, launchTaskWithAgentChoice, moveTask, resetTaskToTodo } from "../rpc-handlers";
import { loadSettings } from "../settings";
import { loadBoardTasks, resolveTaskAcrossProjects, resolveTaskFromParams } from "./task-resolution";
import { awaitLaunchPreparation } from "./launch-preparation";
import type { LaunchPreparationOutcome } from "../../shared/launch-preparation";

export function approvalStatusOf(kind: DestructiveApprovalKind, task: Task): AgentApprovalStatus {
	const known = getAgentRequestState(kind, task.id);
	return {
		kind,
		state: known.state,
		...(known.state === "answered" ? { approved: known.approved, ...(known.stale ? { stale: true } : {}) } : {}),
		taskStatus: task.status,
		// A legacy To Do card that owns a worktree is already `todo`: only this
		// says whether the reset actually happened.
		...(kind === "reset" ? { resetNeeded: taskNeedsReset(task) } : {}),
	};
}

/**
 * Completion and cancellation: one blocking approval each, pushed to every
 * client and settled by the first answer.
 *
 * `attachOnly` is the re-attach a CLI makes after its socket dropped mid-wait.
 * It joins the live request or reports how it ended, and never creates one: a
 * restarted app has no request left, and opening a fresh dialog then would be a
 * second ask the agent never made.
 */
/** What each pending reset request asked to destroy, fixed when its dialog opened. */
const resetConsentByRequestId = new Map<string, TaskResetConsent>();

/**
 * One reset per approved request, shared by every waiter joined to it: the
 * original CLI, a retry, a re-attach after a dropped socket. Each must get the
 * same truthful outcome, never a second attempt or a false "nothing happened".
 */
const resetRunByRequestId = new Map<string, Promise<TaskResetResult>>();

export async function requestDestructiveApproval(
	kind: DestructiveApprovalKind,
	params: Record<string, unknown>,
): Promise<{ approved: boolean; task?: Task; stale?: boolean; plainMove?: boolean; keptBranches?: ResetKeptBranch[] } | AgentApprovalNotAttached> {
	const { project, task } = await resolveTaskFromParams(params);
	// A clean To Do card, a draft, a completed/cancelled task: moving it to To Do
	// destroys nothing, so it stays the ordinary move it always was — no dialog.
	if (kind === "reset" && params.attachOnly !== true && !taskNeedsReset(task)) {
		const moved = await moveTask({ taskId: task.id, projectId: project.id, newStatus: "todo", enforceAllowedTransition: true });
		return { approved: true, task: moved, plainMove: true };
	}
	const targetStatus = DESTRUCTIVE_APPROVAL_TARGET[kind];
	const push = getPushMessage();
	const dialog = {
		taskTitle: getTaskTitle(task),
		// Full read-only context (project, seq, priority, labels, overview)
		// so the user recognizes which task the prompt destroys.
		subject: buildTaskDialogSubject(task, project),
	};

	let request: { requestId: string; decision: Promise<{ approved: boolean; stale?: boolean }> };
	if (params.attachOnly === true) {
		const joined = joinAgentRequest(kind, task.id);
		if (!joined) return { attached: false, status: approvalStatusOf(kind, task) };
		request = joined;
	} else {
		if (task.status === "completed" || task.status === "cancelled") {
			throw new Error(`Task is already ${task.status}`);
		}
		if (!push) {
			throw new Error("No app window is connected — cannot ask the user for approval");
		}
		// Kept ON the request, not just pushed: the push is a one-shot event, so a
		// renderer that reloads before answering can be handed it again on connect.
		request = createAgentRequest(kind, task.id, project.id, { dialog });
		if (kind === "reset" && !resetConsentByRequestId.has(request.requestId)) {
			resetConsentByRequestId.set(request.requestId, taskResetConsent(task));
		}
	}

	// Pushed on EVERY attempt, joined retries and re-attaches included. A retry
	// used to push nothing, so once a client lost the original dialog the request
	// became unreachable from the CLI side (h0x91b/dev-3.0#1669). Clients dedup by
	// `requestId`, so a dialog already on screen is untouched.
	push?.(kind === "complete" ? "agentCompletionRequested" : kind === "reset" ? "agentResetRequested" : "agentCancellationRequested", {
		requestId: request.requestId, taskId: task.id, projectId: project.id, ...dialog,
	});

	const { approved, stale } = await request.decision;
	if (!approved) {
		resetConsentByRequestId.delete(request.requestId);
		return { approved: false, ...(stale ? { stale: true } : {}) };
	}
	if (kind === "reset") {
		const { requestId } = request;
		let run = resetRunByRequestId.get(requestId);
		if (!run) {
			// Consent is bound to the run the dialog showed; the machine refuses a
			// different one and deletes nothing.
			const consent = resetConsentByRequestId.get(requestId);
			resetConsentByRequestId.delete(requestId);
			run = consent
				? resetTaskToTodo({ taskId: task.id, projectId: project.id, consent })
				: Promise.reject(new Error("The reset request lost its consent record, so the reset was not run. Ask again."));
			resetRunByRequestId.set(requestId, run);
			void run.catch(() => {}).finally(() => {
				setTimeout(() => resetRunByRequestId.delete(requestId), 60_000);
			});
		}
		const { task: reset, keptBranches } = await run;
		return { approved: true, task: reset, keptBranches };
	}
	// Every caller joined to this request lands here; a repeat move to the same
	// status is a no-op in the lifecycle machine.
	const updated = await moveTask({ taskId: task.id, projectId: project.id, newStatus: targetStatus });
	return { approved: true, task: updated };
}

/**
 * The launcher's standing handoff text, as the CLI read it out of `--handoff-file`.
 * Only reaches a child when the request actually turns into a launch — a plain
 * board move carries it and ignores it.
 */
export function launcherHandoffNote(params: Record<string, unknown>): string | null {
	const raw = typeof params.handoffNote === "string" ? params.handoffNote.trim() : "";
	return raw ? raw : null;
}

export function launchSuggestionRequested(params: Record<string, unknown>): boolean {
	return params.agentId != null || params.configId != null;
}

/**
 * The agent/config a launch request suggests (`--agent`/`--config`), validated
 * BEFORE any dialog or placeholder task exists: a bad id must fail loudly, never
 * fall back to the default preset. Null when nothing was suggested.
 */
export async function resolveLaunchSuggestion(params: Record<string, unknown>): Promise<LaunchVariant | null> {
	if ("accountId" in params) throw new Error("Account selection is not supported for launch requests — the user picks the account in the approval dialog.");
	if (!launchSuggestionRequested(params)) return null;
	const { validateLaunchSuggestion } = await import("../cli-agent-spawn");
	return validateLaunchSuggestion({
		agentId: typeof params.agentId === "string" ? params.agentId : null,
		configId: typeof params.configId === "string" ? params.configId : null,
	});
}

/**
 * Result of the agent-initiated launch approval flow.
 *
 * `launched` is one entry per task that actually started, in variant order — a
 * plain launch has exactly one. The seq is shared by the whole group, which is
 * why the address the requester must use lives per entry rather than being
 * derivable from the seq (see `agentReplyRef` and the
 * `address-a-peer-by-seq-unless-the-seq-is-shared` record).
 */
type LaunchApprovalOutcome =
	| { approved: false }
	| {
		approved: true;
		seq: number;
		title: string;
		launched: Array<{ variantIndex: number | null; replyCommand: string; preparation: LaunchPreparationOutcome }>;
	};

/**
 * Priority an agent-initiated launch starts on. A target that never had one set
 * (a scratch peer, or a task created without `--priority`) inherits the
 * requesting task's band, so a P0 agent's helpers do not sink to P3 — issue
 * #1496. An explicit priority on the target always wins, and the user can still
 * override either in the launch dialog. Unreadable requester ⇒ the plain default.
 */
async function resolveLaunchPriority(task: Task, requester: AgentMessageSource | ExternalSenderRequester): Promise<TaskPriority> {
	if (task.priority) return task.priority;
	if (isExternalSenderRequester(requester)) return DEFAULT_PRIORITY;
	try {
		const found = await resolveTaskAcrossProjects(requester.taskId);
		return found?.task.priority ?? DEFAULT_PRIORITY;
	} catch {
		return DEFAULT_PRIORITY;
	}
}

/**
 * Ask the user to approve an agent-initiated launch, then perform it with the
 * agent/config/account/priority they picked in the dialog. Blocks until the user
 * answers, exactly like the completion approval — the requesting CLI waits on the
 * socket.
 *
 * The launched task's first message tells it who started it (`deliverLaunchHandoff`),
 * so the two agents can talk over the existing cross-task envelope.
 */
export async function requestAgentLaunchApproval(opts: {
	project: Project;
	task: Task;
	targetStatus: TaskStatus;
	/** A task's agent, or a registered external sender (`--as-sender`). */
	requester: AgentMessageSource | ExternalSenderRequester;
	/** The launcher's standing text, already read from its `--handoff-file`. */
	launcherNote?: string | null;
	/** Validated `--agent`/`--config` suggestion; only preselects the dialog. */
	suggested?: LaunchVariant | null;
}): Promise<LaunchApprovalOutcome> {
	const { project, task, targetStatus, requester } = opts;
	if (isExternalSenderRequester(requester) && opts.launcherNote) {
		throw new Error("--handoff-file does not apply with --as-sender: a sender's launch gets no handoff note.");
	}
	const push = getPushMessage();
	if (!push) {
		throw new Error("No app window is connected — cannot ask the user for approval");
	}

	// A launch is reversible, so an unanswered dialog approves itself rather than
	// pinning the requesting agent to a dead socket. The completion dialog
	// deliberately does not do this — it destroys a worktree.
	const defaultPriority = await resolveLaunchPriority(task, requester);
	const autoApproveAfterMs = agentLaunchAutoApproveMs(await loadSettings());
	const joining = getAgentRequestState("launch", task.id).state === "pending";
	const subject = buildTaskDialogSubject(task, project);
	const asker = isExternalSenderRequester(requester)
		? { taskId: null, seq: null, title: requester.label, senderId: requester.senderId }
		: { taskId: requester.taskId, seq: requester.seq, title: requester.title ?? null, senderId: null };
	const { requestId, decision, autoApproveAt } = createAgentRequest(
		"launch",
		task.id,
		project.id,
		{ autoApproveAfterMs, dialog: { taskTitle: getTaskTitle(task), subject, requester: asker } },
	);
	// Seeds what an unwatched auto-approval launches. A joined retry must not
	// overwrite a pick the user may already have made in the open dialog.
	if (opts.suggested && !joining) setAgentRequestLaunchChoice(requestId, { variants: [opts.suggested] });
	// Pushed on EVERY attempt, joined retries included — see the note on
	// `task.requestCancellation`. Clients dedup by `requestId`, so a dialog that
	// is already on screen is untouched and nothing here re-arms the countdown.
	push("agentLaunchRequested", {
		requestId,
		taskId: task.id,
		projectId: project.id,
		taskTitle: getTaskTitle(task),
		targetStatus,
		scratch: task.scratch === true,
		...(isExternalSenderRequester(requester)
			? { requesterSeq: 0, requesterTitle: requester.label, requesterSender: requester }
			: { requesterSeq: requester.seq, requesterTitle: requester.title }),
		// Same read-only context card as the completion dialog, so the user
		// recognizes which task an agent wants to set running.
		subject,
		defaultPriority,
		canAddVariants: canSpawnAsVariants(task),
		autoApproveAt,
		...(opts.suggested ? { suggested: opts.suggested } : {}),
	});

	const answer = await decision;
	if (!answer.approved) return { approved: false };

	// An auto-approval with no client watching carries no launch choice at all —
	// one default variant, and the inherited priority must still apply, so it is
	// resolved here, not in the dialog.
	const choice: AgentLaunchChoice = answer.launch ?? { variants: [{ agentId: null, configId: null }] };
	// The dialog only offers the control when the target can take it, but the
	// choice arrives over RPC from any connected client — clamp rather than let
	// spawnVariants throw and strand the requester.
	const variants = canSpawnAsVariants(task) ? choice.variants : choice.variants.slice(0, 1);
	const launched = await launchTaskWithAgentChoice({
		taskId: task.id,
		projectId: project.id,
		targetStatus,
		choice: { variants, priority: choice.priority ?? defaultPriority },
	});
	// Fire-and-forget: the handoff waits for each child's agent pane, which takes
	// far longer than the requesting agent should sit blocked on a socket. Every
	// variant gets its own note — each one is a separate agent that has to know
	// who started it.
	// A sender gets no handoff note: it has no task to report back to, and its own
	// first `--as-sender` message carries the reply command.
	const taskRequester = isExternalSenderRequester(requester) ? null : requester;
	for (const child of taskRequester ? launched : []) {
		if (!taskRequester) break;
		void deliverLaunchHandoff({
			projectId: project.id,
			childTaskId: child.id,
			source: taskRequester,
			launcherNote: opts.launcherNote ?? null,
		});
	}

	// Read the board AFTER the launch: launching with variants mints the siblings
	// that decide whether `seq:<N>` is still an unambiguous address.
	const head = launched[0]!;
	// Answer only once preparation settles: replying at dispatch told the
	// requester "started" for runs that then failed (2026-11-01 incident).
	const preparations = await Promise.all(launched.map((child) => awaitLaunchPreparation(project, child.id)));
	const boardTasks = await loadBoardTasks(project);

	return {
		approved: true,
		seq: head.seq,
		title: getTaskTitle(head),
		launched: launched.map((child, i) => ({
			variantIndex: child.variantIndex ?? null,
			preparation: preparations[i]!,
			// The requester may live on another board (it launched a task in a
			// different project), and then the bare `--task` form would resolve
			// against its own.
			replyCommand: launchReplyCommand(child, requester, boardTasks),
		})),
	};
}

/**
 * How the requester reaches a launched task. A sender has no board of its own, so
 * its command always names the project and speaks as that sender.
 */
function launchReplyCommand(child: Task, requester: AgentMessageSource | ExternalSenderRequester, boardTasks: Task[] | null): string {
	const sender = isExternalSenderRequester(requester) ? requester : null;
	const command = agentReplyCommand({
		target: {
			...child,
			seqShared: boardTasks ? seqIsShared(child, boardTasks) : child.variantIndex != null,
		},
		fromProjectId: sender ? "" : (requester as AgentMessageSource).projectId ?? child.projectId,
		quoted: "your message",
	});
	return sender ? command.replace("dev3 message ", `dev3 message --as-sender ${sender.senderId} `) : command;
}

/**
 * Can this launch be turned into a variant group? `spawnVariants` mints a fresh
 * group off a `todo` source, so a task that is already running, or already a
 * member of a group, has nothing to spawn from.
 */
function canSpawnAsVariants(task: Task): boolean {
	return task.status === "todo" && task.groupId == null;
}
