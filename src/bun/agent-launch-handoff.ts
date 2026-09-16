import { type AgentMessageSource, getTaskTitle } from "../shared/types";
import * as data from "./data";
import { taskDir } from "./git";
import { createLogger } from "./logger";
import { sendMessageImmediately } from "./scheduled-message-scheduler";
// Push via the barrel, not ./rpc-handlers/shared — see the note in
// scheduled-message-scheduler.ts: it keeps mocked-barrel test suites from
// loading the real Electrobun-backed module.
import { pushCliAttention, pushCliToast } from "./rpc-handlers";
import { agentReadiness } from "./agent-readiness";

const log = createLogger("agent-launch-handoff");

const POLL_INTERVAL_MS = 1_000;
/** How long the agent's PANE may take to appear before we give up on the launch. */
const MAX_WAIT_MS = 120_000;
/**
 * How long the agent may then take to finish starting up.
 *
 * Far longer than the pane budget, and deliberately not a guess about boot time:
 * while readiness says `booting` the wait is answering a HUMAN — someone has to
 * read Claude Code's trust dialog or finish a login — and dev3 must not answer it
 * for them. The ceiling exists only so a task nobody ever returns to stops
 * polling; reaching it costs a toast, never a typed keystroke.
 */
const MAX_AGENT_BOOT_WAIT_MS = 30 * 60_000;

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
 * Deliver the handoff note into a freshly launched task once its agent is
 * actually listening. The launch is asynchronous (worktree + tmux + agent boot),
 * so a straight send would hit "no live agent session" — hence the poll. Reloads
 * the task each attempt: the pane list only lands on disk after the PTY comes up.
 *
 * A live PANE is not a listening AGENT, and the difference is what made this
 * function dangerous: typed into a pane whose agent still had its trust dialog
 * up, the note's Enter confirmed the highlighted "No, exit" and killed the agent
 * dev3 had just started (h0x91b/dev-3.0#1785). So the wait now also asks
 * `agent-readiness.ts` whether the agent reported in.
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
	const started = now();
	const shortId = opts.childTaskId.slice(0, 8);
	let reason = "the agent's terminal never came up";
	let warned = false;

	for (;;) {
		const elapsed = now() - started;
		try {
			const project = await data.getProject(opts.projectId);
			const task = await data.getTask(project, opts.childTaskId);
			// Terminal task: the user killed or completed it mid-boot. Nothing to say.
			if (task.status === "completed" || task.status === "cancelled") {
				log.info("Handoff abandoned — task is terminal", { taskId: shortId, status: task.status });
				return false;
			}
			if (!task.preparing && (task.sessionState?.panes?.length ?? 0) > 0) {
				const readiness = agentReadiness(task.id);
				// The agent quit before it ever heard from us — most often because it
				// asked the human something nobody answered. Typing now would go into
				// the shell the dead agent left behind.
				if (readiness === "gone") {
					reason = "the agent exited before the note could be delivered";
					break;
				}
				if (readiness === "booting") {
					// Its own trust / login prompt is still up, waiting on a human. Wait
					// with it: the note's Enter would answer that prompt, and the
					// highlighted answer is "No, exit" (h0x91b/dev-3.0#1785).
					//
					// Say so once, as soon as the wait stops looking like an ordinary
					// boot. Nobody is watching a pane an agent started, and the card
					// would otherwise sit in "Agent is Working" for the whole ceiling.
					if (!warned && elapsed >= MAX_WAIT_MS) {
						warned = true;
						pushCliAttention({
							taskId: task.id,
							projectId: project.id,
							reason: "Agent has not finished starting — it may be waiting on its own trust or login prompt",
						});
					}
					if (elapsed >= MAX_AGENT_BOOT_WAIT_MS) {
						reason = "the agent never finished starting up — it may still be waiting on its own trust or login prompt";
						break;
					}
				} else {
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
			} else if (elapsed >= MAX_WAIT_MS) {
				break;
			}
		} catch (err) {
			log.debug("Handoff attempt failed; retrying", { taskId: shortId, error: String(err) });
			if (elapsed >= MAX_AGENT_BOOT_WAIT_MS) break;
		}
		await sleep(POLL_INTERVAL_MS);
	}

	log.warn("Handoff never delivered", { taskId: shortId, reason });
	try {
		const project = await data.getProject(opts.projectId);
		const task = await data.getTask(project, opts.childTaskId);
		pushCliToast({
			taskId: task.id,
			projectId: project.id,
			message: `This task was launched by an agent, but the handoff note could not be delivered — ${reason}.`,
			level: "error",
			taskSeq: task.seq,
			taskTitle: getTaskTitle(task),
			projectName: project.name,
		});
		pushCliAttention({
			taskId: task.id,
			projectId: project.id,
			reason: `Handoff note not delivered — ${reason}`,
		});
	} catch {
		// The task or project vanished while we waited — nothing left to notify about.
	}
	return false;
}
