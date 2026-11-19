import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoHibernateScheduler, type AutoHibernateDependencies } from "../auto-hibernate-scheduler";
import { autoHibernateStillIdle, canAutoHibernate, normalizeAutoHibernateMinutes } from "../../shared/auto-hibernate";
import { forgetTaskActivity, lastTaskActivity, recordAutoHibernatePolicyChange, recordTaskActivity } from "../task-activity";
import type { Project, Task } from "../../shared/types";

const MINUTE = 60_000;
const project = { id: "project" } as Project;
let now: number;
let minutes: number | undefined;
let task: Task;
let output: number | null;
let deps: AutoHibernateDependencies;
let scheduler: AutoHibernateScheduler;
let changed: AutoHibernateDependencies["changed"];

beforeEach(() => {
	now = Date.UTC(2026, 9, 26);
	minutes = 10;
	task = { id: "task", title: "Idle task", createdAt: new Date(now - MINUTE).toISOString(), status: "user-questions", worktreePath: "/worktree", updatedAt: new Date(now - MINUTE).toISOString() } as Task;
	output = now - MINUTE;
	changed = vi.fn();
	deps = {
		confirmMinutes: async () => 30,
		changed,
		minutes: async () => minutes,
		tasks: async () => [{ project, task }],
		outputAt: vi.fn(async () => output),
		hibernate: vi.fn(async () => {}),
		onError: vi.fn(), now: () => now,
	};
	scheduler = new AutoHibernateScheduler(deps);
});

afterEach(() => { forgetTaskActivity("task"); });

