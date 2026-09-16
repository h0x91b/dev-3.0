import { type AgentMessageSource, getTaskTitle } from "../shared/types";
import * as data from "./data";
import { taskDir } from "./git";
import { createLogger } from "./logger";
import { sendMessageImmediately } from "./scheduled-message-scheduler";
// Push via the barrel, not ./rpc-handlers/shared — see the note in
// scheduled-message-scheduler.ts: it keeps mocked-barrel test suites from
// loading the real Electrobun-backed module.
import { pushCliToast } from "./rpc-handlers";

const log = createLogger("agent-launch-handoff");

const POLL_INTERVAL_MS = 1_000;
const MAX_WAIT_MS = 120_000;

/** Where a launched agent is told to write its reports, inside its own task dir. */
export function handoffReportsDir(project: Parameters<typeof taskDir>[0], task: Parameters<typeof taskDir>[1]): string {
	return `${taskDir(project, task)}/reports`;
}

/**
 * The note an agent-launched task receives as its first message. The cross-task
 * envelope already carries the sender's `seq` and the reply command, so the body
 * only establishes who started this task and how to answer.
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
		"with the reply command below.",
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
 * Deliver the handoff note into a freshly launched task once its agent pane is
 * actually alive. The launch is asynchronous (worktree + tmux + agent boot), so
 * a straight send would hit "no live agent session" — hence the poll. Reloads the
 * task each attempt: the pane list only lands on disk after the PTY comes up.
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
	const deadline = now() + MAX_WAIT_MS;
	const shortId = opts.childTaskId.slice(0, 8);

	while (now() < deadline) {
		try {
			const project = await data.getProject(opts.projectId);
			const task = await data.getTask(project, opts.childTaskId);
			// Terminal task: the user killed or completed it mid-boot. Nothing to say.
			if (task.status === "completed" || task.status === "cancelled") {
				log.info("Handoff abandoned — task is terminal", { taskId: shortId, status: task.status });
				return false;
			}
			if (!task.preparing && (task.sessionState?.panes?.length ?? 0) > 0) {
				// Not held: this is the first thing a just-booted agent hears, into a pane
				// nobody has typed into yet. Waiting for it to "go quiet" would leave the
				// child sitting idle for the whole window with the launcher watching.
				const body = buildHandoffMessage(handoffReportsDir(project, task), opts.launcherNote);
				await sendMessageImmediately(task, body, null, opts.source, {
					hold: false,
					subject: HANDOFF_SUBJECT,
				});
				log.info("Handoff delivered", { taskId: shortId, fromSeq: opts.source.seq });
				return true;
			}
		} catch (err) {
			log.debug("Handoff attempt failed; retrying", { taskId: shortId, error: String(err) });
		}
		await sleep(POLL_INTERVAL_MS);
	}

	log.warn("Handoff never delivered — agent pane did not come up in time", { taskId: shortId });
	try {
		const project = await data.getProject(opts.projectId);
		const task = await data.getTask(project, opts.childTaskId);
		pushCliToast({
			taskId: task.id,
			projectId: project.id,
			message: "This task was launched by an agent, but the handoff note could not be delivered.",
			level: "error",
			taskSeq: task.seq,
			taskTitle: getTaskTitle(task),
			projectName: project.name,
		});
	} catch {
		// The task or project vanished while we waited — nothing left to notify about.
	}
	return false;
}
