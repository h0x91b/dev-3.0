import type { Project } from "../shared/types";
import * as data from "./data";
import { fireScheduledLaunch } from "./rpc-handlers/task-lifecycle";
import { createLogger } from "./logger";

const log = createLogger("scheduled-launch-scheduler");

/** How often the scheduler wakes up to check for due deferred launches. */
const TICK_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * Fires "Start in…" deferred launches (see {@link Task.scheduledLaunch}).
 *
 * Unlike Automations these are one-shot, so there is no missed/catch-up
 * taxonomy: an occurrence that passed while the app was offline simply fires
 * on the first tick after startup (late but never lost — the user asked for
 * exactly one launch). Firing consumes the source todo task via the same
 * spawnVariants pipeline as an immediate launch, so a crash between delete
 * and spawn is bounded to the same guarantees spawnVariants already has.
 */
export function startScheduledLaunchScheduler(): void {
	if (timer) return;
	log.info("Scheduled-launch scheduler started", { tickMs: TICK_INTERVAL_MS });
	// First tick runs immediately: it is also the offline late-fire catch-up.
	void tick();
	timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

export function stopScheduledLaunchScheduler(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

async function tick(): Promise<void> {
	if (tickInFlight) return; // never overlap ticks — the double-fire guard
	tickInFlight = true;
	try {
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			try {
				await tickProject(project);
			} catch (err) {
				log.error("Scheduled-launch tick failed for project", { projectId: project.id, error: String(err) });
			}
		}
	} catch (err) {
		log.error("Scheduled-launch tick failed", { error: String(err) });
	} finally {
		tickInFlight = false;
	}
}

async function tickProject(project: Project): Promise<void> {
	const tasks = await data.loadTasks(project);
	const now = Date.now();
	for (const task of tasks) {
		const sched = task.scheduledLaunch;
		if (!sched) continue;
		// Only todo tasks can spawn variants; a stale field on any other status
		// is inert (spawnVariants would reject it anyway).
		if (task.status !== "todo") continue;
		const at = new Date(sched.at).getTime();
		if (!Number.isFinite(at)) {
			log.error("Scheduled launch has an unparseable time; clearing it", { taskId: task.id.slice(0, 8), at: sched.at });
			await data.updateTask(project, task.id, { scheduledLaunch: null });
			continue;
		}
		if (at > now) continue;
		try {
			await fireScheduledLaunch(project, task);
		} catch (err) {
			// Clear the field so a permanently-failing launch does not retry every
			// tick forever; the task itself stays in todo for the user to relaunch.
			log.error("Scheduled launch fire failed; clearing schedule", { taskId: task.id.slice(0, 8), error: String(err) });
			try {
				await data.updateTask(project, task.id, { scheduledLaunch: null });
			} catch {
				// task may have been consumed mid-failure; nothing left to clear
			}
		}
	}
}
