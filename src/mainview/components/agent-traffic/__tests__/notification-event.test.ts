import { describe, expect, it } from "vitest";
import type { NotificationLogRow } from "../../../../shared/notification-log";
import {
	NOTIFICATION_LEVELS,
	notificationCounts,
	notificationEvents,
	notificationLevelKey,
	notificationPassesLevels,
	notificationTimelineEvents,
	notificationsAt,
} from "../notification-event";

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

	describe("stable identity", () => {
		// The page arrives newest-first and is truncated at `limit` from the OLD end,
		// so every one of these is a different way for a key to move.
		const twin = notification({ message: "identical twin" });

		it("re-reading the same page yields the same keys", () => {
			const page = newestFirst(
				notification({ at: "2026-09-07T09:00:00.000Z" }),
				twin,
				twin,
				notification({ at: "2026-09-07T12:00:00.000Z" }),
			);
			expect(notificationEvents(page).map(event => event.key))
				.toEqual(notificationEvents([...page]).map(event => event.key));
		});

		it("does not collapse two identical notifications into one", () => {
			const events = notificationEvents([twin, twin, twin]);
			expect(events).toHaveLength(3);
			expect(new Set(events.map(event => event.key)).size).toBe(3);
		});

		it("a newer row prepended by a live append renumbers nothing", () => {
			const before = notificationEvents([twin, twin]).map(event => event.key);
			const after = notificationEvents([notification({ at: "2026-09-08T10:00:00.000Z" }), twin, twin]);
			// The two twins keep their keys; only the arrival is new.
			expect(after.slice(0, 2).map(event => event.key)).toEqual(before);
		});

		it("a longer page revealing an OLDER identical row renumbers nothing", () => {
			// This is the case a page-relative index gets wrong: the short page held two
			// twins, `load more` reveals a third, older one.
			const shortPage = notificationEvents([twin, twin]).map(event => event.key);
			const longPage = notificationEvents([twin, twin, twin]).map(event => event.key);
			expect(longPage.slice(1)).toEqual(shortPage);
		});

		it("keys stay unique across a page that mixes twins with ordinary rows", () => {
			const events = notificationEvents(newestFirst(
				notification({ at: "2026-09-07T08:00:00.000Z" }),
				twin,
				notification({ at: "2026-09-07T10:00:00.000Z" }),
				twin,
				twin,
			));
			expect(new Set(events.map(event => event.key)).size).toBe(events.length);
		});
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

	describe("a live cursor (at === null)", () => {
		it("shows the newest events, measured back from the newest one", () => {
			// Not from wall-clock time: an archive whose last row is hours old would
			// otherwise render an empty live view.
			expect(notificationsAt(events, null, { windowMs: 90 * 60_000 }).map(e => e.row.message))
				.toEqual(["11:00", "10:00"]);
		});

		it("shows nothing when there is nothing recorded", () => {
			expect(notificationsAt([], null)).toEqual([]);
		});

		it("agrees with parking the cursor on the newest event", () => {
			const newest = events[events.length - 1].at;
			expect(notificationsAt(events, null).map(e => e.key)).toEqual(notificationsAt(events, newest).map(e => e.key));
		});
	});
});

describe("the notification arm handed to the shared timeline", () => {
	// The union, its KIND_RANK and the merge belong to the cursor's owner
	// (traffic-timeline.ts). What this module owes is one well-formed arm.
	it("stamps the kind, the time and a namespaced key on every arm", () => {
		const arms = notificationTimelineEvents(notificationEvents(newestFirst(
			notification({ at: "2026-09-07T09:00:00.000Z" }),
			notification({ at: "2026-09-07T11:00:00.000Z" }),
		)));
		expect(arms.map(arm => arm.kind)).toEqual(["notification", "notification"]);
		expect(arms.map(arm => arm.at)).toEqual([
			Date.parse("2026-09-07T09:00:00.000Z"),
			Date.parse("2026-09-07T11:00:00.000Z"),
		]);
		for (const arm of arms) expect(arm.key.startsWith("notification:")).toBe(true);
	});

	it("hands the arms over oldest first, so a merge does not have to reorder them", () => {
		const arms = notificationTimelineEvents(notificationEvents(newestFirst(
			notification({ at: "2026-09-07T09:00:00.000Z" }),
			notification({ at: "2026-09-07T11:00:00.000Z" }),
		)));
		expect(arms.map(arm => arm.at)).toEqual([...arms.map(arm => arm.at)].sort((a, b) => a - b));
	});

	it("keeps the event object identical to what the normalizer produced", () => {
		const events = notificationEvents([notification()]);
		expect(notificationTimelineEvents(events)[0].event).toBe(events[0]);
	});
});

describe("the level axis and the counts", () => {
	const mixed = notificationEvents(newestFirst(
		notification({ at: "2026-09-07T09:00:00.000Z", level: "info", outcome: "delivered" }),
		notification({ at: "2026-09-07T10:00:00.000Z", level: "error", outcome: "queued", suppressedBy: ["focusMode"] }),
		notification({ at: "2026-09-07T11:00:00.000Z", level: "success", outcome: "no-window" }),
		notification({ at: "2026-09-07T12:00:00.000Z", level: "error", outcome: "delivered" }),
	));

	it("passes an event only when its level is in the set", () => {
		const errors = new Set<"info" | "success" | "error">(["error"]);
		expect(mixed.filter(event => notificationPassesLevels(event, errors)).map(event => event.level))
			.toEqual(["error", "error"]);
	});

	it("an EMPTY set hides every notification — it is not the same as no filter", () => {
		expect(mixed.filter(event => notificationPassesLevels(event, new Set()))).toEqual([]);
	});

	it("all three levels present is the show-everything default", () => {
		expect(mixed.filter(event => notificationPassesLevels(event, new Set(NOTIFICATION_LEVELS)))).toHaveLength(4);
	});

	it("lists the levels worst news first, and every level exactly once", () => {
		expect(NOTIFICATION_LEVELS).toEqual(["error", "success", "info"]);
		expect(new Set(NOTIFICATION_LEVELS).size).toBe(NOTIFICATION_LEVELS.length);
	});

	it("names a level's label key, so a control and a cloud cannot disagree", () => {
		expect(NOTIFICATION_LEVELS.map(notificationLevelKey))
			.toEqual(["traffic.notification.level.error", "traffic.notification.level.success", "traffic.notification.level.info"]);
	});

	it("counts notifications only, split by level and by outcome", () => {
		const counts = notificationCounts(mixed);
		expect(counts.total).toBe(4);
		expect(counts.byLevel).toEqual({ error: 2, success: 1, info: 1 });
		expect(counts.byOutcome).toEqual({ delivered: 2, queued: 1, "no-window": 1 });
	});

	it("counts what the user may never have seen: everything not delivered", () => {
		expect(notificationCounts(mixed).neverSeen).toBe(2);
	});

	it("counts nothing as zeroes rather than as absent keys", () => {
		const counts = notificationCounts([]);
		expect(counts.total).toBe(0);
		expect(counts.byLevel).toEqual({ error: 0, success: 0, info: 0 });
		expect(counts.byOutcome).toEqual({ delivered: 0, queued: 0, "no-window": 0 });
		expect(counts.neverSeen).toBe(0);
	});
});
