/**
 * `codexScanFloorAt` is an optional field on the task record. Nothing in
 * activation may drop it, and a record written by an older version (no field)
 * must load unchanged. Runs the REAL data module against a temp DEV3_HOME.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Project } from "../../shared/types";

const TEST_HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT}/codex-scan-floor`);

vi.mock("../logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
vi.mock("../file-lock", () => ({ withFileLock: async <T>(_f: string, fn: () => Promise<T>): Promise<T> => fn() }));

import { addTask, getTask, updateTask } from "../data";

const project: Project = { id: "proj-1", name: "Test", path: "/tmp/test-project", setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "2025-01-01T00:00:00Z" };
const FLOOR = "2026-09-28T08:00:00.000Z";

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
});

describe("codexScanFloorAt on disk", () => {
	it("survives the writes a reopen or activation makes", async () => {
		const task = await addTask(project, "Codex task");
		await updateTask(project, task.id, { status: "completed", worktreePath: null, codexScanFloorAt: FLOOR });
		// Reopen: status back to in-progress (re-stamps lifecycleStartedAt), then the activation patch.
		await updateTask(project, task.id, { status: "in-progress" });
		await updateTask(project, task.id, { worktreePath: "/wt/x/worktree", branchName: "feat/x", customColumnId: null });
		await updateTask(project, task.id, { sessionState: { panes: [{ agentCmd: "codex", sessionId: null, agentId: null, configId: null }] } });
		const after = await getTask(project, task.id);
		expect(after.codexScanFloorAt).toBe(FLOOR);
		expect(after.lifecycleStartedAt).toBeDefined();
	});

	it("loads a record written without the field (older version) and leaves it absent", async () => {
		const task = await addTask(project, "Old record");
		const file = `${TEST_HOME}/data/${project.path.replace(/^\//, "").replaceAll("/", "-")}/tasks.json`;
		const raw = JSON.parse(readFileSync(file, "utf8"));
		for (const entry of raw) delete entry.codexScanFloorAt;
		writeFileSync(file, JSON.stringify(raw));
		await updateTask(project, task.id, { title: "touched" });
		expect((await getTask(project, task.id)).codexScanFloorAt).toBeUndefined();
	});
});
