import { describe, expect, it } from "vitest";
import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import type { Task, TaskMovement, TaskStatus } from "../../shared/types";
import type { TrafficRecord } from "../components/agent-traffic/traffic-model";
import { buildTimeline } from "../components/agent-traffic/traffic-timeline";
import {
	ACTIVE_PROJECTS,
	ALL_PROJECTS,
	activeProjectIds,
	admits,
	isAggregateScope,
	scopeProjectIds,
} from "../components/agent-traffic/traffic-scope";

const T0 = Date.parse("2026-09-09T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const WINDOW = { start: T0, end: T0 + 60 * 60_000 };

let ids = 0;
const created = (minutes: number, to: TaskStatus): TaskMovement => ({
	id: `mv${++ids}`, at: at(minutes), kind: "created", to, toColumnId: null,
});
const task = (id: string, projectId: string, movements: TaskMovement[], over: Partial<Task> = {}): Task =>
	({ id, projectId, seq: 1, title: id, description: "", status: "in-progress", movements, ...over }) as Task;

const record = (key: string, minutes: number, over: Partial<AgentMessageLogRow> = {}): TrafficRecord => ({
	key,
	row: {
		v: 1, at: at(minutes), fromTaskId: "a", fromSeq: 1, toTaskId: "b", toSeq: 2,
		toProjectId: "p-to", kind: "immediate", body: key, bodyKind: "text", status: "delivered", ...over,
	} as AgentMessageLogRow,
});

const active = (input: { records?: TrafficRecord[]; tasks?: Task[] }) =>
	[...activeProjectIds(buildTimeline({ records: input.records ?? [], tasks: input.tasks ?? [], ...WINDOW }))].sort();

describe("active project membership", () => {
	it("counts both ends of a message, so the sending board is not dropped", () => {
		expect(active({ records: [record("m1", 10, { fromProjectId: "p-from" })] })).toEqual(["p-from", "p-to"]);
	});

	it("counts a recorded movement on its own, with nothing said all window", () => {
		expect(active({ tasks: [task("t1", "p-quiet", [created(20, "todo")])] })).toEqual(["p-quiet"]);
	});

	it("leaves out a project whose only task is a running coordinator that never moved", () => {
		// Existing, running, and a coordinator — none of that is a recorded event.
		const tasks = [task("coord", "p-idle", [], { taskType: "coordinator", runtime: "running" } as Partial<Task>)];
		expect(active({ tasks })).toEqual([]);
	});

	it("keeps a project that has events but no coordinator at all", () => {
		// No coordinator anywhere in this project, and it stays in on its events alone.
		const tasks = [task("t1", "p-plain", [created(5, "todo")], { taskType: null })];
		expect(active({ tasks })).toEqual(["p-plain"]);
	});

	it("ignores events outside the selected window, on either arm", () => {
		expect(active({
			records: [record("early", -30, { toProjectId: "p-early" }), record("late", 120, { toProjectId: "p-late" })],
			tasks: [task("t1", "p-before", [created(-5, "todo")]), task("t2", "p-after", [created(90, "todo")])],
		})).toEqual([]);
	});
});

describe("scope resolution", () => {
	const settled = { active: new Set(["p1"]), settled: true };

	it("leaves All projects entirely unfiltered, even when nothing is active", () => {
		expect(scopeProjectIds({ scope: ALL_PROJECTS, active: new Set(), settled: true })).toBeNull();
	});

	it("narrows All active projects to the recorded set", () => {
		expect(scopeProjectIds({ scope: ACTIVE_PROJECTS, ...settled })).toEqual(new Set(["p1"]));
	});

	it("admits nothing under All active projects when the window is genuinely empty", () => {
		const resolved = scopeProjectIds({ scope: ACTIVE_PROJECTS, active: new Set(), settled: true });
		expect(resolved).toEqual(new Set());
		expect(admits(resolved, "p1")).toBe(false);
	});

	it("admits everything while history is still loading — unread is not inactive", () => {
		expect(scopeProjectIds({ scope: ACTIVE_PROJECTS, active: new Set(), settled: false })).toBeNull();
	});

	it("narrows an explicit project to itself, whatever is active", () => {
		expect(scopeProjectIds({ scope: "p9", ...settled })).toEqual(new Set(["p9"]));
	});
});

describe("admits and aggregate scopes", () => {
	it("passes anything when there is no filter, and rejects an absent id when there is", () => {
		expect(admits(null, undefined)).toBe(true);
		expect(admits(new Set(["p1"]), undefined)).toBe(false);
		expect(admits(new Set(["p1"]), "p1")).toBe(true);
		expect(admits(new Set(["p1"]), "p2")).toBe(false);
	});

	it("treats both all-project scopes as having no lane to pin, a project id as having one", () => {
		expect(isAggregateScope(ALL_PROJECTS)).toBe(true);
		expect(isAggregateScope(ACTIVE_PROJECTS)).toBe(true);
		expect(isAggregateScope(undefined)).toBe(true);
		expect(isAggregateScope("p1")).toBe(false);
	});
});
