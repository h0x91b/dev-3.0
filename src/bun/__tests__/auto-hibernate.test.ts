import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoHibernateScheduler, type AutoHibernateDependencies } from "../auto-hibernate-scheduler";
import { autoHibernateStillIdle, canAutoHibernate, normalizeAutoHibernateMinutes } from "../../shared/auto-hibernate";
import { forgetTaskActivity, recordTaskActivity } from "../task-activity";
import type { Project, Task } from "../../shared/types";

const MINUTE = 60_000;
const project = { id: "project" } as Project;
let now: number;
let minutes: number | undefined;
let task: Task;
let output: number | null;
let deps: AutoHibernateDependencies;
let scheduler: AutoHibernateScheduler;

beforeEach(() => {
	now = Date.UTC(2026, 9, 26);
	minutes = 10;
	task = { id: "task", status: "user-questions", worktreePath: "/worktree", updatedAt: new Date(now - MINUTE).toISOString() } as Task;
	output = now - MINUTE;
	deps = {
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
	it.each([undefined, null, 0, -1, NaN, Infinity, "10", 0.5, 43_201])("stays disabled for %s", async value => {
		expect(normalizeAutoHibernateMinutes(value)).toBe(0);
		minutes = value as number;
		await scheduler.tick();
		expect(deps.outputAt).not.toHaveBeenCalled();
		expect(deps.hibernate).not.toHaveBeenCalled();
	});

	it("starts a full inactivity window on first observation, then hibernates at the boundary", async () => {
		await scheduler.tick();
		now += 10 * MINUTE - 1;
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
		now++;
		await scheduler.tick();
		expect(deps.hibernate).toHaveBeenCalledWith(project, task, { lastActivityAt: now - 10 * MINUTE, timeoutMinutes: 10 });
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
		expect(deps.hibernate).toHaveBeenCalledTimes(1);
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
		await scheduler.tick();
		expect(deps.hibernate).toHaveBeenCalledTimes(1);
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

	it("starts a new window when the policy is disabled, enabled, or changed", async () => {
		await scheduler.tick();
		now += 10 * MINUTE;
		minutes = 0;
		await scheduler.tick();
		minutes = 10;
		await scheduler.tick();
		now += 10 * MINUTE;
		minutes = 5;
		await scheduler.tick();
		expect(deps.hibernate).not.toHaveBeenCalled();
		now += 5 * MINUTE;
		await scheduler.tick();
		expect(deps.hibernate).toHaveBeenCalledTimes(1);
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

	it("rechecks activity, policy and task state before a queued hibernation", () => {
		const since = now - 10 * MINUTE;
		task.updatedAt = new Date(since).toISOString();
		expect(autoHibernateStillIdle(task, since, 10, 10, since, now)).toBe(true);
		expect(autoHibernateStillIdle(task, since, 10, 10, now, now)).toBe(false);
		expect(autoHibernateStillIdle(task, since, 10, 0, since, now)).toBe(false);
		expect(autoHibernateStillIdle(task, since, 10, 20, since, now)).toBe(false);
		expect(autoHibernateStillIdle({ ...task, status: "in-progress" }, since, 10, 10, since, now)).toBe(false);
		expect(autoHibernateStillIdle({ ...task, movedAt: new Date(now).toISOString() }, since, 10, 10, since, now)).toBe(false);
	});
});
