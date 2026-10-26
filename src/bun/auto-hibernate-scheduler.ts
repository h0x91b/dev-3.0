import { canAutoHibernate, normalizeAutoHibernateMinutes, taskInactivityStateAt } from "../shared/auto-hibernate";
import type { Project, Task } from "../shared/types";
import { lastAutoHibernatePolicyChange, lastTaskActivity, recordTaskActivity } from "./task-activity";

export interface AutoHibernateDependencies {
	minutes(): Promise<number | undefined>;
	tasks(): Promise<Array<{ project: Project; task: Task }>>;
	outputAt(task: Task): Promise<number | null>;
	hibernate(project: Project, task: Task, inactivity: { lastActivityAt: number; timeoutMinutes: number }): Promise<void>;
	onError(error: unknown): void;
	now(): number;
}

export class AutoHibernateScheduler {
	private observed = new Map<string, number>();
	private minutes = 0;
	private running = false;
	private stopped = false;

	constructor(private readonly deps: AutoHibernateDependencies) {}

	stop(): void { this.stopped = true; }

	async tick(): Promise<void> {
		if (this.running || this.stopped) return;
		this.running = true;
		try {
			const minutes = normalizeAutoHibernateMinutes(await this.deps.minutes());
			if (minutes !== this.minutes || !minutes) this.observed.clear();
			this.minutes = minutes;
			if (!minutes) return;
			const seen = new Set<string>();
			for (const { project, task } of await this.deps.tasks()) {
				seen.add(task.id);
				if (!canAutoHibernate(task)) { this.observed.delete(task.id); continue; }
				try {
					const now = this.deps.now();
					const since = this.observed.get(task.id) ?? now;
					this.observed.set(task.id, since);
					const outputAt = await this.deps.outputAt(task);
					// A failed probe starts a fresh window; unknown never means inactive.
					if (outputAt == null || !Number.isFinite(outputAt) || outputAt <= 0) {
						this.observed.set(task.id, now);
						continue;
					}
					recordTaskActivity(task.id, outputAt);
					const lastActivityAt = Math.max(since, lastAutoHibernatePolicyChange(), lastTaskActivity(task.id), taskInactivityStateAt(task));
					if (now - lastActivityAt < minutes * 60_000) continue;
					if (this.stopped) return;
					await this.deps.hibernate(project, task, { lastActivityAt, timeoutMinutes: minutes });
					this.observed.delete(task.id);
				} catch (error) {
					this.observed.set(task.id, this.deps.now());
					this.deps.onError(error);
				}
			}
			for (const id of this.observed.keys()) if (!seen.has(id)) this.observed.delete(id);
		} catch (error) {
			this.observed.clear();
			this.deps.onError(error);
		} finally {
			this.running = false;
		}
	}
}
