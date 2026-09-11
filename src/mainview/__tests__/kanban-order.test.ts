import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import type { BoardProject, Task, TaskMovement } from "../../shared/types";
import { kanbanOrder } from "../components/agent-traffic/kanban-order";
import { layoutTraffic } from "../components/agent-traffic/nodes-layout";
import { projectTaskAt } from "../components/agent-traffic/task-history";
import { trafficNodes, trafficRecords } from "../components/agent-traffic/traffic-model";

const project: BoardProject = { id: "p", kind: "git" } as unknown as BoardProject;

function task(id: string, seq: number, over: Partial<Task> = {}): Task {
	return { id, projectId: "p", seq, title: id, status: "in-progress", taskType: null, ...over } as unknown as Task;
}

function row(from: string | null, to: string, over: Partial<AgentMessageLogRow> = {}): AgentMessageLogRow {
	return {
		v: 1,
		at: "2026-09-07T10:00:00.000Z",
		fromTaskId: from,
		fromSeq: 1,
		fromTitle: from ?? "",
		toTaskId: to,
		toSeq: 2,
		toTitle: to,
		toProjectId: "p",
		kind: "immediate",
		body: "hello",
		bodyKind: "text",
		status: "delivered",
		...over,
	} as AgentMessageLogRow;
}

const ms = (minute: number) => Date.parse(`2026-09-07T10:${String(minute).padStart(2, "0")}:00.000Z`);

/** The stage as it opens, with the board order applied at `cursorAt`. */
function stage(
	tasks: Task[],
	rows: AgentMessageLogRow[],
	options: { cursorAt?: number | null; projects?: BoardProject[]; showQuiet?: boolean } = {},
) {
	const cursorAt = options.cursorAt ?? null;
	const nodes = trafficNodes(tasks, rows);
	const board = kanbanOrder(options.projects ?? [project], nodes, (node) => projectTaskAt(node.task, cursorAt));
	return layoutTraffic(nodes, trafficRecords(rows), { board, showQuiet: options.showQuiet });
}

/** Card ids in reading order — the order the grid actually puts them in. */
function reading(scene: ReturnType<typeof layoutTraffic>): string[] {
	return [...scene.placed]
		.sort((a, b) => a.y - b.y || a.x - b.x)
		.map((placed) => placed.node.id);
}

describe("kanbanOrder", () => {
	it("orders cards by their board column, terminal columns last", () => {
		const tasks = [
			task("done", 1, { status: "completed" }),
			task("asking", 2, { status: "user-questions" }),
			task("killed", 3, { status: "cancelled" }),
			task("working", 4, { status: "in-progress" }),
			task("mine", 5, { status: "review-by-user" }),
		];
		const scene = stage(tasks, tasks.map((t) => row("working", t.id)));
		expect(reading(scene)).toEqual(["working", "asking", "mine", "done", "killed"]);
	});

	it("keeps the coordinator above the grid whatever column it sits in", () => {
		const tasks = [
			task("hub", 1, { status: "completed", taskType: "coordinator" }),
			task("working", 2, { status: "in-progress" }),
		];
		const scene = stage(tasks, [row("hub", "working")]);
		const hub = scene.placed.find((placed) => placed.hub);
		expect(hub?.node.id).toBe("hub");
		expect(scene.placed.find((p) => p.node.id === "working")!.y).toBeGreaterThan(hub!.y);
	});

	it("orders by seq inside one column", () => {
		const tasks = [task("b", 22), task("a", 11), task("c", 33)];
		const scene = stage(tasks, tasks.map((t) => row("a", t.id)));
		expect(reading(scene)).toEqual(["a", "b", "c"]);
	});

	it("sorts a custom column where the board puts it", () => {
		const projects: BoardProject[] = [
			{ id: "p", kind: "git", customColumns: [{ id: "hold", name: "On hold" }] } as unknown as BoardProject,
		];
		const tasks = [
			task("done", 1, { status: "completed" }),
			task("held", 2, { status: "in-progress", customColumnId: "hold" }),
			task("working", 3, { status: "in-progress" }),
		];
		const scene = stage(tasks, tasks.map((t) => row("working", t.id)), { projects });
		expect(reading(scene)).toEqual(["working", "held", "done"]);
	});

	it("falls back to the status column when the custom column id is dangling", () => {
		const tasks = [task("ghost", 1, { status: "in-progress", customColumnId: "gone" }), task("done", 2, { status: "completed" })];
		const scene = stage(tasks, tasks.map((t) => row("ghost", t.id)));
		expect(reading(scene)).toEqual(["ghost", "done"]);
	});

	it("sorts a card with no known column after every column", () => {
		const tasks = [task("done", 1, { status: "completed" }), task("working", 2, { status: "in-progress" })];
		// The sender is not on the board at all — the log remembers it, nothing else does.
		const scene = stage(tasks, [row("stranger", "working"), row("working", "done")]);
		expect(reading(scene)).toEqual(["working", "done", "stranger"]);
	});
});