describe("automatic hibernation", () => {
	it.each([null, 0, -1, NaN, Infinity, "10", 0.5, 43_201])("stays disabled for %s", async value => {
		expect(normalizeAutoHibernateMinutes(value)).toBe(0);
		minutes = value as number;
		await scheduler.tick();
		expect(deps.outputAt).not.toHaveBeenCalled();
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("suggests at the inactivity boundary, without unattended teardown", async () => {
		await scheduler.tick();
		now += 9 * MINUTE - 1;
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
		now++;
		await scheduler.tick();
		expect(scheduler.getSuggestion()?.tasks).toHaveLength(1);
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("resets for human input or an agent hook even when the column did not change", async () => {
		await scheduler.tick();
		now += 9 * MINUTE;
		recordTaskActivity(task.id, now);
		now += 9 * MINUTE;
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
		now += MINUTE;
		await scheduler.tick();
		expect(scheduler.getSuggestion()?.tasks).toHaveLength(1);
	});

	it("uses terminal output and lifecycle changes as activity", async () => {
		await scheduler.tick();
		now += 10 * MINUTE;
		output = now;
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
		now += 10 * MINUTE;
		task.movedAt = new Date(now).toISOString();
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("does not let background metadata refreshes keep an inactive task awake", async () => {
		await scheduler.tick();
		now += 10 * MINUTE;
		task.updatedAt = new Date(now).toISOString();
		task.runtimeState = { runtime: "running", updatedAt: now };
		await scheduler.tick();
		expect(scheduler.getSuggestion()?.tasks).toHaveLength(1);
	});

	it.each([null, NaN, 0])("never treats an unreadable output time (%s) as idle", async value => {
		await scheduler.tick();
		now += 10 * MINUTE;
		output = value;
		await scheduler.tick();
		output = now - MINUTE;
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("clears an existing suggestion when the policy is disabled", async () => {
		now += 10 * MINUTE;
		await scheduler.tick();
		expect(scheduler.getSuggestion()).not.toBeNull();
		minutes = 0;
		await scheduler.tick();
		expect(scheduler.getSuggestion()).toBeNull();
	});

	it.each<Partial<Task>>([
		{ status: "in-progress" }, { status: "review-by-ai" }, { status: "todo" }, { status: "completed" },
		{ status: "cancelled" }, { hibernated: true }, { draft: true }, { preparing: true },
		{ runtimeState: { runtime: "tearing-down", updatedAt: 1 } },
		{ runtimeState: { runtime: "idle", updatedAt: 1 } }, { worktreePath: null },
		{ keepAlive: { enabled: true } }, { customColumnId: "custom" },
	])("protects tasks with %j", async patch => {
		Object.assign(task, patch);
		expect(canAutoHibernate(task)).toBe(false);
		await scheduler.tick();
		now += 20 * MINUTE;
		await scheduler.tick();
		expect(deps.outputAt).not.toHaveBeenCalled();
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("does not inherit the old idle clock after working and returning to waiting", async () => {
		await scheduler.tick();
		task.status = "in-progress";
		now += 10 * MINUTE;
		await scheduler.tick();
		task.status = "review-by-user";
		task.movedAt = new Date(now).toISOString();
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("recovers from a failed probe without hibernating or retrying immediately", async () => {
		await scheduler.tick();
		now += 10 * MINUTE;
		vi.mocked(deps.outputAt).mockRejectedValueOnce(new Error("unreadable"));
		await scheduler.tick();
		await scheduler.tick();
		expect(deps.onError).toHaveBeenCalledTimes(1);
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("does not overlap ticks", async () => {
		let resolve!: (value: number) => void;
		deps.minutes = vi.fn(() => new Promise<number>(done => { resolve = done; }));
		const tick = scheduler.tick();
		await scheduler.tick();
		expect(deps.minutes).toHaveBeenCalledTimes(1);
		resolve(0);
		await tick;
	});

	it("cancels an in-flight check on shutdown", async () => {
		await scheduler.tick();
		now += 10 * MINUTE;
		deps.outputAt = async () => { scheduler.stop(); return output; };
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("enables suggestions by default after a day of real inactivity", async () => {
		minutes = undefined;
		now += 1440 * MINUTE;
		await scheduler.tick();
		expect(normalizeAutoHibernateMinutes(undefined)).toBe(1440);
		expect(scheduler.getSuggestion()?.tasks[0].timeoutMinutes).toBe(1440);
		expect(scheduler.getSuggestion()?.autoConfirmAt).toBeNull();
	});

	it("groups idle tasks and starts the timer only after presentation acknowledgement", async () => {
		deps.tasks = async () => [{ project, task }, { project, task: { ...task, id: "other-task" } }];
		now += 10 * MINUTE;
		await scheduler.tick();
		const suggestion = scheduler.getSuggestion()!;
		expect(suggestion.tasks).toHaveLength(2);
		now += 60 * MINUTE;
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
		await scheduler.present("stale-id");
		expect(scheduler.getSuggestion()?.autoConfirmAt).toBeNull();
		await scheduler.present(suggestion.id);
		expect(scheduler.getSuggestion()?.autoConfirmAt).toBe(now + 30 * MINUTE);
		now += 30 * MINUTE;
		await scheduler.tick();
		expect(deps.hibernate).toHaveBeenCalledTimes(2);
		expect(vi.mocked(deps.hibernate).mock.calls[0][3]).toBe(true);
		expect(scheduler.getSuggestion()).toBeNull();
		forgetTaskActivity("other-task");
	});

	it("uses the configured confirmation delay and ignores repeated presentation", async () => {
		deps.confirmMinutes = async () => 7;
		now += 10 * MINUTE;
		await scheduler.tick();
		const id = scheduler.getSuggestion()!.id;
		await scheduler.present(id);
		const deadline = scheduler.getSuggestion()!.autoConfirmAt;
		now += MINUTE;
		await scheduler.present(id);
		expect(deadline).toBe(now + 6 * MINUTE);
		expect(scheduler.getSuggestion()!.autoConfirmAt).toBe(deadline);
	});

	it("interaction holds the countdown permanently and accepts only selected tasks", async () => {
		deps.tasks = async () => [{ project, task }, { project, task: { ...task, id: "other-task" } }];
		now += 10 * MINUTE;
		await scheduler.tick();
		const id = scheduler.getSuggestion()!.id;
		await scheduler.present(id);
		await scheduler.respond({ id, action: "hold", taskIds: [task.id] });
		now += 60 * MINUTE;
		await scheduler.present(id);
		await scheduler.tick();
		expect(scheduler.getSuggestion()).toMatchObject({ held: true, autoConfirmAt: null });
		expect(deps.hibernate).not.toHaveBeenCalled();
		await scheduler.respond({ id, action: "hibernate", taskIds: [task.id] });
		expect(deps.hibernate).toHaveBeenCalledTimes(1);
		expect(vi.mocked(deps.hibernate).mock.calls[0][1].id).toBe(task.id);
		expect(vi.mocked(deps.hibernate).mock.calls[0][3]).toBe(false);
		forgetTaskActivity("other-task");
	});

	it("not now suppresses the whole group for another inactivity threshold", async () => {
		now += 10 * MINUTE;
		await scheduler.tick();
		const activityAt = lastTaskActivity(task.id);
		await scheduler.respond({ id: scheduler.getSuggestion()!.id, action: "snooze", taskIds: [] });
		expect(lastTaskActivity(task.id)).toBe(activityAt);
		now += 10 * MINUTE - 1;
		await scheduler.tick();
		expect(scheduler.getSuggestion()).toBeNull();
		now++;
		await scheduler.tick();
		expect(scheduler.getSuggestion()?.tasks[0].lastActivityAt).toBe(activityAt);
	});

	it.each(["activity", "move", "working", "extra-pane"])("removes a pending task after %s before automatic confirmation", async change => {
		now += 10 * MINUTE;
		await scheduler.tick();
		await scheduler.present(scheduler.getSuggestion()!.id);
		now += MINUTE;
		if (change === "activity") recordTaskActivity(task.id, now);
		if (change === "move") task.movedAt = new Date(now).toISOString();
		if (change === "working") task.status = "in-progress";
		if (change === "extra-pane") output = null;
		await scheduler.tick();
		expect(scheduler.getSuggestion()).toBeNull();
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("retains failed and unattempted selected tasks for explicit retry after partial success", async () => {
		const tasks = [task, { ...task, id: "second" }, { ...task, id: "third" }, { ...task, id: "unselected" }];
		deps.tasks = async () => tasks.map(task => ({ project, task }));
		vi.mocked(deps.hibernate).mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("terminal teardown failed"));
		now += 10 * MINUTE;
		await scheduler.tick();
		const id = scheduler.getSuggestion()!.id;
		await expect(scheduler.respond({ id, action: "hibernate", taskIds: [task.id, "second", "third"] })).rejects.toThrow("terminal teardown failed");
		expect(deps.hibernate).toHaveBeenCalledTimes(2);
		expect(scheduler.getSuggestion()).toMatchObject({ id, held: true, autoConfirmAt: null });
		expect(scheduler.getSuggestion()?.tasks.map(task => task.taskId)).toEqual(["second", "third"]);
		await scheduler.tick();
		expect(scheduler.getSuggestion()?.tasks.map(task => task.taskId)).toEqual(["second", "third"]);
		await scheduler.respond({ id, action: "hibernate", taskIds: ["second", "third"] });
		expect(deps.hibernate).toHaveBeenCalledTimes(4);
		expect(scheduler.getSuggestion()).toBeNull();
		for (const task of tasks) forgetTaskActivity(task.id);
	});

	it("holds a timed failure for review instead of snoozing it or retrying automatically", async () => {
		vi.mocked(deps.hibernate).mockRejectedValueOnce(new Error("hibernation failed"));
		now += 10 * MINUTE;
		await scheduler.tick();
		const id = scheduler.getSuggestion()!.id;
		await scheduler.present(id);
		now += 30 * MINUTE;
		await scheduler.tick();
		expect(deps.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "hibernation failed" }));
		expect(scheduler.getSuggestion()).toMatchObject({ id, held: true, autoConfirmAt: null });
		now += 30 * MINUTE;
		await scheduler.tick();
		expect(deps.hibernate).toHaveBeenCalledTimes(1);
		await scheduler.respond({ id, action: "hibernate", taskIds: [task.id] });
		expect(deps.hibernate).toHaveBeenCalledTimes(2);
		expect(scheduler.getSuggestion()).toBeNull();
	});

	it("requires a new presentation after only the confirmation delay changes", async () => {
		let delay = 30;
		deps.confirmMinutes = async () => delay;
		now += 10 * MINUTE;
		await scheduler.tick();
		const old = scheduler.getSuggestion()!;
		await scheduler.present(old.id);
		now += 29 * MINUTE;
		delay = 120;
		recordAutoHibernatePolicyChange();
		await scheduler.tick();
		expect(scheduler.getSuggestion()).toBeNull();
		await scheduler.tick();
		const replacement = scheduler.getSuggestion()!;
		expect(replacement.id).not.toBe(old.id);
		expect(replacement.autoConfirmAt).toBeNull();
		expect(replacement.tasks[0].lastActivityAt).toBe(old.tasks[0].lastActivityAt);
		now += MINUTE;
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
		await scheduler.present(replacement.id);
		expect(scheduler.getSuggestion()?.autoConfirmAt).toBe(now + 120 * MINUTE);
	});

	it("revokes actor authorization when policy changes during a fresh probe", async () => {
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		let authorization = true;
		deps.hibernate = vi.fn(async (_project, _task, _inactivity, _timed, authorized) => {
			entered();
			await new Promise<void>(resolve => { release = resolve; });
			authorization = authorized();
		});
		now += 10 * MINUTE;
		await scheduler.tick();
		await scheduler.present(scheduler.getSuggestion()!.id);
		now += 30 * MINUTE;
		const tick = scheduler.tick();
		await started;
		recordAutoHibernatePolicyChange();
		release();
		await tick;
		expect(authorization).toBe(false);
	});

	it("cancels a countdown synchronously while the actor guard is in flight", async () => {
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		let authorization = true;
		deps.hibernate = vi.fn(async (_project, _task, _inactivity, _timed, authorized) => {
			entered();
			await new Promise<void>(resolve => { release = resolve; });
			authorization = authorized();
		});
		now += 10 * MINUTE;
		await scheduler.tick();
		const id = scheduler.getSuggestion()!.id;
		await scheduler.present(id);
		now += 30 * MINUTE;
		const tick = scheduler.tick();
		await started;
		await scheduler.respond({ id, action: "hold", taskIds: [] });
		release();
		await tick;
		expect(authorization).toBe(false);
		expect(scheduler.getSuggestion()?.held).toBe(true);
	});

	it("rechecks activity, policy and task state before a queued hibernation", () => {
		const since = now - 10 * MINUTE;
		task.createdAt = new Date(since).toISOString();
		task.updatedAt = new Date(since).toISOString();
		expect(autoHibernateStillIdle(task, since, 10, 10, since, now)).toBe(true);
		expect(autoHibernateStillIdle(task, since, 10, 10, now, now)).toBe(false);
		expect(autoHibernateStillIdle(task, since, 10, 0, since, now)).toBe(false);
		expect(autoHibernateStillIdle(task, since, 10, 20, since, now)).toBe(false);
		expect(autoHibernateStillIdle({ ...task, status: "in-progress" }, since, 10, 10, since, now)).toBe(false);
		expect(autoHibernateStillIdle({ ...task, movedAt: new Date(now).toISOString() }, since, 10, 10, since, now)).toBe(false);
	});
});
