import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/types";
import {
	BOARD_COPY_FORMAT_VERSION,
	boardCopySlug,
	boardCopyTaskStem,
	parseBoardCopyManifest,
	parseBoardCopyTask,
	restoreTasksFromCopy,
	toBoardCopyTask,
	type BoardCopyTask,
} from "../../shared/board-copy";

function copyTask(overrides: Partial<BoardCopyTask>): BoardCopyTask {
	return {
		id: "a",
		seq: 1,
		projectId: "old",
		title: "T",
		description: "T",
		status: "todo",
		baseBranch: "main",
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

describe("board copy file names", () => {
	it("slugs titles to short ASCII words", () => {
		expect(boardCopySlug("Fix the auth race!")).toBe("fix-the-auth-race");
		expect(boardCopySlug("Café déjà vu")).toBe("cafe-deja-vu");
		expect(boardCopySlug("Исправить баг")).toBe("task");
		expect(boardCopySlug("a".repeat(80)).length).toBe(40);
	});

	it("keeps variants that share a seq apart", () => {
		expect(boardCopyTaskStem({ seq: 7, variantIndex: null })).toBe("7");
		expect(boardCopyTaskStem({ seq: 7, variantIndex: 2 })).toBe("7-v2");
	});
});

describe("toBoardCopyTask", () => {
	it("drops every field outside the allowlist, including fields added to Task later", () => {
		const task = { ...copyTask({}), worktreePath: "/wt", accountId: "acct", someFutureSecret: "x" } as unknown as Task;
		const out = toBoardCopyTask(task) as Record<string, unknown>;
		expect(out).not.toHaveProperty("worktreePath");
		expect(out).not.toHaveProperty("accountId");
		expect(out).not.toHaveProperty("someFutureSecret");
		expect(out.title).toBe("T");
	});
});

describe("parseBoardCopyManifest", () => {
	const valid = { format: "dev3-board-copy", version: BOARD_COPY_FORMAT_VERSION, labels: [], customColumns: [], taskFiles: [], taskCount: 0, projectName: "p", exportedAt: "x" };

	it("accepts the current format and rejects others", () => {
		expect(parseBoardCopyManifest(JSON.stringify(valid)).ok).toBe(true);
		expect(parseBoardCopyManifest(JSON.stringify({ ...valid, version: 2 }))).toEqual({ ok: false, reason: "unsupported-version", version: 2 });
		expect(parseBoardCopyManifest("{not json")).toEqual({ ok: false, reason: "invalid" });
		expect(parseBoardCopyManifest(JSON.stringify({ ...valid, format: "other" }))).toEqual({ ok: false, reason: "invalid" });
		expect(parseBoardCopyManifest(JSON.stringify({ ...valid, taskFiles: undefined }))).toEqual({ ok: false, reason: "invalid" });
	});
});

describe("parseBoardCopyTask", () => {
	it("drops fields outside the allowlist, including ones that launch an agent", () => {
		const parsed = parseBoardCopyTask({
			...copyTask({}),
			scheduledLaunch: { at: "2020-01-01T00:00:00.000Z", targetStatus: "in-progress", variants: [] },
			keepAlive: { enabled: true },
			accountId: "acc-1",
			importedSessionId: "sess-1",
			opsWorkDir: "/",
		});
		expect(parsed).toEqual(copyTask({}));
	});

	it("rejects values that are not tasks", () => {
		expect(parseBoardCopyTask(null)).toBeNull();
		expect(parseBoardCopyTask([copyTask({})])).toBeNull();
		expect(parseBoardCopyTask({ ...copyTask({}), id: "" })).toBeNull();
		expect(parseBoardCopyTask({ ...copyTask({}), seq: "1" })).toBeNull();
		expect(parseBoardCopyTask({ ...copyTask({}), status: "running" })).toBeNull();
		expect(parseBoardCopyTask({ ...copyTask({}), relations: "a" })).toBeNull();
	});
});

describe("restoreTasksFromCopy", () => {
	const now = "2026-10-28T12:00:00.000Z";
	let n = 0;
	const newId = () => `new-${++n}`;

	it("keeps ids when nothing collides and moves running tasks to To Do", () => {
		const out = restoreTasksFromCopy(
			[copyTask({ id: "a", status: "completed", branchName: "feat/a" }), copyTask({ id: "b", status: "review-by-user", branchName: "feat/b", customColumnId: "c1" })],
			"proj",
			{ now, takenIds: new Set(), newId },
		);
		expect(out.map((t) => t.id)).toEqual(["a", "b"]);
		expect(out[0]).toMatchObject({ projectId: "proj", status: "completed", branchName: "feat/a", worktreePath: null });
		expect(out[1]).toMatchObject({ status: "todo", branchName: null, customColumnId: null, movedAt: now, statusEnteredAt: now });
		expect(out[1].movements?.[out[1].movements.length - 1]).toMatchObject({ kind: "status", from: "review-by-user", to: "todo", fromColumnId: "c1" });
	});

	it("never carries a field outside the allowlist, even when the caller passes one", () => {
		const smuggled = { ...copyTask({}), scheduledLaunch: { at: now, targetStatus: "in-progress", variants: [] } } as BoardCopyTask;
		const [task] = restoreTasksFromCopy([smuggled], "proj", { now, takenIds: new Set(), newId });
		expect(task.scheduledLaunch).toBeUndefined();
	});

	it("remaps all ids and their relations when one id is taken elsewhere", () => {
		const out = restoreTasksFromCopy(
			[copyTask({ id: "a" }), copyTask({ id: "b", relations: [{ type: "blocked-by", taskId: "a" }, { type: "relates-to", taskId: "elsewhere" }] })],
			"proj",
			{ now, takenIds: new Set(["a"]), newId },
		);
		expect(out.some((t) => t.id === "a" || t.id === "b")).toBe(false);
		expect(out[1].relations).toEqual([
			{ type: "blocked-by", taskId: out[0].id },
			{ type: "relates-to", taskId: "elsewhere" },
		]);
	});
});
