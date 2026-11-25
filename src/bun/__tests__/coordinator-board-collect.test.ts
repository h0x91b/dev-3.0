import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const getProject = vi.fn();
const loadTasks = vi.fn();
vi.mock("../data", () => ({
	getProject: (...a: unknown[]) => getProject(...a),
	loadTasks: (...a: unknown[]) => loadTasks(...a),
}));

const { collectCoordinatorBoard, coordinatorBoardEpilogue } = await import("../coordinator-board");

const NOW = new Date("2026-08-25T18:00:00.000Z");

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "aaaaaaaa-1111-2222-3333-444444444444",
		projectId: "p1",
		seq: 1620,
		variantIndex: null,
		title: "Fix auth race",
		description: "",
		status: "in-progress",
		agentId: null,
		configId: null,
		createdAt: "2026-08-25T10:00:00.000Z",
		updatedAt: "2026-08-25T10:00:00.000Z",
		...overrides,
	} as unknown as Task;
}

const project = { id: "p1", name: "dev-3.0" } as unknown as Project;

describe("collectCoordinatorBoard", () => {
	// The coordinator asked for what it is managing: To Do is not started and
	// finished tasks have their own, time-boxed section.
	it("keeps only tasks that are neither in To Do nor finished", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 1, status: "todo" }),
			task({ id: "a2", seq: 2, status: "in-progress" }),
			task({ id: "a3", seq: 3, status: "user-questions" }),
			task({ id: "a4", seq: 4, status: "review-by-user" }),
		], NOW);

		expect(snap.live.map((r) => r.seq).sort()).toEqual([2, 3, 4]);
	});

	it("shows completed and cancelled tasks finished inside the 24-hour window, freshest first", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 1, status: "completed", movedAt: "2026-08-25T09:00:00.000Z" }),
			task({ id: "a2", seq: 2, status: "completed", movedAt: "2026-08-25T16:00:00.000Z" }),
			task({ id: "a3", seq: 3, status: "cancelled", movedAt: "2026-08-25T17:00:00.000Z" }),
			// Finished before the window opened: dropped.
			task({ id: "a4", seq: 4, status: "completed", movedAt: "2026-08-23T16:00:00.000Z" }),
		], NOW);

		expect(snap.finished.map((r) => r.seq)).toEqual([3, 2, 1]);
		expect(snap.live).toHaveLength(0);
	});

	// Only a LIVE sibling makes a seq ambiguous, which is what decides whether
	// the row has to carry a UUID the coordinator can address.
	it("marks a seq as shared only while two live tasks answer to it", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 7, variantIndex: 1, status: "in-progress" }),
			task({ id: "a2", seq: 7, variantIndex: 2, status: "in-progress" }),
			task({ id: "a3", seq: 8, variantIndex: 1, status: "in-progress" }),
			// A finished sibling does not make the live seq 8 look shared.
			task({ id: "a4", seq: 8, variantIndex: 2, status: "completed", movedAt: "2026-08-25T17:00:00.000Z" }),
		], NOW);

		expect(snap.live.filter((r) => r.seq === 7).every((r) => r.seqShared)).toBe(true);
		expect(snap.live.find((r) => r.seq === 8)?.seqShared).toBe(false);
	});

	// `statusEnteredAt` is stamped on every status change and is the precise
	// answer to "how long has it been sitting there"; older tasks fall back to
	// movedAt, then createdAt — "unknown" is reserved for a task with no stamp.
	it("dates the stint from statusEnteredAt, then movedAt, then createdAt", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 1, statusEnteredAt: "2026-08-25T17:19:00.000Z", movedAt: "2026-08-25T12:00:00.000Z" }),
			task({ id: "a2", seq: 2, statusEnteredAt: undefined, movedAt: "2026-08-25T12:00:00.000Z" }),
			task({ id: "a3", seq: 3, statusEnteredAt: undefined, movedAt: undefined }),
		], NOW);

		const since = new Map(snap.live.map((r) => [r.seq, r.columnSince]));
		expect(since.get(1)).toBe("2026-08-25T17:19:00.000Z");
		expect(since.get(2)).toBe("2026-08-25T12:00:00.000Z");
		expect(since.get(3)).toBe("2026-08-25T10:00:00.000Z");
	});

	// A task created before the priority field existed must band as P3 on the
	// board, the same value `priorityRank` sorts it with.
	it("carries the custom column name, hibernated flag and priority (default P3) onto the row", async () => {
		const withColumn = {
			id: "p1",
			name: "dev-3.0",
			customColumns: [{ id: "c9", name: "On hold" }],
		} as unknown as Project;

		const snap = await collectCoordinatorBoard(withColumn, [
			task({ id: "a1", seq: 1, status: "in-progress", customColumnId: "c9", hibernated: true, priority: "P0" }),
			task({ id: "a2", seq: 2, priority: undefined }),
		], NOW);

		const [first, second] = [snap.live.find((r) => r.seq === 1)!, snap.live.find((r) => r.seq === 2)!];
		expect(first.column).toBe("On hold");
		expect(first.hibernated).toBe(true);
		expect(first.priority).toBe("P0");
		expect(second.priority).toBe("P3");
	});
});

describe("coordinatorBoardEpilogue", () => {
	beforeEach(() => {
		getProject.mockReset();
		loadTasks.mockReset();
		getProject.mockResolvedValue(project);
		loadTasks.mockResolvedValue([task({ id: "a1", seq: 42, status: "in-progress" })]);
	});

	it("renders the board for a coordinator task", async () => {
		const text = await coordinatorBoardEpilogue(task({ taskType: "coordinator" }));

		expect(text).toContain("<dev3-board");
		expect(text).toContain("seq:42");
	});

	// The trailer rides on every message dev3 delivers; only a coordinator's job
	// is the board, and every other task would just pay bytes for it.
	it("adds nothing for an ordinary or pr-review task", async () => {
		expect(await coordinatorBoardEpilogue(task())).toBe("");
		expect(await coordinatorBoardEpilogue(task({ taskType: "pr-review" }))).toBe("");
		expect(loadTasks).not.toHaveBeenCalled();
	});

	// A message that arrives without its trailer is worth incomparably more than
	// a message that does not arrive.
	it("returns an empty trailer instead of throwing when the board or project cannot be read", async () => {
		loadTasks.mockRejectedValue(new Error("tasks.json is locked"));

		await expect(coordinatorBoardEpilogue(task({ taskType: "coordinator" }))).resolves.toBe("");

		// Same when the project is gone.
		loadTasks.mockResolvedValue([]);
		getProject.mockRejectedValue(new Error("no such project"));
		await expect(coordinatorBoardEpilogue(task({ taskType: "coordinator" }))).resolves.toBe("");
	});
});
