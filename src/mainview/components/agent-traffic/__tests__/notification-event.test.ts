import { describe, expect, it } from "vitest";
import type { NotificationLogRow } from "../../../../shared/notification-log";
import type { AgentMessageLogRow } from "../../../../shared/agent-message-log";
import {
	TIMELINE_KIND_RANK,
	mergeTrafficTimeline,
	notificationEvents,
	notificationTimelineEvents,
	notificationsAt,
	type TrafficTimelineEvent,
} from "../notification-event";
import { trafficRecords } from "../traffic-model";

function notification(overrides: Partial<NotificationLogRow> = {}): NotificationLogRow {
	return {
		v: 1,
		at: "2026-09-07T10:00:00.000Z",
		mode: "toast",
		level: "info",
		message: "build green",
		taskId: "task-a",
		taskSeq: 11,
		taskTitle: "Task A as it was named then",
		projectId: "proj-1",
		sourceTaskId: "task-a",
		sourceSeq: 11,
		sourceProjectId: "proj-1",
		outcome: "delivered",
		...overrides,
	};
}

/** The reader returns newest first, so tests feed events in that order too. */
const newestFirst = (...rows: NotificationLogRow[]) => [...rows].reverse();

describe("notificationEvents", () => {
	it("returns events oldest first with the row kept verbatim", () => {
		const events = notificationEvents(newestFirst(
			notification({ at: "2026-09-07T09:00:00.000Z", message: "first" }),
			notification({ at: "2026-09-07T11:00:00.000Z", message: "second" }),
		));
		expect(events.map(event => event.row.message)).toEqual(["first", "second"]);
		expect(events[0].at).toBe(Date.parse("2026-09-07T09:00:00.000Z"));
	});

	it("keeps both ends when the notification was addressed at another task", () => {
		const [event] = notificationEvents([notification({
			taskId: "task-b", taskSeq: 22, taskTitle: "Task B",
			sourceTaskId: "task-a", sourceSeq: 11, sourceTitle: "Task A",
		})]);
		expect(event.target).toEqual({ projectId: "proj-1", taskId: "task-b", seq: 22, title: "Task B" });
		expect(event.origin).toEqual({ projectId: "proj-1", taskId: "task-a", seq: 11, title: "Task A" });
		expect(event.crossAddressed).toBe(true);
	});

	it("does not call a notification cross-addressed when both ends are the same card", () => {
		expect(notificationEvents([notification()])[0].crossAddressed).toBe(false);
	});

	it("invents no sender and no card when the archive recorded none", () => {
		const [event] = notificationEvents([notification({
			taskId: null, taskSeq: null, taskTitle: undefined, projectId: null,
			sourceTaskId: null, sourceSeq: null, sourceProjectId: undefined,
		})]);
		expect(event.target).toBeNull();
		expect(event.origin).toBeNull();
		expect(event.crossAddressed).toBe(false);
	});

	it("keeps a target the board no longer has, rather than dropping the anchor", () => {
		const [event] = notificationEvents([notification({ taskId: "deleted-task", taskSeq: 99 })]);
		expect(event.target?.taskId).toBe("deleted-task");
	});

	it("carries suppression only on a queued row", () => {
		const queued = notificationEvents([notification({ outcome: "queued", suppressedBy: ["focusMode"] })])[0];
		expect(queued.suppressedBy).toEqual(["focusMode"]);
		// A stray field on a delivered row is data we do not trust: the outcome is
		// what says whether anything held it back.
		const delivered = notificationEvents([notification({ outcome: "delivered", suppressedBy: ["focusMode"] })])[0];
		expect(delivered.suppressedBy).toEqual([]);
	});

	it("drops a row whose timestamp cannot be parsed instead of dating it to 1970", () => {
		const events = notificationEvents(newestFirst(
			notification({ at: "not a date", message: "broken" }),
			notification({ at: "2026-09-07T10:00:00.000Z", message: "real" }),
		));
		expect(events.map(event => event.row.message)).toEqual(["real"]);
	});

	it("gives two identical notifications two distinct keys", () => {
		const events = notificationEvents([notification(), notification()]);
		expect(new Set(events.map(event => event.key)).size).toBe(2);
	});

	it("a prepended row cannot renumber the keys of older ones", () => {
		const old = notification({ message: "same" });
		const before = notificationEvents([old, old]).map(event => event.key);
		const after = notificationEvents([notification({ at: "2026-09-08T10:00:00.000Z" }), old, old]);
		expect(after.slice(0, 2).map(event => event.key)).toEqual(before);
	});
});

