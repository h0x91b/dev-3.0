import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import type { Project } from "../../shared/types";
import type { PrWatch } from "../../shared/pr-watch";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/data-pr-watches`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

import { addTask, updateTask } from "../data";

const project: Project = {
	id: "proj-1",
	name: "Test",
	path: "/tmp/test-pr-watches",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2025-01-01T00:00:00Z",
};

const watch: PrWatch = { id: "w1", until: "ci", prNumber: 7, headSha: "a".repeat(40), createdAt: "2026-10-22T10:00:00.000Z" };

describe("PR watches end with the task", () => {
	for (const status of ["completed", "cancelled"] as const) {
		it(`are cleared when the task moves to ${status}`, async () => {
			const task = await addTask(project, "Watching");
			await updateTask(project, task.id, { status: "in-progress", prWatches: [watch] });

			const ended = await updateTask(project, task.id, { status });

			expect(ended.prWatches).toBeNull();
		});
	}

	it("survive an ordinary status move", async () => {
		const task = await addTask(project, "Watching");
		await updateTask(project, task.id, { status: "in-progress", prWatches: [watch] });

		const moved = await updateTask(project, task.id, { status: "review-by-user" });

		expect(moved.prWatches).toEqual([watch]);
	});
});
