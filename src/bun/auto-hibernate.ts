import type { AutoHibernateSuggestion } from "../shared/auto-hibernate";
import { readAutoHibernateOutputAt } from "./auto-hibernate-activity";
import { AutoHibernateScheduler } from "./auto-hibernate-scheduler";
import * as data from "./data";
import { loadSettings } from "./settings";
import { dispatchGuardedLifecycleEvent } from "./lifecycle/service";
import { confirmAutoHibernate } from "./auto-hibernate-guard";
import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers/shared";

const log = createLogger("auto-hibernate");
let timer: ReturnType<typeof setInterval> | null = null;
let scheduler: AutoHibernateScheduler | null = null;

export function startAutoHibernate(): void {
	if (timer) return;
	scheduler = new AutoHibernateScheduler({
		minutes: async () => (await loadSettings()).autoHibernateMinutes,
		confirmMinutes: async () => (await loadSettings()).autoHibernateConfirmMinutes,
		changed: suggestion => getPushMessage()?.("autoHibernateSuggestionChanged", { suggestion }),
		tasks: async () => {
			const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
			return (await Promise.all(projects.map(async project =>
				(await data.loadTasks(project)).map(task => ({ project, task })),
			))).flat();
		},
		outputAt: readAutoHibernateOutputAt,
		hibernate: async (project, task, inactivity, timed, authorized) => {
			const updated = await dispatchGuardedLifecycleEvent(project.id, task.id,
				{ type: "hibernateRequested", inactivity }, async current => authorized() && await confirmAutoHibernate(current, inactivity) && authorized());
			if (updated.hibernated) {
				log.info("Hibernated inactive task", { taskId: task.id });
				if (timed) getPushMessage()?.("taskAutoHibernated", { projectId: project.id, taskId: task.id });
			}
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

export function getAutoHibernateSuggestion(): AutoHibernateSuggestion | null {
	return scheduler?.getSuggestion() ?? null;
}

export async function presentAutoHibernateSuggestion(id: string): Promise<void> {
	await scheduler?.present(id);
}

export async function respondAutoHibernateSuggestion(params: { id: string; action: "hibernate" | "snooze" | "hold"; taskIds: string[] }): Promise<void> {
	await scheduler?.respond(params);
}
