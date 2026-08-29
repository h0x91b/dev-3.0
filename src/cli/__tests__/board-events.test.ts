import { describe, it, expect } from "vitest";
import {
	DEFAULT_EVENT_WINDOW_MS,
	formatEventCursor,
	isEventIdPrefix,
	normalizeEventInstant,
	parseEventCursor,
	resolveEventIdPrefix,
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
	it("accepts the printed cursor — an instant to the millisecond, no Z, no id half", () => {
		expect(parseEventCursor("2026-08-29T10:12:03.114")).toBe("2026-08-29T10:12:03.114Z");
	});

	it("still accepts the same instant written with a Z or without milliseconds", () => {
		expect(parseEventCursor("2026-08-29T10:12:03.114Z")).toBe("2026-08-29T10:12:03.114Z");
		expect(parseEventCursor("2026-08-29T10:12:03")).toBe("2026-08-29T10:12:03.000Z");
	});

	it("accepts a plain date as the wider sweep form", () => {
		expect(parseEventCursor("2026-08-01")).toBe("2026-08-01T00:00:00.000Z");
	});

	it("accepts a duration back from now", () => {
		expect(parseEventCursor("2h", NOW)).toBe("2026-08-29T10:00:00.000Z");
		expect(parseEventCursor("30m", NOW)).toBe("2026-08-29T11:30:00.000Z");
		expect(parseEventCursor("3d", NOW)).toBe("2026-08-26T12:00:00.000Z");
		expect(parseEventCursor("1w", NOW)).toBe("2026-08-22T12:00:00.000Z");
	});

	it("rejects prose, empty input and a zero duration instead of guessing", () => {
		for (const bad of ["yesterday", "", "   ", "0h", "-2h", "2y", "2026-13-01", "86b9b644"]) {
			expect(parseEventCursor(bad, NOW), bad).toBeNull();
		}
	});

	it("round-trips what a run prints back into the instant it points at", () => {
		const e = event("2026-08-29T10:12:03.114Z", "86b9b644");
		expect(formatEventCursor(e)).toBe("2026-08-29T10:12:03.114");
		expect(parseEventCursor(formatEventCursor(e))).toBe(e.at);
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
		expect(first.cursor).toBe("2026-08-29T11:00:00.000");
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
		expect(third.cursor).toBe("2026-08-29T11:30:00.000");
	});

	it("never splits a group sharing one instant, because a cursor cannot address half of it", () => {
		const tied = [
			event("2026-08-29T10:00:00.000Z", "11111111"),
			event("2026-08-29T10:00:00.000Z", "22222222"),
		];
		const first = selectEvents(tied, { cursor: null, limit: 1, now: NOW });
		expect(first.events.map((e) => e.id)).toEqual(["11111111", "22222222"]);
		expect(first.droppedNewer).toBe(0);
		const second = selectEvents(tied, { cursor: parseEventCursor(first.cursor!), limit: 10, now: NOW });
		expect(second.events).toEqual([]);
	});

	it("is idempotent — the same cursor gives the same answer", () => {
		const cursor = parseEventCursor("2026-08-29T09:00:00.000");
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
		const sel = selectEvents([old], { cursor: parseEventCursor("2025-01-01"), limit: 100, now: NOW });
		expect(sel.events.map((e) => e.id)).toEqual(["ancient1"]);
		expect(sel.olderThanWindow).toBe(0);
	});
});

describe("event ids as a cursor", () => {
	const all = [
		event("2026-08-29T09:00:00.000Z", "8eb2da3d-1111-2222-3333-444444444444"),
		event("2026-08-29T10:00:00.000Z", "8eb2ffff-1111-2222-3333-444444444444"),
		event("2026-08-29T11:00:00.000Z", "cafe0001-1111-2222-3333-444444444444"),
	];

	it("recognises a hex id prefix, and nothing that is already an instant or duration", () => {
		expect(isEventIdPrefix("8eb2da3d")).toBe(true);
		expect(isEventIdPrefix("cafe")).toBe(true);
		expect(isEventIdPrefix("2h")).toBe(false);
		expect(isEventIdPrefix("2026-08-01")).toBe(false);
		expect(isEventIdPrefix("abc")).toBe(false);
	});

	it("resolves a full 8-char id to that event's instant", () => {
		expect(resolveEventIdPrefix(all, "cafe0001")).toBe("2026-08-29T11:00:00.000Z");
	});

	it("resolves a shorter prefix when it is unambiguous, ignoring case", () => {
		expect(resolveEventIdPrefix(all, "CAFE")).toBe("2026-08-29T11:00:00.000Z");
	});

	it("refuses an ambiguous prefix and names the candidates", () => {
		expect(() => resolveEventIdPrefix(all, "8eb2")).toThrow(/matches 2 events/);
		expect(() => resolveEventIdPrefix(all, "8eb2")).toThrow(/8eb2da3d/);
	});

	// A vanished id must never be answered with "nothing since then" — that reads
	// as a quiet board when it actually means the position was lost.
	it("refuses an id that resolves to nothing and says why it may be gone", () => {
		expect(() => resolveEventIdPrefix(all, "deadbeef")).toThrow(/no event id starts with/);
		expect(() => resolveEventIdPrefix(all, "deadbeef")).toThrow(/50 most recent/);
	});

	it("continues from the resolved id exactly as from its instant", () => {
		const fromId = selectEvents(all, { cursor: resolveEventIdPrefix(all, "8eb2da3d"), limit: 100, now: NOW });
		const fromInstant = selectEvents(all, { cursor: parseEventCursor("2026-08-29T09:00:00.000"), limit: 100, now: NOW });
		expect(fromId.events.map((e) => e.id)).toEqual(fromInstant.events.map((e) => e.id));
		expect(fromId.events).toHaveLength(2);
	});
});
