import { autoHibernateStillIdle, canAutoHibernate, normalizeAutoHibernateConfirmMinutes, normalizeAutoHibernateMinutes, taskInactivityStateAt, type AutoHibernateSuggestion } from "../shared/auto-hibernate";
import type { Project, Task } from "../shared/types";
import { lastAutoHibernatePolicyChange, lastTaskActivity, recordTaskActivity } from "./task-activity";

export interface AutoHibernateDependencies {
	minutes(): Promise<number | undefined>;
	confirmMinutes(): Promise<number | undefined>;
	tasks(): Promise<Array<{ project: Project; task: Task }>>;
	outputAt(task: Task): Promise<number | null>;
	hibernate(project: Project, task: Task, inactivity: { lastActivityAt: number; timeoutMinutes: number }, timed: boolean, authorized: () => boolean): Promise<void>;
	changed(suggestion: AutoHibernateSuggestion | null): void;
	onError(error: unknown): void;
	now(): number;
}

type Candidate = { project: Project; task: Task; lastActivityAt: number; timeoutMinutes: number };

export class AutoHibernateScheduler {
	private observed = new Map<string, number>();
	private snoozed = new Map<string, { until: number; activityAt: number }>();
	private minutes = 0;
	private confirmMinutes = 0;
	private policyRevision = lastAutoHibernatePolicyChange();
	private pendingPolicyRevision = 0;
	private pending: AutoHibernateSuggestion | null = null;
	private revision = 0;
	private checking: Promise<void> | null = null;
	private applying = false;
	private stopped = false;

	constructor(private readonly deps: AutoHibernateDependencies) {}

	getSuggestion(): AutoHibernateSuggestion | null {
		return this.pending ? { ...this.pending, tasks: this.pending.tasks.map(task => ({ ...task })) } : null;
	}

	stop(): void { this.stopped = true; this.setPending(null); }

	async present(id: string): Promise<void> {
		const pending = this.pending;
		if (!pending || pending.id !== id || pending.held || pending.autoConfirmAt !== null) return;
		const minutes = normalizeAutoHibernateConfirmMinutes(await this.deps.confirmMinutes());
		if (this.pending !== pending || pending.held || pending.autoConfirmAt !== null || this.stopped) return;
		if (this.pendingPolicyRevision !== lastAutoHibernatePolicyChange() || minutes !== this.confirmMinutes) {
			this.setPending(null);
			return;
		}
		this.setPending({ ...pending, autoConfirmAt: this.deps.now() + minutes * 60_000 });
	}

	async respond(params: { id: string; action: "hibernate" | "snooze" | "hold"; taskIds: string[] }): Promise<void> {
		if (!this.pending || this.pending.id !== params.id || this.stopped) return;
		// Cancel an expiring countdown synchronously, before waiting on any probe.
		this.setPending({ ...this.pending, held: true, autoConfirmAt: null });
		if (params.action === "hold") return;
		if (params.action === "snooze") {
			for (const task of this.pending.tasks) this.cooldown(task);
			this.setPending(null);
			return;
		}
		await this.checking;
		if (!this.pending || this.pending.id !== params.id || this.applying) return;
		await this.apply(params.taskIds, false);
	}

	async tick(): Promise<void> {
		if (this.checking || this.stopped || this.applying) return;
		this.checking = this.check();
		try { await this.checking; } finally { this.checking = null; }
	}

	private setPending(suggestion: AutoHibernateSuggestion | null): void {
		if (this.pending === suggestion) return;
		this.pending = suggestion;
		this.revision++;
		this.deps.changed(this.getSuggestion());
	}

	private async candidates(): Promise<Candidate[]> {
		const policyRevision = lastAutoHibernatePolicyChange();
		const minutes = normalizeAutoHibernateMinutes(await this.deps.minutes());
		const confirmMinutes = normalizeAutoHibernateConfirmMinutes(await this.deps.confirmMinutes());
		if (policyRevision !== lastAutoHibernatePolicyChange()) {
			this.setPending(null);
			return [];
		}
		if (minutes !== this.minutes || confirmMinutes !== this.confirmMinutes || policyRevision !== this.policyRevision) {
			this.observed.clear();
			this.setPending(null);
		}
		this.minutes = minutes;
		this.confirmMinutes = confirmMinutes;
		this.policyRevision = policyRevision;
		if (!minutes) return [];
		const seen = new Set<string>();
		const candidates: Candidate[] = [];
		for (const { project, task } of await this.deps.tasks()) {
			seen.add(task.id);
			if (!canAutoHibernate(task)) { this.observed.delete(task.id); continue; }
			try {
				const now = this.deps.now();
				// Use durable real activity on startup; unknown observations reset the clock.
				const since = this.observed.get(task.id) ?? taskInactivityStateAt(task);
				this.observed.set(task.id, since);
				const outputAt = await this.deps.outputAt(task);
				if (outputAt == null || !Number.isFinite(outputAt) || outputAt <= 0) {
					this.observed.set(task.id, now);
					continue;
				}
				recordTaskActivity(task.id, outputAt);
				const lastActivityAt = Math.max(since, lastTaskActivity(task.id), taskInactivityStateAt(task));
				const snoozed = this.snoozed.get(task.id);
				if (snoozed && lastActivityAt > snoozed.activityAt) this.snoozed.delete(task.id);
				else if (snoozed && now < snoozed.until) continue;
				if (now - lastActivityAt >= minutes * 60_000) candidates.push({ project, task, lastActivityAt, timeoutMinutes: minutes });
			} catch (error) {
				this.observed.set(task.id, this.deps.now());
				this.deps.onError(error);
			}
		}
		for (const id of this.observed.keys()) if (!seen.has(id)) this.observed.delete(id);
		for (const id of this.snoozed.keys()) if (!seen.has(id)) this.snoozed.delete(id);
		return candidates;
	}

