import { describe, it, expect } from "vitest";
import {
	DEFAULT_EVENT_WINDOW_MS,
	formatEventCursor,
	normalizeEventInstant,
	parseEventCursor,
	selectEvents,
	type BoardEvent,
} from "../../shared/board-events";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");

function event(at: string, id: string, overrides?: Partial<BoardEvent>): BoardEvent {
	return {
		kind: "note",
		at,
		id,
		projectId: "proj-1",
		projectName: "dev-3.0",
		taskId: `task-${id}`,
		seq: 1,
		taskTitle: "Some task",
		taskStatus: "completed",
		source: "ai",
		text: `note ${id}`,
		...overrides,
	};
}

describe("parseEventCursor", () => {
	it("accepts the printed <iso>.<id8> form", () => {
		expect(parseEventCursor("2026-08-29T10:12:03.114Z.86b9b644")).toEqual({
			at: "2026-08-29T10:12:03.114Z",
			id: "86b9b644",
		});
	});

	it("accepts a bare ISO instant as the wider form", () => {
		expect(parseEventCursor("2026-08-01T00:00:00Z")).toEqual({
			at: "2026-08-01T00:00:00.000Z",
			id: null,
		});
	});

	it("rejects durations, prose and half-cursors instead of guessing", () => {
		for (const bad of ["2h", "yesterday", "", "   ", "2026-08-29", "2026-08-29T10:12:03.114Z.86b9", "2026-08-29T10:12:03.114Z.zzzzzzzz", "86b9b644"]) {
			expect(parseEventCursor(bad), bad).toBeNull();
		}
	});

	it("round-trips a formatted cursor", () => {
		const e = event("2026-08-29T10:12:03.114Z", "86B9B644-1111-2222-3333-444444444444");
		expect(formatEventCursor(e)).toBe("2026-08-29T10:12:03.114Z.86b9b644");
		expect(parseEventCursor(formatEventCursor(e))).toEqual({ at: e.at, id: "86b9b644" });
	});
});

describe("normalizeEventInstant", () => {
	it("normalises a second-precision timestamp so lexicographic sorting is honest", () => {
		expect(normalizeEventInstant("2026-03-02T10:00:00Z")).toBe("2026-03-02T10:00:00.000Z");
	});

	it("returns null for junk rather than 1970", () => {
		expect(normalizeEventInstant("not a date")).toBeNull();
		expect(normalizeEventInstant(undefined)).toBeNull();
	});
});

describe("selectEvents — the cursor advances", () => {
	const all = [
		event("2026-08-29T09:00:00.000Z", "aaaaaaaa"),
		event("2026-08-29T10:00:00.000Z", "bbbbbbbb"),
		event("2026-08-29T11:00:00.000Z", "cccccccc"),
	];

	it("returns everything in the window, oldest first", () => {
		const first = selectEvents(all, { cursor: null, limit: 100, now: NOW });
		expect(first.events.map((e) => e.id)).toEqual(["aaaaaaaa", "bbbbbbbb", "cccccccc"]);
		expect(first.cursor).toBe("2026-08-29T11:00:00.000Z.cccccccc");
	});

	it("returns NOTHING on a second read from the cursor the first read printed", () => {
		const first = selectEvents(all, { cursor: null, limit: 100, now: NOW });
		const second = selectEvents(all, { cursor: parseEventCursor(first.cursor!), limit: 100, now: NOW });
		expect(second.events).toEqual([]);
		expect(second.matched).toBe(0);
		expect(second.cursor).toBeNull();
	});

	it("returns exactly the new event once one is added after that cursor", () => {
		const first = selectEvents(all, { cursor: null, limit: 100, now: NOW });
		const fresh = event("2026-08-29T11:30:00.000Z", "dddddddd");
		const third = selectEvents([...all, fresh], { cursor: parseEventCursor(first.cursor!), limit: 100, now: NOW });
		expect(third.events.map((e) => e.id)).toEqual(["dddddddd"]);
		expect(third.cursor).toBe("2026-08-29T11:30:00.000Z.dddddddd");
	});

	it("breaks a same-instant tie by id so the cursor never re-reads or skips", () => {
		const tied = [
			event("2026-08-29T10:00:00.000Z", "11111111"),
			event("2026-08-29T10:00:00.000Z", "22222222"),
		];
		const first = selectEvents(tied, { cursor: null, limit: 1, now: NOW });
		expect(first.events.map((e) => e.id)).toEqual(["11111111"]);
		const second = selectEvents(tied, { cursor: parseEventCursor(first.cursor!), limit: 10, now: NOW });
		expect(second.events.map((e) => e.id)).toEqual(["22222222"]);
	});

	it("is idempotent — the same cursor gives the same answer", () => {
		const cursor = parseEventCursor("2026-08-29T09:00:00.000Z.aaaaaaaa");
		const a = selectEvents(all, { cursor, limit: 100, now: NOW });
		const b = selectEvents(all, { cursor, limit: 100, now: NOW });
		expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
		expect(a.events.map((e) => e.id)).toEqual(["bbbbbbbb", "cccccccc"]);
	});
});

describe("selectEvents — the cap is counted, never silent", () => {
	const many = Array.from({ length: 25 }, (_, i) =>
		event(`2026-08-29T${String(i).padStart(2, "0")}:00:00.000Z`, `e${String(i).padStart(7, "0")}`));

	it("keeps the OLDEST matches so continuing from the cursor leaves no hole", () => {
		const capped = selectEvents(many, { cursor: null, limit: 10, now: NOW });
		expect(capped.events).toHaveLength(10);
		expect(capped.events[0].id).toBe("e0000000");
		expect(capped.droppedNewer).toBe(15);
		expect(capped.matched).toBe(25);

		const rest = selectEvents(many, { cursor: parseEventCursor(capped.cursor!), limit: 100, now: NOW });
		expect(rest.events).toHaveLength(15);
		expect(rest.events[0].id).toBe("e0000010");
	});
});

describe("selectEvents — the bare window reports what it cut off", () => {
	it("counts events older than the window as a number", () => {
		const inside = Array.from({ length: 3 }, (_, i) => event(`2026-08-29T0${i}:00:00.000Z`, `n${i}`));
		const outside = Array.from({ length: 7 }, (_, i) => event(`2026-08-01T0${i}:00:00.000Z`, `o${i}`));
		const sel = selectEvents([...inside, ...outside], { cursor: null, limit: 100, now: NOW });
		expect(sel.events).toHaveLength(3);
		expect(sel.olderThanWindow).toBe(7);
	});

	it("uses a 24h window by default", () => {
		const justInside = event(new Date(NOW - DEFAULT_EVENT_WINDOW_MS + 1000).toISOString(), "inside01");
		const justOutside = event(new Date(NOW - DEFAULT_EVENT_WINDOW_MS - 1000).toISOString(), "outside1");
		const sel = selectEvents([justInside, justOutside], { cursor: null, limit: 100, now: NOW });
		expect(sel.events.map((e) => e.id)).toEqual(["inside01"]);
		expect(sel.olderThanWindow).toBe(1);
	});

	it("does not report a window cut when a cursor was supplied", () => {
		const old = event("2026-01-01T00:00:00.000Z", "ancient1");
		const sel = selectEvents([old], { cursor: parseEventCursor("2025-01-01T00:00:00Z"), limit: 100, now: NOW });
		expect(sel.events.map((e) => e.id)).toEqual(["ancient1"]);
		expect(sel.olderThanWindow).toBe(0);
	});
});