describe("notificationsAt", () => {
	const events = notificationEvents(newestFirst(
		notification({ at: "2026-09-07T09:00:00.000Z", message: "09:00" }),
		notification({ at: "2026-09-07T10:00:00.000Z", message: "10:00" }),
		notification({ at: "2026-09-07T11:00:00.000Z", message: "11:00" }),
	));
	const at = (iso: string) => Date.parse(iso);

	it("shows nothing before the first event", () => {
		expect(notificationsAt(events, at("2026-09-07T08:00:00.000Z"))).toEqual([]);
	});

	it("shows an event the moment the cursor reaches it", () => {
		expect(notificationsAt(events, at("2026-09-07T10:00:00.000Z")).map(e => e.row.message)).toEqual(["10:00", "09:00"]);
	});

	it("gives the same answer arriving from either direction, and rewinding hides what came later", () => {
		// Walk the whole span forwards, then the same positions backwards, and
		// compare frame by frame — a cursor that only worked forwards would drift.
		const stops = ["08:00", "09:00", "09:30", "10:00", "11:00", "12:00"]
			.map(clock => at(`2026-09-07T${clock}:00.000Z`));
		const forwards = stops.map(stop => notificationsAt(events, stop).map(e => e.key));
		const backwards = [...stops].reverse().map(stop => notificationsAt(events, stop).map(e => e.key)).reverse();
		expect(backwards).toEqual(forwards);
		expect(notificationsAt(events, at("2026-09-07T09:30:00.000Z")).map(e => e.row.message)).toEqual(["09:00"]);
	});

	it("caps a burst instead of rendering every bubble at once", () => {
		const burst = notificationEvents(newestFirst(
			...[0, 1, 2, 3, 4].map(index => notification({ at: `2026-09-07T12:00:0${index}.000Z`, message: `burst ${index}` })),
		));
		expect(notificationsAt(burst, at("2026-09-07T12:00:04.000Z"), { max: 2 }).map(e => e.row.message))
			.toEqual(["burst 4", "burst 3"]);
	});

	it("forgets an event once it is older than the window", () => {
		expect(notificationsAt(events, at("2026-09-07T11:00:00.000Z"), { windowMs: 30 * 60_000 }).map(e => e.row.message))
			.toEqual(["11:00"]);
	});

	it("returns nothing for a cursor that is not a number", () => {
		expect(notificationsAt(events, Number.NaN)).toEqual([]);
	});
});

describe("mergeTrafficTimeline", () => {
	function message(at: string, subject: string): AgentMessageLogRow {
		return {
			v: 1, at, fromTaskId: "task-a", fromSeq: 11, toTaskId: "task-b", toSeq: 22,
			toProjectId: "proj-1", kind: "immediate", subject, body: subject,
			bodyKind: "text", status: "delivered",
		};
	}

	const messages: TrafficTimelineEvent[] = trafficRecords([message("2026-09-07T10:00:00.000Z", "hello")])
		.map(record => ({ kind: "message" as const, at: Date.parse(record.row.at), key: `message:${record.key}`, record }));
	const notifications = notificationTimelineEvents(notificationEvents([notification({ at: "2026-09-07T10:00:00.000Z" })]));

	it("interleaves kinds by time", () => {
		const merged = mergeTrafficTimeline(
			notificationTimelineEvents(notificationEvents([notification({ at: "2026-09-07T09:00:00.000Z" })])),
			messages,
		);
		expect(merged.map(event => event.kind)).toEqual(["notification", "message"]);
	});

	it("breaks an exact tie by kind, in a fixed order", () => {
		expect(mergeTrafficTimeline(notifications, messages).map(event => event.kind)).toEqual(["message", "notification"]);
		expect(mergeTrafficTimeline(messages, notifications).map(event => event.kind)).toEqual(["message", "notification"]);
		expect(TIMELINE_KIND_RANK.message).toBeLessThan(TIMELINE_KIND_RANK.notification);
	});

	it("is deterministic for two notifications sharing a timestamp", () => {
		const same = notificationTimelineEvents(notificationEvents([
			notification({ at: "2026-09-07T10:00:00.000Z", message: "zulu" }),
			notification({ at: "2026-09-07T10:00:00.000Z", message: "alpha" }),
		]));
		const once = mergeTrafficTimeline(same).map(event => event.key);
		const again = mergeTrafficTimeline([...same].reverse()).map(event => event.key);
		expect(again).toEqual(once);
	});

	it("adds no duplicate when the same stream is merged after a live append", () => {
		const live = notificationTimelineEvents(notificationEvents(newestFirst(
			notification({ at: "2026-09-07T10:00:00.000Z" }),
			notification({ at: "2026-09-07T12:00:00.000Z", message: "just arrived" }),
		)));
		const merged = mergeTrafficTimeline(live, messages);
		expect(new Set(merged.map(event => event.key)).size).toBe(merged.length);
		expect(merged).toHaveLength(3);
	});
});
