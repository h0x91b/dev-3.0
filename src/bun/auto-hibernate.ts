import { readAutoHibernateOutputAt } from "./auto-hibernate-activity";
import { AutoHibernateScheduler } from "./auto-hibernate-scheduler";
import * as data from "./data";
import { loadSettings } from "./settings";
import { dispatchLifecycleEvent } from "./lifecycle/service";
import { createLogger } from "./logger";

const log = createLogger("auto-hibernate");
let timer: ReturnType<typeof setInterval> | null = null;
let scheduler: AutoHibernateScheduler | null = null;

export function startAutoHibernate(): void {
	if (timer) return;
	scheduler = new AutoHibernateScheduler({
		minutes: async () => (await loadSettings()).autoHibernateMinutes,
		tasks: async () => {
			const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
			return (await Promise.all(projects.map(async project =>
				(await data.loadTasks(project)).map(task => ({ project, task })),
			))).flat();
		},
		outputAt: readAutoHibernateOutputAt,
		hibernate: async (project, task, inactivity) => {
			const updated = await dispatchLifecycleEvent(project.id, task.id, { type: "hibernateRequested", inactivity });
			if (updated.hibernated) log.info("Hibernated inactive task", { taskId: task.id });
		},
		onError: error => log.warn("Inactivity check failed", { error: String(error) }),
		now: Date.now,
	});
	timer = setInterval(() => { void scheduler?.tick(); }, 30_000);
	timer.unref?.();
}

export function stopAutoHibernate(): void {
	scheduler?.stop();
	scheduler = null;
	if (timer) clearInterval(timer);
	timer = null;
}
