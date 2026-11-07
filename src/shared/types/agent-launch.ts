import type { ResumeDialogPane } from "../agent-resume";
import type { AgentSessionAction } from "../task-hibernate";
import type { ExternalSenderRequester } from "../external-senders";
import type { TaskStatus } from "./task-status";
import { DEFAULT_PRIORITY, type TaskPriority } from "./task-priority";
import type { Task } from "./task";
import type { GlobalSettings } from "./global-settings";
import { taskUsesWorktree, type Project } from "./project";
import type { Label } from "./labels-columns";
import { getTaskOverview, taskSeqLabel } from "./task-display";

/** One row of the Launch modal: the agent + configuration to run, plus the
 *  per-launch managed account (`undefined` → the registry default; `null` → the
 *  system login; a string → that account). Shared by every spawn/schedule RPC so
 *  the trio travels as one named concept instead of a repeated inline literal. */
export interface LaunchVariant {
	agentId: string | null;
	configId: string | null;
	accountId?: string | null;
}

/**
 * What the agent-requested launch dialog hands back on approval: the variant
 * rows the user composed (always at least one — index 0 is variant #1) plus the
 * priority the launch applies. One variant takes the plain single-task launch
 * path; more mint a variant group exactly like the Launch modal does.
 */
export interface AgentLaunchChoice {
	variants: LaunchVariant[];
	/** undefined → the request's `defaultPriority`; otherwise the user's pick. */
	priority?: TaskPriority;
}

/** A one-shot deferred launch persisted on a `todo` task. See {@link Task.scheduledLaunch}. */
export interface ScheduledLaunch {
	/** ISO timestamp when the launch should fire. */
	at: string;
	/** Column the spawned variants land in (same as an immediate launch). */
	targetStatus: TaskStatus;
	/** Agent/config/account variants captured from the Launch modal at schedule time. */
	variants: LaunchVariant[];
}

/**
 * Read-only task context rendered in the completion-approval and branch-merged
 * confirm dialogs so the user can recognize *which* project/task a
 * session-destroying prompt is about. Built once on the bun side (where the full
 * task + project are known) and shipped verbatim in the push message — the
 * renderer never re-derives it, so a dialog firing while the user is on another
 * project's board still shows the right project name and labels.
 */
export interface TaskDialogSubject {
	/** Per-project sequential id, variant suffix included (e.g. `"1159"`, `"1159-1"`). */
	seqLabel: string;
	/** Owning project's display name. */
	projectName: string;
	/** Task importance band. */
	priority: TaskPriority;
	/** Resolved labels (id/name/color), in the task's stored order; empty if none. */
	labels: Label[];
	/** Effective overview (user override → agent), or null when neither is set. */
	overview: string | null;
	/** Finishing the task keeps its folder: it shares a gitless project's folder, so no worktree is removed. */
	keepsFolder?: boolean;
}

/**
 * An agent asking the user for permission to complete its own task — the payload
 * of the `agentCompletionRequested` push, and of `listPendingCompletionRequests`
 * for a renderer that connected after the push went out.
 */
export interface AgentCompletionRequest {
	requestId: string;
	taskId: string;
	projectId: string;
	taskTitle: string;
	subject: TaskDialogSubject;
}

/**
 * An agent asking the user for permission to CANCEL its own task — the payload
 * of the `agentCancellationRequested` push, and of
 * `listPendingCancellationRequests` for a renderer that connected after the
 * push went out.
 *
 * Same shape as {@link AgentCompletionRequest}, deliberately its own type and
 * its own channel: completion says the work landed, cancellation throws it away,
 * and the dialog that asks must never be mistaken for the other one.
 */
export interface AgentCancellationRequest {
	requestId: string;
	taskId: string;
	projectId: string;
	taskTitle: string;
	subject: TaskDialogSubject;
}

/**
 * An agent asking the user to set ANOTHER task running — the payload of the
 * `agentLaunchRequested` push. Carries who asked (`requesterSeq`/`requesterTitle`)
 * so the dialog can name the agent, and the same read-only subject card the
 * completion dialog uses. `scratch` marks the throwaway-peer case, which has no
 * prompt by design.
 */