	private async check(): Promise<void> {
		try {
			const revision = this.revision;
			const candidates = await this.candidates();
			if (this.stopped || revision !== this.revision) return;
			if (this.policyRevision !== lastAutoHibernatePolicyChange()) {
				this.setPending(null);
				return;
			}
			if (this.pending) {
				const tasks = this.pending.tasks.filter(task => candidates.some(candidate =>
					candidate.task.id === task.taskId && candidate.project.id === task.projectId
					&& candidate.lastActivityAt <= task.lastActivityAt && candidate.timeoutMinutes === task.timeoutMinutes));
				if (tasks.length !== this.pending.tasks.length) this.setPending(tasks.length ? { ...this.pending, tasks } : null);
				if (this.pending && !this.pending.held && this.pending.autoConfirmAt !== null && this.deps.now() >= this.pending.autoConfirmAt) {
					await this.apply(this.pending.tasks.map(task => task.taskId), true);
				}
				return;
			}
			if (candidates.length) {
				this.pendingPolicyRevision = this.policyRevision;
				this.setPending({
					id: crypto.randomUUID(), held: false, autoConfirmAt: null,
					tasks: candidates.map(({ project, task, lastActivityAt, timeoutMinutes }) => ({
						taskId: task.id, projectId: project.id, title: task.customTitle ?? task.title,
						projectName: project.name, lastActivityAt, timeoutMinutes,
					})),
				});
			}
		} catch (error) {
			this.observed.clear();
			this.setPending(null);
			this.deps.onError(error);
		}
	}

	private cooldown(task: AutoHibernateSuggestion["tasks"][number]): void {
		this.snoozed.set(task.taskId, { until: this.deps.now() + task.timeoutMinutes * 60_000, activityAt: task.lastActivityAt });
	}

	private async apply(taskIds: string[], timed: boolean): Promise<void> {
		const pending = this.pending;
		if (!pending || this.applying || this.stopped) return;
		const consentRevision = this.pendingPolicyRevision;
		const selected = pending.tasks.filter(task => taskIds.includes(task.taskId));
		const completed = new Set<string>();
		let failed = false;
		let failure: unknown;
		this.applying = true;
		try {
			const candidates = await this.candidates();
			for (const suggestion of selected) {
				const authorized = () => !this.stopped && consentRevision === lastAutoHibernatePolicyChange()
					&& this.pending?.id === pending.id && (!timed || !this.pending.held);
				if (!authorized()) break;
				const candidate = candidates.find(item => item.task.id === suggestion.taskId && item.project.id === suggestion.projectId);
				if (candidate && autoHibernateStillIdle(candidate.task, suggestion.lastActivityAt, suggestion.timeoutMinutes,
					this.minutes, candidate.lastActivityAt, this.deps.now())) {
					await this.deps.hibernate(candidate.project, candidate.task, suggestion, timed, authorized);
					if (!authorized()) break;
					this.observed.delete(candidate.task.id);
				}
				completed.add(suggestion.taskId);
			}
		} catch (error) {
			failed = true;
			failure = error;
			this.deps.onError(error);
		} finally {
			if (this.pending?.id === pending.id && consentRevision !== lastAutoHibernatePolicyChange()) {
				this.setPending(null);
			} else if (this.pending?.id === pending.id) {
				if (!timed) for (const task of pending.tasks) if (!taskIds.includes(task.taskId)) this.cooldown(task);
				const remaining = selected.filter(task => !completed.has(task.taskId));
				this.setPending(remaining.length && (failed || (timed && this.pending.held))
					? { ...this.pending, tasks: remaining, held: true, autoConfirmAt: null } : null);
			}
			this.applying = false;
		}
		if (failed && !timed) throw failure;
	}
}
