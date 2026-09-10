import { describe, expect, it } from "vitest";
import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import type { Task, TaskMovement, TaskStatus } from "../../shared/types";
import type { TrafficRecord } from "../components/agent-traffic/traffic-model";
import {
	buildTimeline,
	indexAtOrAfter,
	messageAt,
	messageEvents,
	notificationTimelineEvents,
	sortTimeline,
	taskEvents,
	TIMELINE_KIND_RANK,
	type TrafficTimelineEvent,
} from "../components/agent-traffic/traffic-timeline";
import { notificationEvents } from "../notification-event";
import type { NotificationLogRow } from "../../shared/notification-log";

const T0 = Date.parse("2026-09-08T12:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const ms = (minutes: number) => T0 + minutes * 60_000;
const WINDOW = { start: T0, end: T0 + 60 * 60_000 };

let ids = 0;
const created = (minutes: number, to: TaskStatus): TaskMovement => ({
	id: `mv${++ids}`, at: at(minutes), kind: "created", to, toColumnId: null,
});
const moved = (minutes: number, from: TaskStatus, to: TaskStatus): TaskMovement => ({
	id: `mv${++ids}`, at: at(minutes), kind: "status", from, to, fromColumnId: null, toColumnId: null,
});
const task = (id: string, seq: number, movements: TaskMovement[], over: Partial<Task> = {}): Task =>
	({ id, projectId: "p", seq, title: `Task ${seq}`, description: "", status: "in-progress", movements, ...over }) as Task;

const record = (key: string, minutes: number, over: Partial<AgentMessageLogRow> = {}): TrafficRecord => ({
	key,
	row: {
		v: 1, at: at(minutes), fromTaskId: "a", fromSeq: 1, toTaskId: "b", toSeq: 2,
		toProjectId: "p", kind: "immediate", body: key, bodyKind: "text", status: "delivered", ...over,
	} as AgentMessageLogRow,
});

// Rows arrive newest first, exactly as the reader returns them.
const notifyRow = (minutes: number, over: Partial<NotificationLogRow> = {}): NotificationLogRow => ({
	v: 1, at: at(minutes), mode: "toast", level: "info", message: `notify ${minutes}`,
	taskId: "b", taskSeq: 2, projectId: "p", sourceTaskId: "a", sourceSeq: 1,
	outcome: "delivered", ...over,
});
const notifications = (rows: NotificationLogRow[]) =>
	notificationEvents([...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));

const shape = (events: TrafficTimelineEvent[]) =>
	events.map((event) => `${event.at - T0}:${event.kind}`);

describe("timeline assembly", () => {
	it("advances on a board movement in an interval with no messages at all", () => {
		const timeline = buildTimeline({
			records: [],
			tasks: [task("t1", 11, [created(5, "todo"), moved(20, "todo", "in-progress")])],
			...WINDOW,
		});
		// The whole point: an hour of board activity and nothing said still has steps.
		expect(shape(timeline)).toEqual(["300000:task", "1200000:task"]);
	});

	it("interleaves both kinds by time", () => {
		const timeline = buildTimeline({
			records: [record("m-late", 30), record("m-early", 10)],
			tasks: [task("t1", 11, [created(5, "todo"), moved(45, "todo", "completed")])],
			...WINDOW,
		});
		expect(shape(timeline)).toEqual([
			"300000:task", "600000:message", "1800000:message", "2700000:task",
		]);
	});

	it("puts a task creation before a message at the SAME instant", () => {
		const timeline = buildTimeline({
			records: [record("m", 7)],
			tasks: [task("t1", 11, [created(7, "todo")])],
			...WINDOW,
		});
		// A message must never land on a card that has not appeared yet.
		expect(timeline.map((event) => event.kind)).toEqual(["task", "message"]);
		expect(TIMELINE_KIND_RANK).toEqual({ task: 0, message: 1, notification: 2 });
	});

	it("is stable and total: the same input always gives the same sequence", () => {
		const events = [
			...taskEvents([task("t1", 11, [created(5, "todo")])], WINDOW.start, WINDOW.end),
			...messageEvents([record("z", 5), record("y", 5)]),
		];
		const once = sortTimeline(events).map((event) => event.key);
		const again = sortTimeline([...events].reverse()).map((event) => event.key);
		expect(again).toEqual(once);
		// Kinds grouped, keys ordered inside a kind — nothing left to chance.
		expect(once).toEqual([
			"task:p:t1:mv" + once[0].split("mv")[1],
			"message:y", "message:z",
		]);
	});

	it("clips both arms to the same window and never coerces a bad instant to 0", () => {
		const timeline = buildTimeline({
			records: [record("before", -5), record("inside", 10), record("after", 90)],
			tasks: [
				task("t1", 11, [created(-30, "todo"), moved(15, "todo", "in-progress"), moved(120, "in-progress", "completed")]),
				task("t2", 12, [{ id: "bad", at: "not a date", kind: "created", to: "todo", toColumnId: null }]),
			],
			...WINDOW,
		});
		expect(shape(timeline)).toEqual(["600000:message", "900000:task"]);
		// A 1970 event would have sorted ahead of everything and looked like the start.
		expect(timeline.every((event) => event.at >= WINDOW.start)).toBe(true);
	});

	it("contributes nothing for a task with no recorded movements", () => {
		const legacy = task("t1", 11, []);
		expect(taskEvents([legacy], WINDOW.start, WINDOW.end)).toEqual([]);
		expect(taskEvents([{ ...legacy, movements: undefined } as Task], WINDOW.start, WINDOW.end)).toEqual([]);
	});

	it("keys a task event by its movement id, so a rebuild never duplicates it", () => {
		const subject = task("t1", 11, [created(5, "todo"), moved(20, "todo", "in-progress")]);
		const once = buildTimeline({ records: [], tasks: [subject], ...WINDOW });
		const twice = buildTimeline({ records: [], tasks: [subject, { ...subject }], ...WINDOW });
		expect(new Set(twice.map((event) => event.key)).size).toBe(once.length);
	});

	it("carries the card identity a consumer needs without rebuilding the node", () => {
		const [event] = taskEvents([task("t1", 11, [created(5, "todo")])], WINDOW.start, WINDOW.end);
		expect(event).toMatchObject({
			kind: "task", node: { projectId: "p", taskId: "t1" }, seq: 11, title: "Task 11",
		});
		expect(event.nodeKey).toBe(JSON.stringify(["p", "t1"]));
	});
});

describe("notification arm", () => {
	it("gives a notification-only window steps of its own", () => {
		const timeline = buildTimeline({
			records: [],
			tasks: [],
			notifications: notifications([notifyRow(12), notifyRow(40)]),
			...WINDOW,
		});
		// The whole point: nothing moved, nobody wrote, and the hour still replays.
		expect(shape(timeline)).toEqual(["720000:notification", "2400000:notification"]);
	});

	it("interleaves all three kinds by time", () => {
		const timeline = buildTimeline({
			records: [record("m", 20)],
			tasks: [task("t1", 11, [created(5, "todo")])],
			notifications: notifications([notifyRow(35)]),
			...WINDOW,
		});
		expect(shape(timeline)).toEqual([
			"300000:task", "1200000:message", "2100000:notification",
		]);
	});

	it("puts a same-instant notification after the card and the message", () => {
		const timeline = buildTimeline({
			records: [record("m", 7)],
			tasks: [task("t1", 11, [created(7, "todo")])],
			notifications: notifications([notifyRow(7)]),
			...WINDOW,
		});
		expect(timeline.map((event) => event.kind)).toEqual([
			"task", "message", "notification",
		]);
	});

	it("clips to the same window as every other arm", () => {
		const timeline = buildTimeline({
			records: [],
			tasks: [],
			notifications: notifications([notifyRow(-5), notifyRow(30), notifyRow(90)]),
			...WINDOW,
		});
		expect(shape(timeline)).toEqual(["1800000:notification"]);
	});

	it("reuses the normalizer's key and instant instead of minting new ones", () => {
		const [event] = notifications([notifyRow(9)]);
		const [wrapped] = notificationTimelineEvents([event]);
		expect(wrapped).toMatchObject({ kind: "notification", key: event.key, at: event.at });
		expect(wrapped.notification).toBe(event);
	});

	it("does not blank the flying wire while the cursor sits on a notification", () => {
		const timeline = buildTimeline({
			records: [record("m", 10)],
			tasks: [],
			notifications: notifications([notifyRow(20)]),
			...WINDOW,
		});
		expect(messageAt(timeline, 1)?.key).toBe("m");
	});

	it("keeps a window with no notifications byte-identical to before the arm", () => {
		const input = {
			records: [record("m", 10)],
			tasks: [task("t1", 11, [created(5, "todo")])],
			...WINDOW,
		};
		expect(buildTimeline(input)).toEqual(
			buildTimeline({ ...input, notifications: [] }),
		);
	});
});

describe("messageAt", () => {
	const timeline = buildTimeline({
		records: [record("m1", 10), record("m2", 30)],
		tasks: [task("t1", 11, [created(5, "todo"), moved(20, "todo", "in-progress"), moved(50, "in-progress", "completed")])],
		...WINDOW,
	});
	// task(5) message(10) task(20) message(30) task(50)

	it("holds the last message across a task-only step instead of blanking the wire", () => {
		expect(messageAt(timeline, 1)?.key).toBe("m1");
		expect(messageAt(timeline, 2)?.key).toBe("m1");
		expect(messageAt(timeline, 4)?.key).toBe("m2");
	});

	it("lights nothing before the first message", () => {
		expect(messageAt(timeline, 0)).toBeNull();
	});
});

describe("indexAtOrAfter", () => {
	const timeline = buildTimeline({
		records: [record("m", 30)],
		tasks: [task("t1", 11, [created(10, "todo")])],
		...WINDOW,
	});

	it("lands on the first event at or after the time — the entry range", () => {
		expect(indexAtOrAfter(timeline, ms(0))).toBe(0);
		expect(indexAtOrAfter(timeline, ms(10))).toBe(0);
		expect(indexAtOrAfter(timeline, ms(11))).toBe(1);
		expect(indexAtOrAfter(timeline, ms(30))).toBe(1);
	});

	it("reports nothing rather than silently starting at the top", () => {
		expect(indexAtOrAfter(timeline, ms(31))).toBe(-1);
		expect(indexAtOrAfter([], ms(0))).toBe(-1);
	});
});
