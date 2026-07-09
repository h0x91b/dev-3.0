import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../shared/types";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));

vi.mock("../data", () => ({
	loadProjects: vi.fn(),
	loadVirtualProjects: vi.fn(),
	loadTasks: vi.fn(),
}));

vi.mock("../git", () => ({
	getBranchDiffStats: vi.fn(),
}));

vi.mock("../rpc-handlers/shared", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as data from "../data";
import * as git from "../git";
import { getProductivityStats, toStatEvent } from "../rpc-handlers/productivity-stats";

const mockData = data as unknown as {
	loadProjects: ReturnType<typeof vi.fn>;
	loadVirtualProjects: ReturnType<typeof vi.fn>;
	loadTasks: ReturnType<typeof vi.fn>;
};
const mockGit = git as unknown as { getBranchDiffStats: ReturnType<typeof vi.fn> };

function makeProject(over: Partial<Project> = {}): Project {
	return { id: "p1", name: "Proj", path: "/repo", ...over } as Project;
}

function makeTask(over: Partial<Task> = {}): Task {
	return {
		id: "t1",
		seq: 1,
		projectId: "p1",
		title: "Do the thing",
		description: "",
		status: "completed",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-02T00:00:00.000Z",
		movedAt: "2026-06-02T00:00:00.000Z",
		...over,
	} as Task;
}

describe("toStatEvent", () => {
	it("uses captured completedDiffStats when no live diff", () => {
		const ev = toStatEvent(
			makeProject(),
			makeTask({ completedDiffStats: { files: 3, insertions: 40, deletions: 5, capturedAt: "x" } }),
		);
		expect(ev.insertions).toBe(40);
		expect(ev.deletions).toBe(5);
		expect(ev.files).toBe(3);
		expect(ev.liveStats).toBe(false);
		expect(ev.status).toBe("completed");
		expect(ev.movedAt).toBe("2026-06-02T00:00:00.000Z");
		expect(ev.lifecycleStartedAt).toBeNull();
	});

	it("prefers live diff over captured and flags liveStats", () => {
		const ev = toStatEvent(
			makeProject(),
			makeTask({ completedDiffStats: { files: 3, insertions: 40, deletions: 5, capturedAt: "x" } }),
			{ files: 1, insertions: 9, deletions: 1 },
		);
		expect(ev.insertions).toBe(9);
		expect(ev.liveStats).toBe(true);
	});

	it("defaults to zero when neither captured nor live exists", () => {
		const ev = toStatEvent(makeProject(), makeTask({ completedDiffStats: undefined }));
		expect(ev).toMatchObject({ files: 0, insertions: 0, deletions: 0, liveStats: false });
	});

	it("marks virtual projects and prefers customTitle", () => {
		const ev = toStatEvent(
			makeProject({ kind: "virtual" }),
			makeTask({ customTitle: "Custom" }),
		);
		expect(ev.projectKind).toBe("virtual");
		expect(ev.title).toBe("Custom");
	});

	it("passes through time-tracking fields (durations, statusEnteredAt, focusMs)", () => {
		const ev = toStatEvent(
			makeProject(),
			makeTask({
				statusDurations: { "in-progress": 3_600_000, "review-by-ai": 600_000 },
				statusEnteredAt: "2026-06-02T00:00:00.000Z",
				focusMs: 120_000,
			}),
		);
		expect(ev.statusDurations).toEqual({ "in-progress": 3_600_000, "review-by-ai": 600_000 });
		expect(ev.statusEnteredAt).toBe("2026-06-02T00:00:00.000Z");
		expect(ev.focusMs).toBe(120_000);
	});

	it("defaults time-tracking fields for legacy tasks", () => {
		const ev = toStatEvent(makeProject(), makeTask());
		expect(ev.statusDurations).toEqual({});
		expect(ev.statusEnteredAt).toBeNull();
		expect(ev.focusMs).toBe(0);
	});
});

describe("getProductivityStats", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("aggregates completed (captured) + active (live) across git and virtual projects", async () => {
		const gitProject = makeProject({ id: "g1", name: "Git", kind: "git" });
		const virtualProject = makeProject({ id: "v1", name: "Ops", kind: "virtual" });
		mockData.loadProjects.mockResolvedValue([gitProject]);
		mockData.loadVirtualProjects.mockResolvedValue([virtualProject]);

		const completed = makeTask({
			id: "c1",
			projectId: "g1",
			status: "completed",
			completedDiffStats: { files: 2, insertions: 30, deletions: 4, capturedAt: "x" },
		});
		const active = makeTask({
			id: "a1",
			projectId: "g1",
			status: "in-progress",
			worktreePath: "/repo/wt",
			completedDiffStats: undefined,
		});
		const opsTask = makeTask({ id: "o1", projectId: "v1", status: "completed", baseBranch: "main" });

		mockData.loadTasks.mockImplementation(async (p: Project) =>
			p.id === "g1" ? [completed, active] : [opsTask],
		);
		mockGit.getBranchDiffStats.mockResolvedValue({ files: 1, insertions: 12, deletions: 3, fileStats: [] });

		const res = await getProductivityStats();

		expect(res.events).toHaveLength(3);
		expect(res.generatedAt).toBeTruthy();

		const c = res.events.find((e) => e.taskId === "c1")!;
		expect(c.insertions).toBe(30);
		expect(c.liveStats).toBe(false);

		const a = res.events.find((e) => e.taskId === "a1")!;
		expect(a.insertions).toBe(12);
		expect(a.liveStats).toBe(true);

		const o = res.events.find((e) => e.taskId === "o1")!;
		expect(o.projectKind).toBe("virtual");
		expect(o.insertions).toBe(0);
		// virtual tasks never trigger a live git diff
		expect(mockGit.getBranchDiffStats).toHaveBeenCalledTimes(1);
	});

	it("skips a project whose tasks fail to load without throwing", async () => {
		mockData.loadProjects.mockResolvedValue([makeProject({ id: "g1" }), makeProject({ id: "g2" })]);
		mockData.loadVirtualProjects.mockResolvedValue([]);
		mockData.loadTasks.mockImplementation(async (p: Project) => {
			if (p.id === "g1") throw new Error("corrupt tasks.json");
			return [makeTask({ id: "ok1", projectId: "g2" })];
		});

		const res = await getProductivityStats();
		expect(res.events).toHaveLength(1);
		expect(res.events[0].taskId).toBe("ok1");
	});
});
