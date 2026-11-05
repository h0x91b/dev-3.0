import { describe, expect, it } from "vitest";
import {
	assertLiveName,
	emptyLiveState,
	LIVE_LIMITS,
	LIVE_REV_CONFLICT_PREFIX,
	liveAckEvents,
	liveDeleteDoc,
	liveEmit,
	livePatchDoc,
	liveSetDoc,
	LiveStoreError,
	mergePatch,
	parseLiveState,
	trimLiveEvents,
	type LiveEvent,
} from "../../shared/live-artifact";

const at = (by: "agent" | "user", extra: Record<string, unknown> = {}) => ({ collection: "cards", id: "c1", by, now: 1000, ...extra });

describe("live artifact names", () => {
	it("accepts short slug-like names", () => {
		expect(assertLiveName("collection", "plan:status-2")).toBe("plan:status-2");
	});

	it.each(["", "../etc", "a/b", ".hidden", "x".repeat(65), 42])("rejects %j", (name) => {
		expect(() => assertLiveName("collection", name)).toThrow(LiveStoreError);
	});
});

describe("mergePatch (RFC 7396)", () => {
	it("merges objects recursively and removes null keys", () => {
		expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: 5 })).toEqual({ a: 1, b: { d: 3, e: 4 }, f: 5 });
	});

	it("replaces arrays and scalars wholesale", () => {
		expect(mergePatch({ list: [1, 2] }, { list: [3] })).toEqual({ list: [3] });
		expect(mergePatch({ a: 1 }, "text")).toBe("text");
	});
});

describe("document writes", () => {
	it("bumps the store revision and stamps the document with it", () => {
		const state = emptyLiveState();
		liveSetDoc(state, { ...at("agent"), data: { title: "one" } });
		const change = livePatchDoc(state, { ...at("agent"), patch: { answer: "approve" } });
		expect(change.rev).toBe(2);
		expect(state.collections.cards.c1).toMatchObject({ rev: 2, data: { title: "one", answer: "approve" }, updatedBy: "agent" });
	});

	it("refuses a stale ifRev and leaves the state untouched", () => {
		const state = emptyLiveState();
		liveSetDoc(state, { ...at("agent"), data: { v: 1 } });
		const before = structuredClone(state);
		expect(() => liveSetDoc(state, { ...at("agent", { ifRev: 0 }), data: { v: 2 } })).toThrow(LIVE_REV_CONFLICT_PREFIX);
		expect(state).toEqual(before);
	});

	it("treats ifRev 0 as 'must not exist yet'", () => {
		const state = emptyLiveState();
		expect(() => liveSetDoc(state, { ...at("agent", { ifRev: 0 }), data: 1 })).not.toThrow();
	});

	it("logs user writes as events for the agent, never the agent's own", () => {
		const state = emptyLiveState();
		liveSetDoc(state, { ...at("agent"), data: { v: 1 } });
		livePatchDoc(state, { ...at("user"), patch: { answer: "discuss" } });
		liveDeleteDoc(state, at("user"));
		expect(state.events.map((event) => [event.kind, event.handled])).toEqual([["patch", false], ["delete", false]]);
	});

	it("deleting a missing document changes nothing", () => {
		const state = emptyLiveState();
		expect(liveDeleteDoc(state, at("agent"))).toBeNull();
		expect(state.rev).toBe(0);
	});

	it("refuses an oversized document", () => {
		const state = emptyLiveState();
		expect(() => liveSetDoc(state, { ...at("agent"), data: "x".repeat(LIVE_LIMITS.docBytes) })).toThrow(/max/);
	});
});

describe("events", () => {
	const event = (id: number, handled: boolean): LiveEvent => ({ id, ts: id, kind: "emit", name: "e", handled });

	it("trims handled events before unhandled ones", () => {
		const trimmed = trimLiveEvents([event(1, false), event(2, true), event(3, false), event(4, true)], 2);
		expect(trimmed.map((e) => e.id)).toEqual([1, 3]);
	});

	it("falls back to the oldest unhandled once nothing handled is left", () => {
		expect(trimLiveEvents([event(1, false), event(2, false), event(3, false)], 2).map((e) => e.id)).toEqual([2, 3]);
	});

	it("emits named events and acknowledges them by id or all at once", () => {
		const state = emptyLiveState();
		liveEmit(state, { name: "send", payload: { count: 2 }, now: 1 });
		liveEmit(state, { name: "send", now: 2 });
		expect(liveAckEvents(state, [1])).toBe(1);
		expect(liveAckEvents(state, "all")).toBe(1);
		expect(state.events.every((e) => e.handled)).toBe(true);
	});
});

describe("parseLiveState", () => {
	it("round-trips a store", () => {
		const state = emptyLiveState();
		liveSetDoc(state, { ...at("agent"), data: { ok: true } });
		expect(parseLiveState(JSON.stringify(state))).toEqual(state);
	});

	it("refuses a file it did not write rather than overwrite it", () => {
		expect(() => parseLiveState(JSON.stringify({ hello: "world" }))).toThrow(/refusing/);
	});
});
