import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Project, SharedImage, Task } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/shared-media-delete`);

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
	OPS_DIR: `${TEST_HOME}/ops`,
}));

import { deleteSharedMedia, freeableBytes, planSharedMediaDelete, previewSharedMediaDelete, SharedMediaDeleteError } from "../shared-media-delete";

const STORE = `${TEST_HOME}/worktrees/my-project/shared-images`;
const SOURCE = `${TEST_HOME}/renders`;
const project = { id: "p1", path: "/my/project" } as Project;

function clip(id: string, overrides: Partial<SharedImage> = {}): SharedImage {
	return {
		id,
		storedPath: `${STORE}/shared-${id}.mp4`,
		originalPath: `${SOURCE}/${id}.mp4`,
		name: `${id}.mp4`,
		mime: "video/mp4",
		bytes: 100,
		createdAt: 1_000,
		...overrides,
	};
}

function taskWith(media: SharedImage[], id = "t1"): Task {
	return { id, sharedVideos: media } as Task;
}

/** An in-memory board: updateTaskWith applies the mutator to the stored task like data.updateTaskWith does. */
function board(tasks: Task[]) {
	return {
		tasks,
		loadTasks: async () => tasks,
		updateTaskWith: async <T>(_project: Project, taskId: string, mutator: (task: Task) => { updates: Partial<Task>; result: T }) => {
			const idx = tasks.findIndex((t) => t.id === taskId);
			const { updates, result } = mutator(tasks[idx]);
			tasks[idx] = { ...tasks[idx], ...updates };
			return { task: tasks[idx], result };
		},
	};
}

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(STORE, { recursive: true });
	mkdirSync(SOURCE, { recursive: true });
});

afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

describe("planSharedMediaDelete", () => {
	it("refuses a record whose stored path lies outside the shared-images pool", () => {
		const outside = clip("a", { storedPath: `${TEST_HOME}/worktrees/my-project/uploads/a.mp4` });
		expect(() => planSharedMediaDelete(taskWith([outside]), [], ["a"])).toThrow(/outside the shared media pool/);
		const etc = clip("b", { storedPath: "/etc/hosts.mp4" });
		expect(() => planSharedMediaDelete(taskWith([etc]), [], ["b"])).toThrow(SharedMediaDeleteError);
	});

	it("refuses unknown ids, images, already-removed clips and an empty request", () => {
		const image = { ...clip("img"), mime: "image/png", storedPath: `${STORE}/shared-img.png` };
		const gone = clip("gone", { removedAt: 5 });
		const task = { id: "t1", sharedImages: [image], sharedVideos: [gone] } as Task;
		expect(() => planSharedMediaDelete(task, [], ["nope"])).toThrow(/not found/);
		expect(() => planSharedMediaDelete(task, [], ["img"])).toThrow(/Not a deletable clip/);
		expect(() => planSharedMediaDelete(task, [], ["gone"])).toThrow(/Not a deletable clip/);
		expect(() => planSharedMediaDelete(task, [], [])).toThrow(/No media ids/);
	});

	it("refuses a stored file another live record still points at", () => {
		const a = clip("a");
		const other = taskWith([{ ...clip("z"), storedPath: a.storedPath }], "t2");
		expect(() => planSharedMediaDelete(taskWith([a]), [other], ["a"])).toThrow(/shared with another record/);
	});
});

describe("freeableBytes", () => {
	const stat = (map: Record<string, { size: number; mtimeMs: number; dev: number }>) => (path: string) =>
		map[path] ? { ...map[path], isFile: () => true } : null;
	const item = clip("a", { createdAt: 10_000 });

	it("counts ~0 for an APFS clone of an untouched original on the same volume", () => {
		const s = stat({ [item.storedPath]: { size: 100, mtimeMs: 9_000, dev: 1 }, [item.originalPath]: { size: 100, mtimeMs: 9_000, dev: 1 } });
		expect(freeableBytes(item, s, "darwin")).toBe(0);
	});

	it("counts the full size when the original is gone, rewritten, on another volume, or not on macOS", () => {
		const stored = { size: 100, mtimeMs: 9_000, dev: 1 };
		expect(freeableBytes(item, stat({ [item.storedPath]: stored }), "darwin")).toBe(100);
		expect(freeableBytes(item, stat({ [item.storedPath]: stored, [item.originalPath]: { size: 100, mtimeMs: 60_000, dev: 1 } }), "darwin")).toBe(100);
		expect(freeableBytes(item, stat({ [item.storedPath]: stored, [item.originalPath]: { size: 100, mtimeMs: 9_000, dev: 2 } }), "darwin")).toBe(100);
		expect(freeableBytes(item, stat({ [item.storedPath]: stored, [item.originalPath]: { size: 100, mtimeMs: 9_000, dev: 1 } }), "linux")).toBe(100);
	});

	it("counts 0 when the stored file is already missing", () => {
		expect(freeableBytes(item, stat({}), "darwin")).toBe(0);
	});
});

describe("deleteSharedMedia", () => {
	it("tombstones the record and unlinks only the stored file", async () => {
		const a = clip("a");
		const keep = clip("b");
		writeFileSync(a.storedPath, "x".repeat(100));
		writeFileSync(keep.storedPath, "y".repeat(100));
		writeFileSync(a.originalPath, "x".repeat(50)); // rewritten after the show: no clone
		const b = board([taskWith([a, keep])]);

		const { task, summary } = await deleteSharedMedia(project, "t1", ["a"], { ...b, now: () => 42 });

		expect(existsSync(a.storedPath)).toBe(false);
		expect(existsSync(keep.storedPath)).toBe(true);
		expect(existsSync(a.originalPath)).toBe(true);
		expect(existsSync(STORE)).toBe(true);
		const removed = task.sharedVideos?.find((item) => item.id === "a");
		expect(removed).toMatchObject({ removedAt: 42, storedPath: a.storedPath, name: "a.mp4" });
		expect(task.sharedVideos?.find((item) => item.id === "b")?.removedAt).toBeUndefined();
		expect(summary).toMatchObject({ count: 1, bytes: 100, failed: [] });
	});

	it("revives the record when the unlink fails, so the user can retry", async () => {
		const a = clip("a");
		writeFileSync(a.storedPath, "x");
		const b = board([taskWith([a])]);
		const { task, summary } = await deleteSharedMedia(project, "t1", ["a"], {
			...b,
			unlink: () => { throw new Error("EBUSY: resource busy"); },
		});
		expect(summary.count).toBe(0);
		expect(summary.failed).toEqual([{ id: "a", reason: "EBUSY: resource busy" }]);
		expect(task.sharedVideos?.[0].removedAt).toBeUndefined();
		expect(existsSync(a.storedPath)).toBe(true);
	});

	it("succeeds when the stored file is already gone", async () => {
		const b = board([taskWith([clip("a")])]);
		const { summary } = await deleteSharedMedia(project, "t1", ["a"], b);
		expect(summary).toMatchObject({ count: 1, freeableBytes: 0 });
	});

	it("touches nothing when a requested id is refused", async () => {
		const a = clip("a");
		writeFileSync(a.storedPath, "x");
		const outside = clip("o", { storedPath: `${TEST_HOME}/elsewhere.mp4` });
		writeFileSync(outside.storedPath, "x");
		const b = board([taskWith([a, outside])]);
		await expect(deleteSharedMedia(project, "t1", ["a", "o"], b)).rejects.toThrow(/outside the shared media pool/);
		expect(existsSync(a.storedPath)).toBe(true);
		expect(existsSync(outside.storedPath)).toBe(true);
		expect(b.tasks[0].sharedVideos?.every((item) => !item.removedAt)).toBe(true);
	});
});

describe("previewSharedMediaDelete", () => {
	it("reports sizes without deleting anything", async () => {
		const a = clip("a");
		writeFileSync(a.storedPath, "x".repeat(100));
		const summary = await previewSharedMediaDelete(project, "t1", ["a"], async () => [taskWith([a])]);
		expect(summary).toMatchObject({ count: 1, bytes: 100, freeableBytes: 100 });
		expect(existsSync(a.storedPath)).toBe(true);
	});
});