export interface AgentLaunchRequest {
	/** CLI +Agent request: one pane, not a task/variant launch. */
	spawn?: { choice: LaunchVariant; prompt?: string; handoff: boolean };
	/** `dev3 agent resume`: restore these saved panes exactly — the dialog offers no agent choice. */
	resume?: { panes: ResumeDialogPane[] };
	/** `dev3 task hibernate` / `dev3 task wake --shell`: act on the task's session — the dialog offers no agent choice. */
	sessionAction?: AgentSessionAction;
	/**
	 * Agent/config the requesting agent suggested with `--agent`/`--config`,
	 * already validated. Only preselects the picker — the user still decides.
	 */
	suggested?: LaunchVariant;
	requestId: string;
	taskId: string;
	projectId: string;
	taskTitle: string;
	targetStatus: TaskStatus;
	scratch: boolean;
	requesterSeq: number;
	requesterTitle: string;
	/**
	 * Set when a registered external sender asked (`--as-sender`) rather than a
	 * task: the dialog names it instead of `#requesterSeq`. Self-asserted on a
	 * same-user socket, so it attributes the request and proves nothing.
	 */
	requesterSender?: ExternalSenderRequester;
	subject: TaskDialogSubject;
	/**
	 * Priority the launch applies unless the user picks another in the dialog:
	 * the target's own explicit priority, or the requester's when the target
	 * never had one set (a scratch peer, or a task created without `--priority`).
	 * An urgent agent's helpers inherit its urgency instead of sinking to P3.
	 */
	defaultPriority: TaskPriority;
	/**
	 * May the user turn this launch into a variant group? Only a plain `todo`
	 * task that is not already in a group can be spawned as variants; anything
	 * else renders the single picker with no add affordance rather than offering
	 * a control that would fail on approval.
	 */
	canAddVariants: boolean;
	/**
	 * Epoch ms at which the request approves itself, or null when auto-approval
	 * is off. The countdown is only a mirror — the timer that actually fires
	 * lives in the bun process, so closing the window cannot stall the agent.
	 */
	autoApproveAt: number | null;
}

/**
 * Minutes the launch dialog waits before approving itself when unconfigured.
 * One minute: the delay only exists so an absent user does not strand the asking
 * agent, and the countdown now stops the moment anyone touches the dialog, so
 * waiting longer buys nothing.
 */
export const DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES = 1;

/** Shortest and longest delay the picker accepts; anything else is clamped into the range. */
export const AGENT_LAUNCH_AUTO_APPROVE_MIN_MS = 5_000;
export const AGENT_LAUNCH_AUTO_APPROVE_MAX_MS = 24 * 60 * 60 * 1000;

/** The delay as the picker shows it: hours, minutes and seconds side by side. */
export interface AutoApproveHms {
	hours: number;
	minutes: number;
	seconds: number;
}

/**
 * Resolve the configured auto-approve delay in ms; `0` means "never auto-approve".
 * A stored value outside the accepted range is clamped rather than dropped — an
 * older build (or a hand-edited settings file) must not be able to park an agent
 * on a dialog for a week, nor fire the timer before a dialog can even paint.
 */
export function agentLaunchAutoApproveMs(settings: Pick<GlobalSettings, "agentLaunchAutoApproveMinutes">): number {
	const minutes = settings.agentLaunchAutoApproveMinutes ?? DEFAULT_AGENT_LAUNCH_AUTO_APPROVE_MINUTES;
	if (!Number.isFinite(minutes) || minutes <= 0) return 0;
	const ms = Math.round(minutes * 60_000);
	return Math.min(AGENT_LAUNCH_AUTO_APPROVE_MAX_MS, Math.max(AGENT_LAUNCH_AUTO_APPROVE_MIN_MS, ms));
}

/** Split a stored minutes value into the hours/minutes/seconds the picker shows. */
export function splitAutoApproveHms(minutes: number): AutoApproveHms {
	const total = Math.max(0, Math.round((Number.isFinite(minutes) ? minutes : 0) * 60));
	return {
		hours: Math.floor(total / 3_600),
		minutes: Math.floor((total % 3_600) / 60),
		seconds: total % 60,
	};
}

/** Build a stored minutes value from the picker fields, clamped into the accepted range. */
export function autoApproveMinutesFromHms(hms: AutoApproveHms): number {
	const part = (value: number) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
	const ms = (part(hms.hours) * 3_600 + part(hms.minutes) * 60 + part(hms.seconds)) * 1_000;
	const clamped = Math.min(AGENT_LAUNCH_AUTO_APPROVE_MAX_MS, Math.max(AGENT_LAUNCH_AUTO_APPROVE_MIN_MS, ms));
	return clamped / 60_000;
}

/**
 * Build the {@link TaskDialogSubject} for a task from its project. Pure: resolves
 * `task.labelIds` against `project.labels`, falls back to {@link DEFAULT_PRIORITY}
 * for legacy tasks, and reuses {@link taskSeqLabel}/{@link getTaskOverview}.
 */
export function buildTaskDialogSubject(task: Task, project: Project): TaskDialogSubject {
	const labelById = new Map((project.labels ?? []).map((l) => [l.id, l]));
	const labels = (task.labelIds ?? [])
		.map((id) => labelById.get(id))
		.filter((l): l is Label => l != null);
	return {
		seqLabel: taskSeqLabel(task),
		projectName: project.name,
		priority: task.priority ?? DEFAULT_PRIORITY,
		labels,
		overview: getTaskOverview(task),
		keepsFolder: !taskUsesWorktree(project, task),
	};
}
