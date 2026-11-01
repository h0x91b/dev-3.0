import type { Task } from "../shared/types";
import { autoHibernateStillIdle } from "../shared/auto-hibernate";
import { loadSettings } from "./settings";
import { readAutoHibernateOutputAt } from "./auto-hibernate-activity";
import { lastTaskActivity, recordTaskActivity } from "./task-activity";

export async function confirmAutoHibernate(task: Task, inactivity: { lastActivityAt: number; timeoutMinutes: number }): Promise<boolean> {
	try {
		const configured = (await loadSettings()).autoHibernateMinutes;
		const outputAt = await readAutoHibernateOutputAt(task);
		if (outputAt === null) return false;
		recordTaskActivity(task.id, outputAt);
		return autoHibernateStillIdle(task, inactivity.lastActivityAt, inactivity.timeoutMinutes, configured,
			lastTaskActivity(task.id), Date.now());
	} catch { return false; }
}
