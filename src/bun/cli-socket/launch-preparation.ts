import type { Project, Task } from "../../shared/types";
import { LAUNCH_PREPARATION_REPORT_BUDGET_MS, type LaunchPreparationOutcome } from "../../shared/launch-preparation";
import * as data from "../data";

const POLL_MS = 500;
const UNEXPLAINED_FAILURE = "Preparation stopped before the agent started (cancelled or interrupted).";

function preparationInFlight(task: Task): boolean {
	return task.preparing === true || task.runtimeState?.runtime === "preparing";
}

/** Read a settled task: a start leaves it in its active column with no preparation error. */
export function preparationOutcomeOf(task: Task): LaunchPreparationOutcome {
	if (preparationInFlight(task)) return { state: "still-preparing" };
	if (task.preparationError) return { state: "failed", error: task.preparationError };
	if (task.status === "todo" || task.status === "completed" || task.status === "cancelled") {
		return { state: "failed", error: UNEXPLAINED_FAILURE };
	}
	return { state: "started" };
}

/**
 * Wait for a launched task's preparation to settle, reading the persisted record
 * — the only view every dev3 instance shares, so a run another instance broke
 * (2026-11-01 incident) still reads as failed rather than as a launch.
 */
export async function awaitLaunchPreparation(
	project: Project,
	taskId: string,
	opts: { budgetMs?: number; pollMs?: number } = {},
): Promise<LaunchPreparationOutcome> {
	const deadline = Date.now() + (opts.budgetMs ?? LAUNCH_PREPARATION_REPORT_BUDGET_MS);
	const pollMs = opts.pollMs ?? POLL_MS;
	for (;;) {
		let task: Task;
		try {
			task = await data.getTask(project, taskId);
		} catch {
			return { state: "failed", error: "The launched task no longer exists." };
		}
		const outcome = preparationOutcomeOf(task);
		if (outcome.state !== "still-preparing" || Date.now() >= deadline) return outcome;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
