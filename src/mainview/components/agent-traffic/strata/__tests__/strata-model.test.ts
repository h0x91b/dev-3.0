import { describe, expect, it } from "vitest";
import type { AgentMessageLogRow } from "../../../../../shared/agent-message-log";
import type { Task, TaskMovement } from "../../../../../shared/types";
import { endpointKey, type TrafficNode, type TrafficRecord } from "../../traffic-model";
import {
	recordedStages,
	routeKindOf,
	strataRoutes,
	strataScene,
	strataSummary,
} from "../strata-model";

const PROJECT_A = "proj-a";
const PROJECT_B = "proj-b";
const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function movement(overrides: Partial<TaskMovement> & { to: TaskMovement["to"] }): TaskMovement {
	return { id: `mv-${Math.random()}`, at: at(60), kind: "status", ...overrides };
}

function task(overrides: Partial<Task> & { seq: number }): Task {
	return {
		id: `task-${overrides.seq}`,
		projectId: PROJECT_A,
		title: `Task ${overrides.seq}`,
		description: "",
		status: "in-progress",
		baseBranch: "main",
		worktreePath: null,
		branchName: null,
		groupId: null,
		variantIndex: null,
		agentId: null,
		configId: null,
		createdAt: at(200),
		updatedAt: at(10),
		...overrides,
	} as Task;
}

function node(task: Task): TrafficNode {
	return {
		key: endpointKey(task.projectId, task.id),
		projectId: task.projectId,
		id: task.id,
		seq: task.seq,
		title: task.title,
		task,
	};
}

function record(overrides: Partial<AgentMessageLogRow> & { toTaskId: string }): TrafficRecord {
	const row: AgentMessageLogRow = {
		v: 1,
		at: at(30),
		fromTaskId: "task-1",
		fromSeq: 1,
		fromProjectId: PROJECT_A,
		toSeq: 2,
		toProjectId: PROJECT_A,
		kind: "immediate",
		body: "hello",
		bodyKind: "text",
		status: "delivered",
		...overrides,
	};
	return { key: `${row.fromTaskId}->${row.toTaskId}:${row.at}`, row };
}

describe("strataScene grouping", () => {
	const a = task({ seq: 1, id: "task-1" });
	const b = task({ seq: 2, id: "task-2" });
	const silent = task({ seq: 3, id: "task-3" });
	const other = task({ seq: 4, id: "task-4", projectId: PROJECT_B });
	const projects = [
		{ id: PROJECT_A, name: "Alpha" },
		{ id: PROJECT_B, name: "Beta" },
	];

	it("gives every project that owns traffic its own district, plus one quiet band", () => {
		const { districts, machines } = strataScene({
			nodes: [a, b, silent, other].map(node),
			projects,
			records: [
				record({ toTaskId: "task-2" }),
				record({ toTaskId: "task-4", toProjectId: PROJECT_B, fromTaskId: "task-1" }),
			],
			cursorAt: null,
		});
		expect(districts.map((d) => d.id)).toEqual([PROJECT_A, PROJECT_B, "__quiet__"]);
		expect(districts.find((d) => d.quiet)?.taskCount).toBe(1);
		// The silent card is placed, not dropped: it is still on the board.
		expect(machines.find((m) => m.node.id === "task-3")?.districtId).toBe("__quiet__");
		expect(machines).toHaveLength(4);
	});

	it("keeps the quiet band out of the project hue rotation", () => {
		const { districts } = strataScene({
			nodes: [a, silent].map(node),
			projects,
			records: [record({ toTaskId: "task-1", fromTaskId: "task-9" })],
			cursorAt: null,
		});
		const quiet = districts.find((d) => d.quiet);
		const project = districts.find((d) => !d.quiet);
		expect(quiet?.color).not.toBe(project?.color);
	});

	it("places every card at a position that does not move between builds", () => {
		const input = {
			nodes: [a, b, silent, other].map(node),
			projects,
			records: [record({ toTaskId: "task-2" })],
			cursorAt: null,
		};
		const first = strataScene(input).machines.map((m) => m.pos);
		const second = strataScene(input).machines.map((m) => m.pos);
		expect(second).toEqual(first);
	});

	it("shapes a machine from the recorded task type and nothing else", () => {
		const { machines } = strataScene({
			nodes: [
				node(task({ seq: 1, id: "task-1", taskType: "coordinator" })),
				node(task({ seq: 2, id: "task-2", taskType: "pr-review" })),
				node(task({ seq: 3, id: "task-3" })),
			],
			projects,
			records: [
				record({ toTaskId: "task-1", fromTaskId: "task-2" }),
				record({ toTaskId: "task-3", fromTaskId: "task-1" }),
			],
			cursorAt: null,
		});
		const roles = new Map(machines.map((m) => [m.node.id, m.role]));
		expect(roles.get("task-1")).toBe("coordinator");
		expect(roles.get("task-2")).toBe("reviewer");
		// No `taskType` at all is the ordinary case on a real board — there is no
		// "standard" member to set — and it must read as a worker.
		expect(roles.get("task-3")).toBe("worker");
	});
});

