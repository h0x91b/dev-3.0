import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Project, SharedImage, Task } from "../../shared/types";
import { dueSharedMediaIds, LARGE_SHARED_MEDIA_BYTES, olderLargeSharedClips, sharedMediaRetention } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/shared-media-retention`);

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
}));

import { runSharedMediaRetention, tombstonePrunedClips } from "../shared-media-retention";

const DAY = 24 * 60 * 60 * 1000;
const CLOSED_AT = Date.parse("2026-11-01T00:00:00.000Z");
const LARGE = LARGE_SHARED_MEDIA_BYTES;
const STORE = `${TEST_HOME}/worktrees/my-project/shared-images`;

/** `n` large clips shown just before the close; index 0 is the oldest, so the newest has the highest index. */
function clips(n: number, overrides: (i: number) => Partial<SharedImage> = () => ({})): SharedImage[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `c${i}`,
		storedPath: `${STORE}/shared-${i}.mp4`,
		originalPath: `/renders/${i}.mp4`,
		name: `${i}.mp4`,
		mime: "video/mp4",
		bytes: LARGE,
		createdAt: CLOSED_AT - DAY + i * 1000,
		...overrides(i),
	}));
}

function closedTask(media: SharedImage[], status: Task["status"] = "completed", id = "t1"): Task {
	return { id, status, movedAt: new Date(CLOSED_AT).toISOString(), updatedAt: new Date(CLOSED_AT).toISOString(), sharedVideos: media } as Task;
}

const due = (task: Task, at: number) => dueSharedMediaIds(task, at).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

describe("sharedMediaRetention tiers", () => {
	const task = closedTask(clips(20));

	it("keeps the newest 15 large clips in the first week, removing the rest at the close", () => {
		expect(due(task, CLOSED_AT - 1)).toEqual([]);
		expect(due(task, CLOSED_AT)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
		expect(due(task, CLOSED_AT + 7 * DAY - 1)).toHaveLength(5);
	});

	it("keeps the newest 3 from day 7", () => {
		expect(due(task, CLOSED_AT + 7 * DAY)).toEqual(Array.from({ length: 17 }, (_, i) => `c${i}`));
		expect(due(task, CLOSED_AT + 30 * DAY - 1)).toHaveLength(17);
	});

	it("keeps only the newest one from day 30, until the 60-day age rule takes it too", () => {
		expect(due(task, CLOSED_AT + 30 * DAY)).toHaveLength(19);
		expect(due(task, CLOSED_AT + 30 * DAY)).not.toContain("c19");
		const newest = sharedMediaRetention(task).find((v) => v.id === "c19");
		expect(newest).toEqual({ id: "c19", removesAt: task.sharedVideos![19].createdAt + 60 * DAY, reason: "age" });
		expect(due(task, newest!.removesAt!)).toHaveLength(20);
	});

	it("lets the 60-day age rule win when it comes before the tier", () => {
		const old = closedTask(clips(2, (i) => ({ createdAt: CLOSED_AT - 50 * DAY + i })));
		// c0 (rank 1) would go at day 30 by tier, but its 60 days since the show end at day 10.
		expect(sharedMediaRetention(old)[0]).toEqual({ id: "c0", removesAt: CLOSED_AT + 10 * DAY, reason: "age" });
	});

	it("applies to cancelled tasks too", () => {
		expect(due(closedTask(clips(16), "cancelled"), CLOSED_AT)).toEqual(["c0"]);
	});
});

describe("sharedMediaRetention rollout grace", () => {
	// The machine's first retention run happens 10 days after this task closed.
	const START = CLOSED_AT + 10 * DAY;
	const task = closedTask(clips(20));

	it("removes nothing for a week after the first run from a task closed before it", () => {
		// Without the grace, the first run would cut this task straight to 3.
		expect(dueSharedMediaIds(task, START)).toHaveLength(17);
		expect(due(task, START)).toEqual([]);
		expect(due(task, START + 7 * DAY - 1)).toEqual([]);
	});

	it("then runs the tiers from the first run, not from the old close", () => {
		// Day 7 of the restarted clock keeps 3 (the old close would already be past day 7 at START).
		expect(due(task, START + 7 * DAY)).toHaveLength(17);
		expect(due(task, START + 30 * DAY - 1)).toHaveLength(17);
		expect(due(task, START + 30 * DAY)).toHaveLength(19);
		expect(dueSharedMediaIds(task, START + 7 * DAY, START)).not.toContain("c19");
		expect(dueSharedMediaIds(task, START + 7 * DAY, START)).not.toContain("c17");
	});

	it("leaves tasks closed after the first run on their own clock", () => {
		const later = { ...task, movedAt: new Date(START + DAY).toISOString() } as Task;
		expect(dueSharedMediaIds(later, START + DAY, START)).toHaveLength(5);
	});

	function due(t: Task, at: number) {
		return dueSharedMediaIds(t, at, START);
	}
});

describe("sharedMediaRetention exemptions", () => {
	it("never touches an open task, whatever its age", () => {
		for (const status of ["in-progress", "review-by-user", "todo"] as Task["status"][]) {
			const task = closedTask(clips(20), status);
			expect(due(task, CLOSED_AT + 365 * DAY)).toEqual([]);
			expect(sharedMediaRetention(task).every((v) => v.removesAt === null && v.reason === "open-task")).toBe(true);
		}
	});

	it("counts nothing under 15 MB and never removes it", () => {
		const task = closedTask(clips(17, (i) => (i < 2 ? { bytes: LARGE - 1 } : {})));
		// 15 large clips remain, so the first week keeps all of them.
		expect(due(task, CLOSED_AT)).toEqual([]);
		expect(due(task, CLOSED_AT + 365 * DAY)).not.toContain("c0");
		expect(sharedMediaRetention(task)[0]).toEqual({ id: "c0", removesAt: null, reason: "small" });
		expect(due(closedTask(clips(16, (i) => (i === 0 ? { bytes: LARGE } : {}))), CLOSED_AT)).toEqual(["c0"]);
	});

	it("treats an unknown size as small", () => {
		const task = closedTask(clips(2, (i) => (i === 0 ? { bytes: undefined as unknown as number } : {})));
		expect(sharedMediaRetention(task)[0]).toEqual({ id: "c0", removesAt: null, reason: "small" });
		expect(due(task, CLOSED_AT + 365 * DAY)).toEqual(["c1"]);
	});

	it("never removes a pinned item, and a pin does not take a keep slot", () => {
		const task = closedTask(clips(5, (i) => (i === 4 || i === 0 ? { pinnedAt: 1 } : {})));
		expect(due(task, CLOSED_AT + 365 * DAY)).toEqual(["c1", "c2", "c3"]);
		// At day 30 the newest UNPINNED clip (c3) is the one kept.
		expect(due(task, CLOSED_AT + 30 * DAY)).toEqual(["c1", "c2"]);
		expect(sharedMediaRetention(task).find((v) => v.id === "c4")).toEqual({ id: "c4", removesAt: null, reason: "pinned" });
	});

	it("keeps pinned clips out of the manual older-clips sweep too", () => {
		const media = clips(4, (i) => (i === 3 || i === 1 ? { pinnedAt: 1 } : {}));
		// c3 is pinned, so c2 is the newest unpinned and stays; only c0 goes.
		expect(olderLargeSharedClips(media).map((item) => item.id)).toEqual(["c0"]);
	});

	it("skips tombstones and images", () => {
		const image = { ...clips(1)[0], id: "img", mime: "image/png", storedPath: `${STORE}/shot.png` };
		const task = { ...closedTask(clips(17, (i) => (i === 0 ? { removedAt: 5 } : {}))), sharedImages: [image] } as Task;
		const ids = dueSharedMediaIds(task, CLOSED_AT + 365 * DAY);
		expect(ids).not.toContain("c0");
		expect(ids).not.toContain("img");
	});
});

describe("runSharedMediaRetention", () => {
	const project = { id: "p1", path: "/my/project" } as Project;

	beforeEach(() => {
		rmSync(TEST_HOME, { recursive: true, force: true });
		mkdirSync(STORE, { recursive: true });
	});
	afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

	function board(tasks: Task[]) {
		const updated: string[] = [];
		return {
			tasks,
			updated,
			loadProjects: async () => [project],
			loadTasks: async () => tasks,
			updateTaskWith: async <T>(_p: Project, taskId: string, mutator: (task: Task, all?: readonly Task[]) => { updates: Partial<Task>; result: T }) => {
				const idx = tasks.findIndex((t) => t.id === taskId);
				const { updates, result } = mutator(tasks[idx], tasks);
				tasks[idx] = { ...tasks[idx], ...updates };
				return { task: tasks[idx], result };
			},
			onTaskUpdated: (_p: Project, task: Task) => updated.push(task.id),
		};
	}

	it("deletes what is due on closed tasks as tombstones and leaves open tasks alone", async () => {
		const closed = closedTask(clips(17), "completed", "closed");
		const open = closedTask(clips(17, (i) => ({ id: `o${i}`, storedPath: `${STORE}/open-${i}.mp4` })), "in-progress", "open");
		for (const item of [...closed.sharedVideos!, ...open.sharedVideos!]) writeFileSync(item.storedPath, "x");
		const b = board([closed, open]);

		const result = await runSharedMediaRetention({ ...b, now: () => CLOSED_AT + DAY });

		expect(result).toMatchObject({ removed: 2, failed: 0 });
		expect(existsSync(closed.sharedVideos![0].storedPath)).toBe(false);
		expect(existsSync(closed.sharedVideos![1].storedPath)).toBe(false);
		expect(existsSync(closed.sharedVideos![2].storedPath)).toBe(true);
		expect(open.sharedVideos!.every((item) => existsSync(item.storedPath))).toBe(true);
		expect(b.tasks[0].sharedVideos!.slice(0, 2).every((item) => item.removedAt === CLOSED_AT + DAY)).toBe(true);
		expect(b.tasks[1].sharedVideos!.every((item) => !item.removedAt)).toBe(true);
		expect(b.updated).toEqual(["closed"]);
	});

	it("still removes the rest when one due record is refused", async () => {
		const media = clips(17, (i) => (i === 0 ? { storedPath: `${TEST_HOME}/outside.mp4` } : {}));
		for (const item of media) writeFileSync(item.storedPath, "x");
		const b = board([closedTask(media)]);
		const result = await runSharedMediaRetention({ ...b, now: () => CLOSED_AT + DAY });
		// A refusal is a skip, not a failure: it would otherwise recount every day.
		expect(result).toMatchObject({ removed: 1, skipped: 1, failed: 0 });
		expect(existsSync(`${TEST_HOME}/outside.mp4`)).toBe(true);
		expect(existsSync(media[1].storedPath)).toBe(false);
	});

	it("re-decides under the lock: a task reopened or a clip pinned after the snapshot loses nothing", async () => {
		const snapshot = [closedTask(clips(17), "completed", "reopened"), closedTask(clips(17, (i) => ({ id: `p${i}`, storedPath: `${STORE}/pin-${i}.mp4` })), "completed", "pinned")];
		for (const task of snapshot) for (const item of task.sharedVideos!) writeFileSync(item.storedPath, "x");
		// What the lock sees: the first task was reopened, every clip of the second was pinned.
		const locked = [
			{ ...snapshot[0], status: "in-progress" },
			{ ...snapshot[1], sharedVideos: snapshot[1].sharedVideos!.map((item) => ({ ...item, pinnedAt: 1 })) },
		] as Task[];
		const b = board(locked);
		const result = await runSharedMediaRetention({ ...b, loadTasks: async () => snapshot, now: () => CLOSED_AT + DAY });
		expect(result).toMatchObject({ removed: 0, failed: 0 });
		for (const task of snapshot) expect(task.sharedVideos!.every((item) => existsSync(item.storedPath))).toBe(true);
		expect(locked.flatMap((task) => task.sharedVideos!).every((item) => !item.removedAt)).toBe(true);
	});
});

describe("tombstonePrunedClips", () => {
	it("tombstones only clips whose file the prune reported unlinking, never a merely missing one", async () => {
		const tasks = [closedTask(clips(3), "completed", "closed")];
		const project = { id: "p1" } as Project;
		const media = tasks[0].sharedVideos!;
		const count = await tombstonePrunedClips(
			{
				now: () => 77,
				// Nothing exists: c1 and c2 look missing (say, an unmounted volume), but only c0 was pruned.
				exists: (_path: string) => false,
				loadProjects: async () => [project],
				loadTasks: async () => tasks,
				updateTaskWith: async <T>(_p: Project, taskId: string, mutator: (task: Task, all?: readonly Task[]) => { updates: Partial<Task>; result: T }) => {
					const idx = tasks.findIndex((t) => t.id === taskId);
					const { updates, result } = mutator(tasks[idx], tasks);
					tasks[idx] = { ...tasks[idx], ...updates };
					return { task: tasks[idx], result };
				},
			},
			[media[0].storedPath],
		);
		expect(count).toBe(1);
		expect(tasks[0].sharedVideos!.map((item) => item.removedAt)).toEqual([77, undefined, undefined]);
	});

	it("leaves a reported path alone when the file is back on disk", async () => {
		const tasks = [closedTask(clips(1))];
		const count = await tombstonePrunedClips(
			{
				now: () => 1,
				exists: () => true,
				loadProjects: async () => [{ id: "p1" } as Project],
				loadTasks: async () => tasks,
				updateTaskWith: async () => { throw new Error("must not write"); },
			},
			[tasks[0].sharedVideos![0].storedPath],
		);
		expect(count).toBe(0);
	});
});
