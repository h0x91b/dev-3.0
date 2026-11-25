import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SharedArtifact, SharedImage, Task } from "../../shared/types";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
vi.mock("../data", () => ({ loadProjects: vi.fn(), loadVirtualProjects: vi.fn(), loadTasks: vi.fn() }));
vi.mock("../rpc-handlers/shared", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { existsSync } from "node:fs";
import * as data from "../data";
import { getLibrary } from "../rpc-handlers/library";
import {
	applyLibraryPresence,
	artifactRecordBytes,
	mergeTaskLibraryItems,
	replaceTaskLibraryItems,
	filterLibraryItems,
	libraryDayBucket,
	libraryDiskGroups,
	libraryViewerSiblings,
	isLibraryItemDeletable,
	libraryDeleteGroups,
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

	it("reads a record written before artifacts had assets as asset-less instead of throwing", () => {
		const legacy = { ...artifact({}), assets: undefined, images: [{ name: "x.png" }] } as unknown as SharedArtifact;
		const older = { version: 1, name: "index.html", storedPath: "/p1", originalPath: "/o", bytes: 3, createdAt: 1 } as unknown as SharedArtifact["previousVersions"] & object;
		const record = { ...legacy, version: 2, previousVersions: [older] } as unknown as SharedArtifact;
		expect(taskLibraryItems(project, task({ sharedArtifacts: [record] }))[0]).toMatchObject({ bytes: 13, versions: 2 });
		expect(applyLibraryPresence(taskLibraryItems(project, task({ sharedArtifacts: [record] }))[0], () => true).bytes).toBe(13);
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

	it("skips only the task whose record cannot be projected", async () => {
		const broken = { id: "bad", kind: "html", title: "x", name: "i.html", storedPath: "/s", originalPath: "/o", bytes: 1, createdAt: 1, assets: [], previousVersions: [null] } as unknown as SharedArtifact;
		mockData.loadTasks.mockImplementation(async (p: Project) =>
			p.id === "p1" ? [task({ id: "bad", sharedArtifacts: [broken] }), task({ id: "ok", sharedImages: [media({})] })] : [],
		);
		const report = await getLibrary();
		expect(report.items.map((i) => i.taskId)).toEqual(["ok"]);
	});

	it("counts only files that still exist, older versions and assets included", async () => {
		const asset = { name: "a.png", storedPath: "/pool/a1/a.png", originalPath: "/y", mime: "image/png", bytes: 5 };
		const record = artifact({
			version: 2,
			bytes: 10,
			assets: [asset],
			previousVersions: [{ version: 1, name: "index.html", storedPath: "/pool/old/index.html", originalPath: "/o", bytes: 700, createdAt: 1, assets: [] }],
		});
		mockData.loadTasks.mockImplementation(async (p: Project) =>
			p.id === "p1" ? [task({ sharedArtifacts: [record], sharedVideos: [media({ id: "v", mime: "video/mp4", storedPath: "/pool/v.mp4", bytes: 9000 })] })] : [],
		);
		mockExists.mockImplementation((path: string) => path !== "/pool/old/index.html" && path !== "/pool/v.mp4");
		const report = await getLibrary();
		expect(report.items.map((i) => [i.kind, i.bytes, i.goneBytes, i.missing])).toEqual([
			["video", 0, 9000, true],
			["report", 15, 700, false],
		]);
		expect(summarizeLibrary(report.items)).toMatchObject({ bytes: 15, goneBytes: 9700, missing: 2 });
		expect(sortLibraryItems(report.items, "largest").map((i) => i.kind)).toEqual(["report", "video"]);
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
		missing: false, goneBytes: 0, live: false, order: 0, ...over,
	};
}

describe("library renderer helpers", () => {
	const items = [
		item({ key: "a", kind: "report", title: "Race audit", bytes: 50, createdAt: 30, unread: true, order: 1 }),
		item({ key: "b", kind: "video", title: "Promo cut", caption: "final mix", bytes: 900, createdAt: 10, projectId: "p2", projectName: "video-edit", taskId: "t9" }),
		item({ key: "c", kind: "report", title: "Old audit", bytes: 5, createdAt: 20, order: 0 }),
	];
	const all = { query: "", kind: "all" as const, projectId: null, unseenOnly: false };

	it("searches every term across title, caption, task, project, agent and #seq, and filters by kind, project and unseen", () => {
		expect(filterLibraryItems(items, { ...all, query: "audit" }).map((i) => i.key)).toEqual(["a", "c"]);
		expect(filterLibraryItems(items, { ...all, query: "FINAL video-edit" }).map((i) => i.key)).toEqual(["b"]);
		expect(filterLibraryItems(items, { ...all, query: "opus", agentName: () => "Opus" }).length).toBe(3);
		expect(filterLibraryItems(items, { ...all, query: "#1" }).length).toBe(3);
		expect(filterLibraryItems(items, { ...all, kind: "video" }).map((i) => i.key)).toEqual(["b"]);
		expect(filterLibraryItems(items, { ...all, projectId: "p1" }).map((i) => i.key)).toEqual(["a", "c"]);
		expect(filterLibraryItems(items, { ...all, unseenOnly: true }).map((i) => i.key)).toEqual(["a"]);
	});

	it("never matches search text inside a privacy-locked project", () => {
		expect(filterLibraryItems(items, { ...all, query: "promo", isLocked: (id) => id === "p2" })).toEqual([]);
		expect(filterLibraryItems(items, { ...all, isLocked: (id) => id === "p2" }).length).toBe(3);
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
		expect(summarizeLibrary(items)).toEqual({ count: 3, bytes: 955, unseen: 1, missing: 0, goneBytes: 0 });
	});

	it("counts an item with only an older version gone among the removed, matching its gone bytes", () => {
		const present = { ...items[0], missing: false, goneBytes: 40 };
		const lost = { ...items[1], missing: true, bytes: 0, goneBytes: 900 };
		expect(summarizeLibrary([present, lost, items[2]])).toMatchObject({ missing: 2, goneBytes: 940 });
	});

	it("rebuilds one task from a push, keeping host-checked presence for unchanged records", () => {
		const checked = item({ key: "p1:t1:i1", bytes: 0, goneBytes: 100, missing: true, versions: 1, createdAt: 5 });
		const other = item({ key: "p2:t9:x", projectId: "p2", taskId: "t9" });
		const fresh = [item({ key: "p1:t1:i1", bytes: 100, versions: 1, createdAt: 5 }), item({ key: "p1:t1:new", bytes: 7, createdAt: 9 })];
		expect(mergeTaskLibraryItems([checked], fresh).map((i) => [i.key, i.bytes, i.missing])).toEqual([["p1:t1:i1", 0, true], ["p1:t1:new", 7, false]]);
		const next = replaceTaskLibraryItems([checked, other], "p1", "t1", fresh);
		expect(next.map((i) => i.key)).toEqual(["p2:t9:x", "p1:t1:i1", "p1:t1:new"]);
		expect(replaceTaskLibraryItems(next, "p1", "t1", []).map((i) => i.key)).toEqual(["p2:t9:x"]);
	});

	it("lists a clip the user deleted as a tombstone: no bytes, not missing, never deletable again", () => {
		const clip = media({ id: "v1", mime: "video/mp4", name: "cut.mp4", bytes: 50, removedAt: 5000, removedBytes: 50 });
		const [item] = taskLibraryItems(project, task({ sharedVideos: [clip] }));
		mockExists.mockReturnValue(false);
		const checked = applyLibraryPresence(item, existsSync);
		expect(checked).toMatchObject({ removedAt: 5000, bytes: 0, goneBytes: 0, missing: false });
		expect(isLibraryItemDeletable(checked)).toBe(false);
		mockExists.mockReturnValue(true);
	});

	it("groups only deletable clips per task for the delete call", () => {
		const items = [
			...taskLibraryItems(project, task({ id: "t1", sharedVideos: [media({ id: "v1", mime: "video/mp4" })], sharedImages: [media({ id: "i1" })] })),
			...taskLibraryItems(project, task({ id: "t2", sharedAudio: [media({ id: "a1", mime: "audio/mpeg" }), media({ id: "a2", mime: "audio/mpeg", removedAt: 1 })] })),
		];
		expect(libraryDeleteGroups(items).map((g) => [g.taskId, g.items.map((i) => i.id)])).toEqual([["t1", ["v1"]], ["t2", ["a1"]]]);
	});

	it("takes a pushed tombstone over the presence it remembered", () => {
		const before = taskLibraryItems(project, task({ sharedVideos: [media({ id: "v1", mime: "video/mp4", bytes: 50 })] }));
		const after = taskLibraryItems(project, task({ sharedVideos: [media({ id: "v1", mime: "video/mp4", bytes: 50, removedAt: 9 })] }));
		expect(mergeTaskLibraryItems(before, after)[0]).toMatchObject({ removedAt: 9, bytes: 0 });
	});

	it("gives the viewer the task's own reports in artifact order", () => {
		expect(libraryViewerSiblings(items, items[0]).map((i) => i.key)).toEqual(["c", "a"]);
	});
});