describe("strataScene history projection", () => {
	const projects = [{ id: PROJECT_A, name: "Alpha" }];

	it("renders a card with no movements as NOT KNOWN, never as its live status", () => {
		const live = task({ seq: 1, id: "task-1", status: "completed" });
		const { machines } = strataScene({
			nodes: [node(live)],
			projects,
			records: [record({ toTaskId: "task-1", fromTaskId: "task-9" })],
			cursorAt: NOW - 60_000,
		});
		expect(machines[0].status).toBeNull();
		expect(machines[0].projection.confidence).toBe("unrecorded");
	});

	it("marks a card the cursor proves did not exist yet, and still keeps its slot", () => {
		const born = task({
			seq: 1,
			id: "task-1",
			movements: [movement({ at: at(30), kind: "created", to: "todo" })],
		});
		const { machines } = strataScene({
			nodes: [node(born)],
			projects,
			records: [record({ toTaskId: "task-1", fromTaskId: "task-9", at: at(90) })],
			cursorAt: NOW - 90 * 60_000,
		});
		expect(machines).toHaveLength(1);
		expect(machines[0].unborn).toBe(true);
	});

	it("flags a card an inbound message never reached, but only at or before the cursor", () => {
		const target = task({ seq: 1, id: "task-1" });
		const rows = [
			record({ toTaskId: "task-1", fromTaskId: "task-9", at: at(10), status: "not-delivered" }),
		];
		const before = strataScene({
			nodes: [node(target)],
			projects,
			records: rows,
			cursorAt: NOW - 40 * 60_000,
		});
		const after = strataScene({
			nodes: [node(target)],
			projects,
			records: rows,
			cursorAt: NOW - 5 * 60_000,
		});
		expect(before.machines[0].undelivered).toBe(false);
		expect(after.machines[0].undelivered).toBe(true);
	});
});

describe("recordedStages", () => {
	it("counts distinct recorded statuses, capped at three", () => {
		const many = task({
			seq: 1,
			movements: [
				movement({ at: at(90), kind: "created", to: "todo" }),
				movement({ at: at(80), to: "in-progress" }),
				movement({ at: at(70), to: "review-by-ai" }),
				movement({ at: at(60), to: "review-by-user" }),
			],
		});
		expect(recordedStages(node(many), null)).toBe(3);
	});

	it("ignores movements after the cursor, so scrubbing back removes shelves", () => {
		const staged = task({
			seq: 1,
			movements: [
				movement({ at: at(90), kind: "created", to: "todo" }),
				movement({ at: at(20), to: "in-progress" }),
			],
		});
		expect(recordedStages(node(staged), NOW - 50 * 60_000)).toBe(1);
		expect(recordedStages(node(staged), NOW)).toBe(2);
	});

	it("counts a repeated status once — it is evidence, not a progress bar", () => {
		const pingpong = task({
			seq: 1,
			movements: [
				movement({ at: at(90), kind: "created", to: "todo" }),
				movement({ at: at(80), to: "in-progress" }),
				movement({ at: at(70), to: "todo" }),
				movement({ at: at(60), to: "in-progress" }),
			],
		});
		expect(recordedStages(node(pingpong), null)).toBe(2);
	});

	it("gives a card with no movements no shelves at all", () => {
		expect(recordedStages(node(task({ seq: 1 })), null)).toBe(0);
	});
});

