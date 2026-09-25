import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import type { Project, TaskStatus } from "../../shared/types";
import { MAX_TASK_MOVEMENTS_KEPT, taskResetConsent, taskResetConsentMatches } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/todo-reset-consent-anchor`);

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../file-lock", () => ({
	withFileLock: async <T>(_filePath: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

import { addTask, getTask, updateTask } from "../data";

const project: Project = {
	id: "proj-anchor", name: "T", path: "/tmp/anchor-project", setupScript: "", devScript: "", cleanupScript: "",
	defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z",
};

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-25T10:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

// The reset consent is bound to `lifecycleStartedAt` (Seq 2003 review 2003-004):
// the rolling movements log evicts itself on long runs, this field does not.
describe("reset consent anchor on the real data layer", () => {
	it("survives 60 active-column churns while the movements log rolls over (T10b)", async () => {
		const created = await addTask(project, "Long running task");
		await updateTask(project, created.id, { status: "in-progress", worktreePath: "/wt/anchor" });
		const consent = taskResetConsent(await getTask(project, created.id));
		expect(consent.lifecycleStartedAt).not.toBeNull();

		const churn: TaskStatus[] = ["user-questions", "in-progress", "review-by-user", "in-progress", "review-by-ai", "in-progress"];
		for (let i = 0; i < 60; i++) {
			vi.setSystemTime(new Date(Date.parse("2026-09-25T10:00:00.000Z") + (i + 1) * 60_000));
			await updateTask(project, created.id, { status: churn[i % churn.length] });
		}
		const after = await getTask(project, created.id);
		expect(after.movements?.length).toBeLessThanOrEqual(MAX_TASK_MOVEMENTS_KEPT);
		expect(after.movementsDropped ?? 0).toBeGreaterThan(0);
		expect(taskResetConsentMatches(after, consent)).toBe(true);
	});

	it("a relaunch at the same path after a reset stamps a new anchor, so old consent no longer matches (T9, T12+)", async () => {
		const created = await addTask(project, "Reset me");
		await updateTask(project, created.id, { status: "in-progress", worktreePath: "/wt/same" });
		const consent = taskResetConsent(await getTask(project, created.id));

		// What persistResetTask writes for the anchor, then a fresh launch at the same path.
		await updateTask(project, created.id, { status: "todo", worktreePath: null, lifecycleStartedAt: undefined });
		expect((await getTask(project, created.id)).lifecycleStartedAt).toBeUndefined();
		vi.setSystemTime(new Date("2026-09-25T11:00:00.000Z"));
		await updateTask(project, created.id, { status: "in-progress", worktreePath: "/wt/same" });

		const relaunched = await getTask(project, created.id);
		expect(relaunched.worktreePath).toBe(consent.worktreePath);
		expect(relaunched.lifecycleStartedAt).not.toBe(consent.lifecycleStartedAt);
		expect(taskResetConsentMatches(relaunched, consent)).toBe(false);
	});
});
