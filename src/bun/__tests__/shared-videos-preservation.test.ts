import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Project, SharedImage, Task } from "../../shared/types";

// `sharedVideos` is additive on-disk state: every write path an older app runs
// must carry it through untouched. These exercise the real data layer on disk.
const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/shared-videos-preservation`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME, OPS_DIR: `${TEST_HOME}/ops` }));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

import { loadTasks, moveTaskToProject, updateTask, updateTaskWith } from "../data";
import { projectSlug } from "../git";

function project(id: string, path: string): Project {
	return { id, name: id, path, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z", labels: [], customColumns: [] };
}
const SOURCE = project("proj-src", "/tmp/proj-video-src");
const TARGET = project("proj-tgt", "/tmp/proj-video-tgt");

function media(id: string, mime: string, extra: Partial<SharedImage> = {}): SharedImage {
	return { id, storedPath: `/wt/shared-images/${id}`, originalPath: `/tmp/${id}`, name: id, mime, bytes: 1, createdAt: 1, ...extra };
}
const VIDEOS: SharedImage[] = [media("clip.mp4", "video/mp4", { isUnread: true, caption: "watch this" }), media("qa.webm", "video/webm")];

function tasksFile(p: Project): string {
	return `${TEST_HOME}/data/${projectSlug(p.path)}/tasks.json`;
}

function seed(p: Project, tasks: unknown[]): void {
	mkdirSync(dirname(tasksFile(p)), { recursive: true });
	writeFileSync(tasksFile(p), JSON.stringify(tasks));
}

function storedVideos(p: Project, taskId: string): string {
	const tasks = JSON.parse(readFileSync(tasksFile(p), "utf8")) as Array<Record<string, unknown>>;
	return JSON.stringify(tasks.find((t) => t.id === taskId)?.sharedVideos);
}

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
	seed(SOURCE, [{
		id: "task-v", seq: 1, projectId: SOURCE.id, title: "t", description: "t", status: "todo", priority: "P3",
		baseBranch: "main", worktreePath: null, branchName: null, groupId: null, variantIndex: null, agentId: null,
		configId: null, createdAt: "2025-02-02T00:00:00Z", updatedAt: "2025-02-02T00:00:00Z", labelIds: [],
		sharedImages: [media("shot.png", "image/png", { isUnread: true })],
		sharedVideos: VIDEOS,
	}]);
});

const BEFORE = JSON.stringify(VIDEOS);

describe("sharedVideos survives the write paths an older app runs", () => {
	it("an unrelated task update", async () => {
		await updateTask(SOURCE, "task-v", { overview: "unrelated" });
		expect(storedVideos(SOURCE, "task-v")).toBe(BEFORE);
	});

	it("the old image-only mark-read", async () => {
		await updateTaskWith(SOURCE, "task-v", (current: Task) => ({
			updates: { sharedImages: (current.sharedImages ?? []).map((image) => ({ ...image, isUnread: false })) },
			result: undefined,
		}));
		expect(storedVideos(SOURCE, "task-v")).toBe(BEFORE);
		expect((await loadTasks(SOURCE))[0].sharedImages?.[0].isUnread).toBe(false);
	});

	it("an old show-image append", async () => {
		await updateTaskWith(SOURCE, "task-v", (current: Task) => ({
			updates: { sharedImages: [...(current.sharedImages ?? []), media("new.png", "image/png")] },
			result: undefined,
		}));
		expect(storedVideos(SOURCE, "task-v")).toBe(BEFORE);
	});

	it("moving the task to another project", async () => {
		seed(TARGET, []);
		await moveTaskToProject(SOURCE, TARGET, "task-v");
		expect(storedVideos(TARGET, "task-v")).toBe(BEFORE);
	});
});
