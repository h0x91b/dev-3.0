import type { Project, Task } from "../shared/types";
import * as data from "./data";
import { DEFAULT_TMUX_SOCKET, taskSessionName, tmux } from "./tmux";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { createLogger } from "./logger";
import { isLatestAgentLaunch } from "./agent-session-receipts";

const log = createLogger("agent-launch-failure");

const MAX_LINES = 40;
const MAX_CHARS = 8000;
// The card move waits for the capture, so a stuck tmux must not hold it for the client's full timeout.
const CAPTURE_TIMEOUT_MS = 1500;

/** The last screen lines of the agent's output, without the run script's own `Starting:` banner: trailing blanks dropped, the tail kept. */
export function trimLaunchFailureOutput(raw: string): string | null {
	const lines = raw.split("\n").filter((line) => !line.startsWith("Starting: ")).map((line) => line.trimEnd());
	while (lines.length && !lines[lines.length - 1]) lines.pop();
	const text = lines.slice(-MAX_LINES).join("\n");
	if (!text) return null;
	return text.length > MAX_CHARS ? text.slice(-MAX_CHARS) : text;
}

/** Plain-text screen of the main agent pane; null on the native backend or any capture failure. */
async function captureAgentOutput(task: Task): Promise<string | null> {
	try {
		if (taskTerminalBackendIdentity(task) !== "tmux") return null;
		const target = task.sessionState?.panes?.[0]?.paneId ?? taskSessionName(task.id);
		const capture = tmux.capturePane({ target, joinWrapped: true, socket: task.tmuxSocket ?? DEFAULT_TMUX_SOCKET });
		capture.catch(() => {});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<null>((resolve) => { timer = setTimeout(resolve, CAPTURE_TIMEOUT_MS, null); });
		try {
			const raw = await Promise.race([capture, timeout]);
			return raw === null ? null : trimLaunchFailureOutput(raw);
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		log.warn("Could not capture the failed agent's output (non-fatal)", { taskId: task.id.slice(0, 8), error: String(err) });
		return null;
	}
}

/** Keeps the dead agent's last screen on the task, so recovery can say why it died after the pane is gone. */
export async function recordLaunchFailure(
	project: Project,
	task: Task,
	failure: { exitCode: number | null; sessionId: string; neverStarted: boolean },
	pushTaskUpdated: (payload: { projectId: string; task: Task }) => void,
): Promise<void> {
	try {
		const launchFailure = { ...failure, at: new Date().toISOString(), output: await captureAgentOutput(task) };
		// The capture takes time: a launch that started meanwhile must not get this run's failure.
		const { task: updated, result: wrote } = await data.updateTaskWith(project, task.id, () =>
			isLatestAgentLaunch(task.id, failure.sessionId)
				? { updates: { launchFailure }, result: true }
				: { updates: {}, result: false });
		if (wrote) pushTaskUpdated({ projectId: project.id, task: updated });
	} catch (err) {
		log.warn("Could not save the launch failure (non-fatal)", { taskId: task.id.slice(0, 8), error: String(err) });
	}
}
