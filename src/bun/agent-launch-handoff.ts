import { type AgentMessageSource, getTaskTitle } from "../shared/types";
import * as data from "./data";
import { createLogger } from "./logger";
import { sendMessageImmediately } from "./scheduled-message-scheduler";
// Push via the barrel, not ./rpc-handlers/shared — see the note in
// scheduled-message-scheduler.ts: it keeps mocked-barrel test suites from
// loading the real Electrobun-backed module.
import { pushCliToast } from "./rpc-handlers";

const log = createLogger("agent-launch-handoff");

const POLL_INTERVAL_MS = 1_000;
const MAX_WAIT_MS = 120_000;

/**
 * The note an agent-launched task receives as its first message. The cross-task
 * envelope already carries the sender's `seq` and the reply command, so the body
 * only has to establish that a peer agent — not the human — started this task.
 */
export const HANDOFF_MESSAGE =
	"You were started by the agent working on the task above, not by a human. " +
	"Report your progress, questions, and final result back to it with the reply command below.";

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
				await sendMessageImmediately(task, HANDOFF_MESSAGE, null, opts.source);
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
