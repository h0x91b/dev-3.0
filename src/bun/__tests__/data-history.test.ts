import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import type { Project } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("../paths", () => ({
	DEV3_HOME: "/tmp/dev3-test-history",
}));

vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync("/tmp/dev3-test-history", { recursive: true, force: true });
	mkdirSync("/tmp/dev3-test-history", { recursive: true });
});

afterEach(() => {
	vi.useRealTimers();
});

import { addTask, updateTask } from "../data";

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
		expect(task.history).toHaveLength(1);
		expect(task.history![0]).toMatchObject({
			title: "Fix the login flow",
			overview: null,
			changed: "created",
		});
		expect(typeof task.history![0].at).toBe("string");
	});

	it("appends an entry when the overview changes", async () => {
		const task = await addTask(testProject, "Build feature");
		const updated = await updateTask(testProject, task.id, { overview: "Working on the parser" });
		expect(updated.history).toHaveLength(2);
		expect(updated.history![1]).toMatchObject({
			title: "Build feature",
			overview: "Working on the parser",
			changed: "overview",
		});
	});

	it("appends an entry when the custom title changes", async () => {
		const task = await addTask(testProject, "Some long auto generated description");
		const updated = await updateTask(testProject, task.id, { customTitle: "Short title" });
		expect(updated.history).toHaveLength(2);
		expect(updated.history![1]).toMatchObject({
			title: "Short title",
			changed: "title",
		});
	});

	it("records 'both' when title and overview change together", async () => {
		const task = await addTask(testProject, "Initial");
		const updated = await updateTask(testProject, task.id, {
			customTitle: "Renamed",
			overview: "New overview",
		});
		expect(updated.history![1]).toMatchObject({ changed: "both", title: "Renamed", overview: "New overview" });
	});

	it("uses the user override as the effective overview", async () => {
		const task = await addTask(testProject, "Task");
		await updateTask(testProject, task.id, { overview: "agent overview" });
		const updated = await updateTask(testProject, task.id, { userOverview: "user overview" });
		expect(updated.history!.at(-1)).toMatchObject({
			overview: "user overview",
			changed: "overview",
		});
	});

	it("does not append an entry for status-only changes", async () => {
		const task = await addTask(testProject, "Task");
		const updated = await updateTask(testProject, task.id, { status: "in-progress" });
		expect(updated.history).toHaveLength(1);
	});

	it("does not append an entry when the effective overview is unchanged", async () => {
		const task = await addTask(testProject, "Task");
		await updateTask(testProject, task.id, { userOverview: "pinned" });
		// Agent rewrites the hidden overview — effective value stays "pinned".
		const updated = await updateTask(testProject, task.id, { overview: "hidden agent text" });
		const overviewEntries = updated.history!.filter((entry) => entry.changed !== "created");
		expect(overviewEntries).toHaveLength(1);
		expect(overviewEntries[0].overview).toBe("pinned");
	});

	it("keeps a chronological, append-only log across several edits", async () => {
		const task = await addTask(testProject, "v1");
		await updateTask(testProject, task.id, { customTitle: "v2" });
		await updateTask(testProject, task.id, { overview: "o1" });
		const updated = await updateTask(testProject, task.id, { customTitle: "v3" });
		expect(updated.history!.map((entry) => entry.changed)).toEqual(["created", "title", "overview", "title"]);
		expect(updated.history!.map((entry) => entry.title)).toEqual(["v1", "v2", "v2", "v3"]);
	});
});
