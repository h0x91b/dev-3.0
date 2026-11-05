import { type AgentMessageSource, getTaskTitle, type Project, type ScheduledMessageTarget, type Task } from "../shared/types";
import { agentSessionRecord } from "./agent-session-receipts";
import * as data from "./data";
import { taskDir } from "./git";
import { createLogger } from "./logger";
import { sendMessageImmediately } from "./scheduled-message-scheduler";
// Push via the barrel, not ./rpc-handlers/shared — see the note in
// scheduled-message-scheduler.ts: it keeps mocked-barrel test suites from
// loading the real Electrobun-backed module.
import { pushCliAttention, pushCliToast } from "./rpc-handlers";

const log = createLogger("agent-launch-handoff");

const POLL_INTERVAL_MS = 1_000;
/** How long a pane may take to appear, and how long an ordinary boot may take. */
const MAX_WAIT_MS = 120_000;
/** A human may sit at a trust dialog for a while; the note is never typed before the receipt. */
const STARTUP_CEILING_MS = 30 * 60_000;
const STARTUP_WAIT_REASON = "A handoff note is waiting: the agent has not finished starting. Check its terminal for a prompt.";

/** Where a launched agent is told to write its reports, inside its own task dir. */
export function handoffReportsDir(project: Parameters<typeof taskDir>[0], task: Parameters<typeof taskDir>[1]): string {
	return `${taskDir(project, task)}/reports`;
}

/**
 * The note an agent-launched task receives as its first message. The cross-task
 * envelope already carries the sender's `seq` and, when the sending agent was
 * proven, the reply command, so the body only says who started this task and how
 * to answer.
 *
 * File-based reporting is the DEFAULT, not a coordinator's private convention:
 * a report is long, and a long body typed into a pane can lose its head
 * (issue #1608), while a path is a handful of bytes that always arrives whole.
 * Before this, every coordinator sent the same instruction by hand after every
 * single launch.
 *
 * `launcherNote` is the launcher's own standing text (`--handoff-file`), appended
 * verbatim — it never replaces the default above it.
 */
export function buildHandoffMessage(reportsDir: string, launcherNote?: string | null): string {
	const parts = [
		"You were started by the agent working on the task above, not by a human. " +
		"Your task description is the brief; you own how to carry it out.",
		`Report progress and your final result as a FILE under ${reportsDir}/ , then message back ` +
		"only its absolute path plus one line saying what it is — a short message always arrives whole, " +
		"a long one can lose its head. Questions and one-line status still go straight in a message, " +
		"with the envelope's reply command when it carries one.",
	];
	const note = launcherNote?.trim();
	if (note) parts.push(`Standing instructions from your launcher:\n${note}`);
	return parts.join("\n\n");
}

/**
 * The subject of that note. Fixed, and not a guess about anyone's content: dev3
 * wrote this body itself, so it can say what it is. Every other subject in the
 * log is the sender's own words.
 */
export const HANDOFF_SUBJECT = "Started by a peer agent";

/**
 * Deliver the handoff note into a freshly launched task once its agent can take
 * it. The launch is asynchronous (worktree + tmux + agent boot), so the task is
 * reloaded every attempt until its agent pane exists.
 *
 * A Claude session this app launched is held to evidence instead of the pane:
 * nothing is typed until that session's `SessionStart` receipt arrives, and then
 * only into the pane that sent it. Typing earlier lands in the trust dialog, whose
 * default `No, exit` the Enter confirms (#1785, #2034). There is no fallback timer
 * for it: past the boot window the card is badged, and past the ceiling the note is
 * dropped with a toast — never typed blind. Other harnesses send no receipt and keep
 * the pane-exists rule.
 *
 * Best-effort and never throws — the child still runs if the note never lands.
 */
