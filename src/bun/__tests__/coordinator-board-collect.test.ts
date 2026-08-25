import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, Task } from "../../shared/types";

const listPanes = vi.fn();

vi.mock("../tmux", () => ({
	tmux: { listPanes: (...args: unknown[]) => listPanes(...args) },
	ALL_PANE_ACTIVITY_FORMAT: { fields: [] },
}));
vi.mock("../pty-server", () => ({
	getSessionSocket: () => "dev3",
}));
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

beforeEach(() => {
	listPanes.mockReset();
	listPanes.mockResolvedValue([]);
});

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

	it("shows a task finished inside the 24-hour window", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 1, status: "completed", movedAt: "2026-08-25T16:00:00.000Z" }),
		], NOW);

		expect(snap.finished.map((r) => r.seq)).toEqual([1]);
		expect(snap.live).toHaveLength(0);
	});

	it("drops a task finished before the window opened", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 1, status: "completed", movedAt: "2026-08-23T16:00:00.000Z" }),
		], NOW);

		expect(snap.finished).toHaveLength(0);
	});

	it("counts a cancelled task as finished too", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 1, status: "cancelled", movedAt: "2026-08-25T17:00:00.000Z" }),
		], NOW);

		expect(snap.finished.map((r) => r.seq)).toEqual([1]);
	});

	it("lists the freshly finished first", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 1, status: "completed", movedAt: "2026-08-25T09:00:00.000Z" }),
			task({ id: "a2", seq: 2, status: "completed", movedAt: "2026-08-25T17:00:00.000Z" }),
		], NOW);

		expect(snap.finished.map((r) => r.seq)).toEqual([2, 1]);
	});

	// Only a LIVE sibling makes a seq ambiguous, which is what decides whether
	// the row has to carry a UUID the coordinator can address.
	it("marks a seq as shared only while two live tasks answer to it", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 7, variantIndex: 1, status: "in-progress" }),
			task({ id: "a2", seq: 7, variantIndex: 2, status: "in-progress" }),
			task({ id: "a3", seq: 8, variantIndex: 1, status: "in-progress" }),
		], NOW);

		expect(snap.live.filter((r) => r.seq === 7).every((r) => r.seqShared)).toBe(true);
		expect(snap.live.find((r) => r.seq === 8)?.seqShared).toBe(false);
	});

	it("does not let a finished sibling make a live seq look shared", async () => {
		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1", seq: 7, variantIndex: 1, status: "in-progress" }),
			task({ id: "a2", seq: 7, variantIndex: 2, status: "completed", movedAt: "2026-08-25T17:00:00.000Z" }),
		], NOW);

		expect(snap.live[0].seqShared).toBe(false);
	});

	// One `list-panes -a` answers for the whole board — a peek per task on every
	// turn is exactly the cost this design exists to avoid.
	it("reads every task's activity with a single server-wide tmux call", async () => {
		listPanes.mockResolvedValue([
			{ windowActivity: Math.floor(Date.parse("2026-08-25T17:50:00.000Z") / 1000), sessionName: "dev3-a1111111" },
			{ windowActivity: Math.floor(Date.parse("2026-08-25T17:00:00.000Z") / 1000), sessionName: "dev3-a2222222" },
		]);

		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1111111-0000-0000-0000-000000000000", seq: 1 }),
			task({ id: "a2222222-0000-0000-0000-000000000000", seq: 2 }),
		], NOW);

		expect(listPanes).toHaveBeenCalledTimes(1);
		expect(listPanes.mock.calls[0][1]).toMatchObject({ scope: "server" });
		expect(snap.live[0].activity).toEqual({ kind: "age", ms: 10 * 60_000, granularity: "window" });
		expect(snap.live[1].activity).toEqual({ kind: "age", ms: 60 * 60_000, granularity: "window" });
	});

	it("takes the freshest window when a task owns several", async () => {
		listPanes.mockResolvedValue([
			{ windowActivity: Math.floor(Date.parse("2026-08-25T16:00:00.000Z") / 1000), sessionName: "dev3-a1111111" },
			{ windowActivity: Math.floor(Date.parse("2026-08-25T17:55:00.000Z") / 1000), sessionName: "dev3-a1111111" },
		]);

		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1111111-0000-0000-0000-000000000000", seq: 1 }),
		], NOW);

		expect(snap.live[0].activity).toEqual({ kind: "age", ms: 5 * 60_000, granularity: "window" });
	});

	it("ignores sessions that are not a task's own", async () => {
		listPanes.mockResolvedValue([
			{ windowActivity: Math.floor(Date.parse("2026-08-25T17:59:00.000Z") / 1000), sessionName: "dev3-dev-a1111111" },
			{ windowActivity: Math.floor(Date.parse("2026-08-25T17:59:00.000Z") / 1000), sessionName: "someones-own-session" },
		]);

		const snap = await collectCoordinatorBoard(project, [
			task({ id: "a1111111-0000-0000-0000-000000000000", seq: 1 }),
		], NOW);

		expect(snap.live[0].activity).toEqual({ kind: "no-session", reason: "not running" });
	});

	// A tmux server we cannot reach says nothing about whether a child is working.
	it("survives a tmux failure without reporting anyone as quiet", async () => {
		listPanes.mockRejectedValue(new Error("no server running"));

		const snap = await collectCoordinatorBoard(project, [task({ id: "a1111111-0000-0000-0000-000000000000" })], NOW);

		expect(snap.live[0].activity.kind).toBe("no-session");
	});

	it("names a custom column by the name the user gave it", async () => {
		const withColumn = {
			id: "p1",
			name: "dev-3.0",
			customColumns: [{ id: "c9", name: "On hold" }],
		} as unknown as Project;

		const snap = await collectCoordinatorBoard(withColumn, [
			task({ status: "in-progress", customColumnId: "c9" }),
		], NOW);

		expect(snap.live[0].column).toBe("On hold");
	});

	it("reports a hibernated task without asking tmux about it", async () => {
		const snap = await collectCoordinatorBoard(project, [task({ hibernated: true })], NOW);

		expect(snap.live[0].hibernated).toBe(true);
		expect(snap.live[0].activity).toEqual({ kind: "no-session", reason: "hibernated" });
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
	it("adds nothing for an ordinary task", async () => {
		expect(await coordinatorBoardEpilogue(task())).toBe("");
		expect(loadTasks).not.toHaveBeenCalled();
	});

	it("adds nothing for a pr-review task", async () => {
		expect(await coordinatorBoardEpilogue(task({ taskType: "pr-review" }))).toBe("");
	});

	// A message that arrives without its trailer is worth incomparably more than
	// a message that does not arrive.
	it("returns an empty trailer instead of throwing when the board cannot be read", async () => {
		loadTasks.mockRejectedValue(new Error("tasks.json is locked"));

		await expect(coordinatorBoardEpilogue(task({ taskType: "coordinator" }))).resolves.toBe("");
	});

	it("returns an empty trailer when the project is gone", async () => {
		getProject.mockRejectedValue(new Error("no such project"));

		await expect(coordinatorBoardEpilogue(task({ taskType: "coordinator" }))).resolves.toBe("");
	});
});
