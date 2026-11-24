import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SharedArtifact, SharedImage, Task } from "../../shared/types";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("../data", () => ({ loadProjects: vi.fn(), loadVirtualProjects: vi.fn(), loadTasks: vi.fn() }));
vi.mock("../rpc-handlers/shared", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { existsSync } from "node:fs";
import * as data from "../data";
import { getLibrary } from "../rpc-handlers/library";
import {
	artifactRecordBytes,
	filterLibraryItems,
	libraryDayBucket,
	libraryDiskGroups,
	libraryViewerSiblings,
	sortLibraryItems,
	summarizeLibrary,
	taskLibraryItems,
	type LibraryItem,
} from "../../shared/library";

const mockData = data as unknown as Record<"loadProjects" | "loadVirtualProjects" | "loadTasks", ReturnType<typeof vi.fn>>;
const mockExists = existsSync as unknown as ReturnType<typeof vi.fn>;

const project = { id: "p1", name: "video-edit", path: "/repo" } as Project;

function media(over: Partial<SharedImage>): SharedImage {
	return { id: "m1", storedPath: "/pool/m1.png", originalPath: "/tmp/m1.png", name: "m1.png", mime: "image/png", bytes: 100, createdAt: 1000, ...over };
}

function artifact(over: Partial<SharedArtifact>): SharedArtifact {
	return { id: "a1", kind: "html", title: "Audit", name: "index.html", storedPath: "/pool/a1/index.html", originalPath: "/r/index.html", bytes: 10, createdAt: 2000, assets: [], ...over };
}

function task(over: Partial<Task>): Task {
	return { id: "t1", seq: 7, title: "Render promo", description: "", status: "completed", agentId: "claude", ...over } as Task;
}

describe("taskLibraryItems", () => {
	it("projects images, clips and artifacts with kind, provenance and title fallback", () => {
		const items = taskLibraryItems(project, task({
			sharedImages: [media({ id: "i1", caption: "Before shot" })],
			sharedVideos: [media({ id: "v1", mime: "video/mp4", name: "cut.mp4", bytes: 300 })],
			sharedAudio: [media({ id: "s1", mime: "audio/mpeg", name: "vo.mp3", isUnread: true })],
			sharedArtifacts: [artifact({})],
		}));
		expect(items.map((i) => [i.kind, i.title, i.unread])).toEqual([
			["image", "Before shot", false],
			["video", "cut.mp4", false],
			["audio", "vo.mp3", true],
			["report", "Audit", false],
		]);
		expect(items[0]).toMatchObject({ projectId: "p1", projectName: "video-edit", taskId: "t1", taskSeq: 7, taskStatus: "completed", agentId: "claude", key: "p1:t1:i1" });
	});

	it("counts every retained artifact version and its assets toward the bytes", () => {
		const asset = { name: "a.png", storedPath: "/x", originalPath: "/y", mime: "image/png", bytes: 5 };
		const record = artifact({
			version: 3,
			bytes: 10,
			assets: [asset],
			previousVersions: [{ version: 2, name: "index.html", storedPath: "/p2", originalPath: "/o", bytes: 7, createdAt: 1, assets: [asset] }],
		});
		expect(artifactRecordBytes(record)).toBe(10 + 5 + 7 + 5);
		expect(taskLibraryItems(project, task({ sharedArtifacts: [record] }))[0]).toMatchObject({ versions: 3, bytes: 27 });
	});

	it("lists a live artifact as a report marked live", () => {
		const live = { page: artifact({ id: "page", title: "Live board" }), pageRev: 2, createdAt: 1, updatedAt: 5000 };
		const [item] = taskLibraryItems(project, task({ liveArtifact: live }));
		expect(item).toMatchObject({ kind: "report", live: true, title: "Live board", createdAt: 5000, liveArtifact: live });
	});
});

describe("getLibrary", () => {
	beforeEach(() => {
		mockData.loadProjects.mockResolvedValue([project]);
		mockData.loadVirtualProjects.mockResolvedValue([{ id: "ops", name: "Operations", path: "" } as Project]);
		mockExists.mockReset();
		mockExists.mockReturnValue(true);
	});

	it("walks every project and task status, and flags records whose file is gone", async () => {
		mockData.loadTasks.mockImplementation(async (p: Project) =>
			p.id === "p1"
				? [task({ status: "in-progress", sharedImages: [media({ id: "gone", storedPath: "/pool/gone.png" })] }), task({ id: "t2", sharedArtifacts: [artifact({})] })]
				: [task({ id: "t3", sharedVideos: [media({ id: "v", mime: "video/mp4" })] })],
		);
		mockExists.mockImplementation((path: string) => path !== "/pool/gone.png");
		const report = await getLibrary();
		expect(report.items.map((i) => [i.projectId, i.taskId, i.missing])).toEqual([
			["p1", "t1", true],
			["p1", "t2", false],
			["ops", "t3", false],
		]);
	});

	it("skips a project whose tasks fail to load instead of failing the whole library", async () => {
		mockData.loadTasks.mockImplementation(async (p: Project) => {
			if (p.id === "p1") throw new Error("corrupt");
			return [task({ id: "t3", sharedImages: [media({})] })];
		});
		const report = await getLibrary();
		expect(report.items.map((i) => i.projectId)).toEqual(["ops"]);
	});
});

function item(over: Partial<LibraryItem>): LibraryItem {
	return {
		key: over.key ?? `k-${Math.random()}`, kind: "image", projectId: "p1", projectName: "dev-3.0", taskId: "t1", taskSeq: 1, taskTitle: "Fix login",
		taskStatus: "completed", agentId: "claude", title: "Shot", name: "shot.png", createdAt: 0, bytes: 0, versions: 1, unread: false,
		missing: false, live: false, order: 0, ...over,
	};
}

describe("library renderer helpers", () => {
	const items = [
		item({ key: "a", kind: "report", title: "Race audit", bytes: 50, createdAt: 30, unread: true, order: 1 }),
		item({ key: "b", kind: "video", title: "Promo cut", caption: "final mix", bytes: 900, createdAt: 10, projectId: "p2", projectName: "video-edit", taskId: "t9" }),
		item({ key: "c", kind: "report", title: "Old audit", bytes: 5, createdAt: 20, order: 0 }),
	];
	const all = { query: "", kind: "all" as const, projectId: null, unseenOnly: false };

	it("searches every term across title, caption, task, project, agent and #seq", () => {
		expect(filterLibraryItems(items, { ...all, query: "audit" }).map((i) => i.key)).toEqual(["a", "c"]);
		expect(filterLibraryItems(items, { ...all, query: "FINAL video-edit" }).map((i) => i.key)).toEqual(["b"]);
		expect(filterLibraryItems(items, { ...all, query: "opus", agentName: () => "Opus" }).length).toBe(3);
		expect(filterLibraryItems(items, { ...all, query: "#1" }).length).toBe(3);
	});

	it("never matches search text inside a privacy-locked project", () => {
		expect(filterLibraryItems(items, { ...all, query: "promo", isLocked: (id) => id === "p2" })).toEqual([]);
		expect(filterLibraryItems(items, { ...all, isLocked: (id) => id === "p2" }).length).toBe(3);
	});

	it("filters by kind, project and unseen", () => {
		expect(filterLibraryItems(items, { ...all, kind: "video" }).map((i) => i.key)).toEqual(["b"]);
		expect(filterLibraryItems(items, { ...all, projectId: "p1" }).map((i) => i.key)).toEqual(["a", "c"]);
		expect(filterLibraryItems(items, { ...all, unseenOnly: true }).map((i) => i.key)).toEqual(["a"]);
	});

	it("sorts newest, oldest and largest", () => {
		expect(sortLibraryItems(items, "newest").map((i) => i.key)).toEqual(["a", "c", "b"]);
		expect(sortLibraryItems(items, "oldest").map((i) => i.key)).toEqual(["b", "c", "a"]);
		expect(sortLibraryItems(items, "largest").map((i) => i.key)).toEqual(["b", "a", "c"]);
	});

	it("buckets by local calendar day", () => {
		const now = new Date(2026, 10, 24, 15, 0).getTime();
		expect(libraryDayBucket(new Date(2026, 10, 24, 0, 1).getTime(), now)).toBe("today");
		expect(libraryDayBucket(new Date(2026, 10, 23, 23, 59).getTime(), now)).toBe("yesterday");
		expect(libraryDayBucket(new Date(2026, 10, 19).getTime(), now)).toBe("week");
		expect(libraryDayBucket(new Date(2026, 10, 1).getTime(), now)).toBe("month");
		expect(libraryDayBucket(new Date(2026, 5, 1).getTime(), now)).toBe("older");
	});

	it("totals disk by project or task, biggest first, and summarizes", () => {
		expect(libraryDiskGroups(items, "project").map((g) => [g.id, g.bytes, g.count])).toEqual([["p2", 900, 1], ["p1", 55, 2]]);
		expect(libraryDiskGroups(items, "task").map((g) => g.id)).toEqual(["t9", "t1"]);
		expect(summarizeLibrary(items)).toEqual({ count: 3, bytes: 955, unseen: 1 });
	});

	it("gives the viewer the task's own reports in artifact order", () => {
		expect(libraryViewerSiblings(items, items[0]).map((i) => i.key)).toEqual(["c", "a"]);
	});
});
