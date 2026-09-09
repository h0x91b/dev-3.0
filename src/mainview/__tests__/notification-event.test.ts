import { describe, expect, it } from "vitest";
import type { NotificationLogRow } from "../../shared/notification-log";
import { notificationEvents } from "../notification-event";

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

describe("a notification with no task and no project", () => {
	// Reported from combined QA as "the project allowlist drops project-less rows,
	// so a notification sent without a task is invisible". The reader disproves it
	// on disk (notification-log-read.test.ts: an allowlist always keeps a row with
	// no project, and an EMPTY allowlist keeps exactly those). This is the other
	// half: normalization must not drop it either, so whatever swallowed it lives
	// downstream of both.
	const rows = [
		notification({
			level: "error",
			message: "sent from a plain shell",
			taskId: null, taskSeq: null, taskTitle: undefined,
			projectId: null,
			sourceTaskId: null, sourceSeq: null, sourceTitle: undefined, sourceProjectId: undefined,
		}),
	];

	it("survives normalization with both endpoints null, rather than being dropped", () => {
		const [event] = notificationEvents(rows);
		expect(event).toBeDefined();
		expect(event.target).toBeNull();
		expect(event.origin).toBeNull();
		expect(event.crossAddressed).toBe(false);
	});

});