export async function deliverLaunchHandoff(opts: {
	projectId: string;
	childTaskId: string;
	source: AgentMessageSource;
	/** The launcher's standing text, read from its `--handoff-file`. */
	launcherNote?: string | null;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<boolean> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = opts.now ?? (() => Date.now());
	const startedAt = now();
	const shortId = opts.childTaskId.slice(0, 8);
	let badged = false;
	let failingSince: number | null = null;
	let boundSessionId: string | null = null;

	while (now() < startedAt + STARTUP_CEILING_MS) {
		try {
			const project = await data.getProject(opts.projectId);
			const task = await data.getTask(project, opts.childTaskId);
			// Terminal task: the user killed or completed it mid-boot. Nothing to say.
			if (task.status === "completed" || task.status === "cancelled") {
				log.info("Handoff abandoned — task is terminal", { taskId: shortId, status: task.status });
				return false;
			}
			const panes = task.sessionState?.panes ?? [];
			if (!task.preparing && panes.length > 0) {
				const sessionId = panes[0]?.sessionId ?? null;
				const launched = sessionId ? agentSessionRecord(task.id, sessionId) : null;
				if (boundSessionId && sessionId !== boundSessionId) {
					// Relaunched under us: the note was meant for the agent that is gone, and a
					// peer relaunch brings its own handoff — typing ours too would duplicate it.
					log.info("Handoff abandoned — the launched agent was replaced", { taskId: shortId });
					notifyUndelivered(project, task, "This task was launched by an agent, but its agent was restarted before the handoff note could be delivered.");
					return false;
				}
				if (!launched?.launchedAt) {
					if (now() >= startedAt + MAX_WAIT_MS) break;
					return await sendHandoff(project, task, opts, null);
				}
				boundSessionId = sessionId;
				// Exit wins over start: whatever the agent reported, its pane is a bare shell now.
				if (launched.exitedAt !== null) {
					log.warn("Handoff abandoned — the agent exited before the note was delivered", { taskId: shortId, exitCode: launched.exitCode });
					notifyUndelivered(project, task, "This task was launched by an agent, but its agent exited before the handoff note could be delivered.");
					return false;
				}
				if (launched.startedAt !== null) {
					const target: ScheduledMessageTarget | null = launched.paneId ? { kind: "pane", paneId: launched.paneId } : null;
					return await sendHandoff(project, task, opts, target);
				}
				if (!badged && now() >= startedAt + MAX_WAIT_MS) {
					badged = true;
					log.warn("Handoff still waiting — the agent has not finished starting", { taskId: shortId });
					pushCliAttention({ taskId: task.id, projectId: project.id, reason: STARTUP_WAIT_REASON });
				}
			} else if (now() >= startedAt + MAX_WAIT_MS) {
				break;
			}
		} catch (err) {
			log.debug("Handoff attempt failed; retrying", { taskId: shortId, error: String(err) });
			// A send that keeps throwing gets the ordinary budget, not the boot ceiling.
			failingSince ??= now();
			if (now() >= failingSince + MAX_WAIT_MS) break;
		}
		await sleep(POLL_INTERVAL_MS);
	}

	log.warn("Handoff never delivered — the agent never became ready", { taskId: shortId });
	try {
		const project = await data.getProject(opts.projectId);
		const task = await data.getTask(project, opts.childTaskId);
		notifyUndelivered(project, task, "This task was launched by an agent, but the handoff note could not be delivered.");
	} catch {
		// The task or project vanished while we waited — nothing left to notify about.
	}
	return false;
}

async function sendHandoff(
	project: Project,
	task: Task,
	opts: { source: AgentMessageSource; launcherNote?: string | null },
	target: ScheduledMessageTarget | null,
): Promise<boolean> {
	// Not held: this is the first thing a just-booted agent hears, into a pane
	// nobody has typed into yet. Waiting for it to "go quiet" would leave the
	// child sitting idle for the whole window with the launcher watching.
	const body = buildHandoffMessage(handoffReportsDir(project, task), opts.launcherNote);
	await sendMessageImmediately(task, body, target, opts.source, {
		hold: false,
		subject: HANDOFF_SUBJECT,
	});
	log.info("Handoff delivered", { taskId: task.id.slice(0, 8), fromSeq: opts.source.seq, paneId: target?.kind === "pane" ? target.paneId : null });
	return true;
}

function notifyUndelivered(project: Project, task: Task, message: string): void {
	pushCliToast({
		taskId: task.id,
		projectId: project.id,
		message,
		level: "error",
		taskSeq: task.seq,
		taskTitle: getTaskTitle(task),
		projectName: project.name,
	});
}
