import { AutoHibernateScheduler } from "./auto-hibernate-scheduler";
import * as data from "./data";
import { loadSettings } from "./settings";
import { dispatchLifecycleEvent } from "./lifecycle/service";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";
import { getNativeTaskOutputTime, getSessionTmuxName } from "./pty-server";
import { tmux, PEEK_PANE_FORMAT } from "./tmux";
import { createLogger } from "./logger";
import { nativeTaskPanesState } from "./native-task-panes";

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
		outputAt: async task => {
			if (taskTerminalBackendIdentity(task) === "native") {
				const state = await nativeTaskPanesState(task.id);
				return state ? getNativeTaskOutputTime(task.id, state.panes.map(pane => pane.paneId)) : null;
			}
			const panes = await tmux.listPanes(PEEK_PANE_FORMAT, {
				target: getSessionTmuxName(task.id), scope: "session", socket: task.tmuxSocket ?? undefined,
			});
			if (!panes.length || panes.some(pane => !Number.isFinite(pane.windowActivity) || pane.windowActivity <= 0)) return null;
			return Math.max(...panes.map(pane => pane.windowActivity * 1000));
		},
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