describe("routeKindOf", () => {
	it("reads the kind straight off the recorded verdict", () => {
		const row = (status: AgentMessageLogRow["status"]) =>
			record({ toTaskId: "task-1", status }).row;
		expect(routeKindOf(row("delivered"), NOW)).toBe("delivered");
		expect(routeKindOf(row("not-delivered"), NOW)).toBe("failed");
		expect(routeKindOf(row("held"), NOW)).toBe("held");
		expect(routeKindOf(row("unconfirmed"), NOW)).toBe("held");
	});

	it("calls a scheduled row queued only while its time is still ahead", () => {
		const pending = record({
			toTaskId: "task-1",
			kind: "scheduled",
			scheduledFor: new Date(NOW + 10 * 60_000).toISOString(),
		}).row;
		const due = record({
			toTaskId: "task-1",
			kind: "scheduled",
			scheduledFor: new Date(NOW - 10 * 60_000).toISOString(),
		}).row;
		expect(routeKindOf(pending, NOW)).toBe("queued");
		expect(routeKindOf(due, NOW)).toBe("delivered");
	});
});

describe("strataRoutes", () => {
	const rows = [
		record({ toTaskId: "task-2", fromTaskId: "task-1", at: at(50) }),
		record({ toTaskId: "task-3", fromTaskId: "task-1", at: at(40) }),
		record({ toTaskId: "task-4", fromTaskId: "task-1", at: at(30), status: "held" }),
		record({ toTaskId: "task-5", fromTaskId: "task-1", at: at(20), status: "not-delivered" }),
	];

	it("keeps only what has not landed in waiting mode", () => {
		const kinds = strataRoutes(rows, "waiting", NOW).map((route) => route.kind).sort();
		expect(kinds).toEqual(["failed", "held"]);
	});

	it("draws every recorded attempt in traffic mode", () => {
		expect(strataRoutes(rows, "traffic", NOW)).toHaveLength(4);
	});

	it("keeps every unlanded route in situation mode and only the tail of deliveries", () => {
		const routes = strataRoutes(rows, "situation", NOW, 1);
		const kinds = routes.map((route) => route.kind);
		expect(kinds).toContain("failed");
		expect(kinds).toContain("held");
		expect(kinds.filter((kind) => kind === "delivered")).toHaveLength(1);
	});

	it("collapses repeats of one pair-and-kind into a counted route", () => {
		const repeated = [
			record({ toTaskId: "task-2", fromTaskId: "task-1", at: at(50) }),
			record({ toTaskId: "task-2", fromTaskId: "task-1", at: at(40) }),
		];
		const routes = strataRoutes(repeated, "traffic", NOW);
		expect(routes).toHaveLength(1);
		expect(routes[0].count).toBe(2);
		// The newest record wins, so the callout names the latest attempt.
		expect(routes[0].record.row.at).toBe(at(40));
	});

	it("draws no route for a row with no sender task", () => {
		const senderless = [
			record({ toTaskId: "task-2", fromTaskId: null, fromSeq: null }),
		];
		expect(strataRoutes(senderless, "traffic", NOW)).toHaveLength(0);
	});

	it("draws no route for a row a task sent to itself", () => {
		const selfSend = [record({ toTaskId: "task-1", fromTaskId: "task-1" })];
		expect(strataRoutes(selfSend, "traffic", NOW)).toHaveLength(0);
	});
});

describe("strataSummary", () => {
	it("counts unlanded traffic by kind and measures the window it actually saw", () => {
		const rows = [
			record({ toTaskId: "task-2", fromTaskId: "task-1", at: at(45) }),
			record({ toTaskId: "task-3", fromTaskId: "task-1", at: at(30), status: "held" }),
			record({ toTaskId: "task-4", fromTaskId: "task-1", at: at(20), status: "not-delivered" }),
			record({
				toTaskId: "task-5",
				fromTaskId: "task-1",
				at: at(10),
				kind: "scheduled",
				scheduledFor: new Date(NOW + 5 * 60_000).toISOString(),
			}),
		];
		const summary = strataSummary({
			records: rows,
			machines: [],
			now: NOW,
			windowStart: NOW - 60 * 60_000,
		});
		expect(summary.events).toBe(4);
		expect(summary.held).toBe(1);
		expect(summary.undelivered).toBe(1);
		expect(summary.queued).toBe(1);
		// 45 minutes of actual traffic, not the 60-minute window it was asked for.
		expect(Math.round(summary.spanMs / 60_000)).toBe(45);
	});

	it("reports an empty window as zero rather than inventing a span", () => {
		const summary = strataSummary({
			records: [],
			machines: [],
			now: NOW,
			windowStart: NOW - 3_600_000,
		});
		expect(summary.events).toBe(0);
		expect(summary.spanMs).toBe(0);
	});
});
