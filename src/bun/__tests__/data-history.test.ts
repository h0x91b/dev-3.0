import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import type { Project, TaskHistoryEntry } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-history`);

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: TEST_HOME,
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
	vi.useRealTimers();
});

import { addTask, updateTask } from "../data";
import { loadEffectiveTaskHistory } from "../task-blobs";

/**
 * A task's history no longer rides on the Task object — saving archives it into
 * the task's sidecar and leaves `history: []` in tasks.json. Every assertion
 * below is about the history a READER sees (`dev3 task show --history`), so they
 * go through the same merge that handler uses.
 */
async function historyOf(task: { id: string; history?: TaskHistoryEntry[] }): Promise<TaskHistoryEntry[]> {
	return loadEffectiveTaskHistory(testProject, task);
}

const testProject: Project = {
	id: "proj-1",
	name: "Test",
	path: "/tmp/test-project",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

describe("task title/overview history", () => {
	it("seeds a 'created' entry capturing the initial title", async () => {
		const task = await addTask(testProject, "Fix the login flow");
		const history = await historyOf(task);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			title: "Fix the login flow",
			overview: null,
			changed: "created",
		});
		expect(typeof history[0].at).toBe("string");
	});

	it("records 'both' when title and overview change together", async () => {
		const task = await addTask(testProject, "Initial");
		const updated = await updateTask(testProject, task.id, {
			customTitle: "Renamed",
			overview: "New overview",
		});
		expect((await historyOf(updated))[1]).toMatchObject({ changed: "both", title: "Renamed", overview: "New overview" });
	});

	it("uses the user override as the effective overview", async () => {
		const task = await addTask(testProject, "Task");
		await updateTask(testProject, task.id, { overview: "agent overview" });
		const updated = await updateTask(testProject, task.id, { userOverview: "user overview" });
		const history = await historyOf(updated);
		expect(history[history.length - 1]).toMatchObject({
			overview: "user overview",
			changed: "overview",
		});
	});

	it("does not append an entry for status-only changes or an unchanged effective overview", async () => {
		const task = await addTask(testProject, "Task");
		expect(await historyOf(await updateTask(testProject, task.id, { status: "in-progress" }))).toHaveLength(1);
		await updateTask(testProject, task.id, { userOverview: "pinned" });
		// Agent rewrites the hidden overview — effective value stays "pinned".
		const updated = await updateTask(testProject, task.id, { overview: "hidden agent text" });
		const overviewEntries = (await historyOf(updated)).filter((entry) => entry.changed !== "created");
		expect(overviewEntries).toHaveLength(1);
		expect(overviewEntries[0].overview).toBe("pinned");
	});

	it("appends a title or overview entry per edit, in a chronological, append-only log", async () => {
		const task = await addTask(testProject, "v1");
		await updateTask(testProject, task.id, { customTitle: "v2" });
		await updateTask(testProject, task.id, { overview: "o1" });
		const updated = await updateTask(testProject, task.id, { customTitle: "v3" });
		const history = await historyOf(updated);
		expect(history.map((entry) => entry.changed)).toEqual(["created", "title", "overview", "title"]);
		expect(history.map((entry) => entry.title)).toEqual(["v1", "v2", "v2", "v3"]);
		expect(history.map((entry) => entry.overview)).toEqual([null, null, "o1", "o1"]);
	});
});

describe("addTask — carried extras", () => {
	it("persists notes, overview and userOverview passed via extras", async () => {
		const notes = [
			{ id: "n1", content: "carried note", source: "user" as const, createdAt: "2026-04-15T00:00:00Z", updatedAt: "2026-04-15T00:00:00Z" },
		];
		const task = await addTask(testProject, "Launched with variants", "in-progress", {
			notes,
			overview: "agent overview",
			userOverview: "user overview",
		});
		expect(task.notes).toEqual(notes);
		expect(task.overview).toBe("agent overview");
		expect(task.userOverview).toBe("user overview");
		// The seeded 'created' history entry reflects the carried (effective) overview.
		expect((await historyOf(task))[0]).toMatchObject({ overview: "user overview", changed: "created" });

		// Not provided, the carried fields are omitted (no empty-notes noise).
		const plain = await addTask(testProject, "Plain task");
		expect(plain.notes).toBeUndefined();
		expect(plain.overview).toBeUndefined();
		expect(plain.userOverview).toBeUndefined();
	});
});

describe("task lifecycle timing", () => {
	it("starts on first in-progress move and resets after a terminal task is reopened", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-09T09:00:00.000Z"));
		const task = await addTask(testProject, "Track lifecycle");
		const started = await updateTask(testProject, task.id, { status: "in-progress" });
		expect(started.lifecycleStartedAt).toBe("2026-07-09T09:00:00.000Z");

		vi.setSystemTime(new Date("2026-07-09T10:00:00.000Z"));
		const reviewing = await updateTask(testProject, task.id, { status: "review-by-ai" });
		expect(reviewing.lifecycleStartedAt).toBe(started.lifecycleStartedAt);

		await updateTask(testProject, task.id, { status: "completed" });
		vi.setSystemTime(new Date("2026-07-10T09:00:00.000Z"));
		const reopened = await updateTask(testProject, task.id, { status: "in-progress" });
		expect(reopened.lifecycleStartedAt).toBe("2026-07-10T09:00:00.000Z");
	});
});