describe("layoutTraffic To Do eligibility", () => {
	it("leaves To Do cards off the stage", () => {
		const tasks = [
			task("queued", 1, { status: "todo" }),
			task("working", 2, { status: "in-progress" }),
			task("mine", 3, { status: "review-by-user" }),
		];
		const scene = stage(tasks, [row("working", "mine")]);
		expect(reading(scene)).toEqual(["working", "mine"]);
	});

	it("drops a To Do card that exchanged a message, and its wire with it", () => {
		const tasks = [task("queued", 1, { status: "todo" }), task("working", 2, { status: "in-progress" })];
		const scene = stage(tasks, [row("working", "queued")]);
		expect(reading(scene)).toEqual(["working"]);
		// The row stays in the log; the stage just has nowhere to draw it.
		expect(scene.edges).toHaveLength(0);
	});

	it("never routes a wire to a card it dropped", () => {
		const tasks = [
			task("queued", 1, { status: "todo" }),
			task("working", 2, { status: "in-progress" }),
			task("mine", 3, { status: "review-by-user" }),
		];
		const scene = stage(tasks, [row("working", "mine"), row("working", "queued"), row("queued", "mine")]);
		const drawn = new Set(scene.placed.map((placed) => placed.node.key));
		for (const edge of scene.edges) {
			expect(drawn.has(edge.from)).toBe(true);
			expect(drawn.has(edge.to)).toBe(true);
		}
		expect(reading(scene)).toEqual(["working", "mine"]);
	});

	it("keeps every To Do card off a board whose window is silent", () => {
		const tasks = [task("queued", 1, { status: "todo" }), task("working", 2, { status: "in-progress" })];
		const scene = stage(tasks, []);
		expect(reading(scene)).toEqual(["working"]);
	});
});

describe("kanbanOrder under replay", () => {
	const movements = (entries: [number, Task["status"]][]): TaskMovement[] =>
		entries.map(([minute, to], index) => ({
			at: new Date(ms(minute)).toISOString(),
			kind: index === 0 ? "created" : "moved",
			to,
			from: index === 0 ? null : entries[index - 1][1],
		})) as unknown as TaskMovement[];

	const late = task("late", 1, {
		status: "completed",
		movements: movements([[0, "todo"], [10, "in-progress"], [50, "completed"]]),
	});
	const steady = task("steady", 2, {
		status: "user-questions",
		movements: movements([[0, "user-questions"]]),
	});
	const rows = [row("steady", "late")];

	it("sorts a task by the column it was in at the cursor, not the one it is in now", () => {
		// At 10:20 `late` was still in progress, so it leads; live it is completed and trails.
		expect(reading(stage([late, steady], rows, { cursorAt: ms(20) }))).toEqual(["late", "steady"]);
		expect(reading(stage([late, steady], rows, { cursorAt: null }))).toEqual(["steady", "late"]);
	});

	it("drops a card that was still in To Do at the cursor", () => {
		const idle = task("idle", 3, {
			status: "in-progress",
			movements: movements([[0, "todo"], [40, "in-progress"]]),
		});
		const shown = (cursorAt: number) =>
			reading(stage([late, steady, idle], rows, { cursorAt, showQuiet: true }));
		expect(shown(ms(20))).not.toContain("idle");
		expect(shown(ms(45))).toContain("idle");
	});

	it("keeps a card whose past was never recorded", () => {
		const unrecorded = task("mystery", 9, { status: "todo", movements: [] });
		// Live status says To Do, but nothing proves it was To Do then — so it stays.
		expect(reading(stage([late, steady, unrecorded], rows, { cursorAt: ms(20), showQuiet: true })))
			.toContain("mystery");
	});
});
