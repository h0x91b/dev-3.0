import { describe, expect, it } from "vitest";
import { WriterOwnership } from "../writer-ownership";

describe("native-session writer ownership", () => {
	it("assigns the first attached client as writer and later clients as observers", () => {
		const ownership = new WriterOwnership<object>();
		const first = {};
		const second = {};

		expect(ownership.attach(first)).toBe("writer");
		expect(ownership.attach(second)).toBe("observer");
		expect(ownership.canMutatePty(first)).toBe(true);
		expect(ownership.canMutatePty(second)).toBe(false);
		expect(ownership.hasWriter()).toBe(true);
	});

	it("releases explicitly and gives a vacant writer slot to exactly one claimant", () => {
		const ownership = new WriterOwnership<object>();
		const first = {};
		const second = {};
		ownership.attach(first);
		ownership.attach(second);

		expect(ownership.request(first, "release")).toEqual({
			ok: true,
			role: "observer",
			writerAttached: false,
			generation: 2,
		});

		const claims = [ownership.request(first, "claim"), ownership.request(second, "claim")];
		expect(claims.filter((result) => result.ok)).toHaveLength(1);
		expect(claims[0]).toEqual({ ok: true, role: "writer", writerAttached: true, generation: 3 });
		expect(claims[1]).toEqual({
			ok: false,
			reason: "writer-active",
			role: "observer",
			writerAttached: true,
			generation: 3,
		});
		expect(ownership.canMutatePty(first)).toBe(true);
		expect(ownership.canMutatePty(second)).toBe(false);
	});

	// The survivors are NOT promoted (write authority never moves implicitly), but
	// they must be handed back so the host can tell them the slot opened. Without
	// that notice they sit read-only forever against a host with no writer at all.
	it("names the survivors when the writer leaves, so they can be told the slot is free", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		const observerA = {};
		const observerB = {};
		ownership.attach(writer);
		ownership.attach(observerA);
		ownership.attach(observerB);

		const survivors = ownership.detach(writer);

		expect(survivors).toEqual([observerA, observerB]);
		expect(ownership.hasWriter()).toBe(false);
		expect(ownership.roleOf(observerA)).toBe("observer");
	});

	it("names nobody when a mere observer leaves — the lease never moved", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		const observer = {};
		ownership.attach(writer);
		ownership.attach(observer);

		expect(ownership.detach(observer)).toEqual([]);
		expect(ownership.canMutatePty(writer)).toBe(true);
	});

	it("names nobody when the last client leaves", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		ownership.attach(writer);

		expect(ownership.detach(writer)).toEqual([]);
		expect(ownership.hasWriter()).toBe(false);
	});

	it("leaves observers unpromoted after writer disconnect until one explicitly claims", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		const observer = {};
		const reconnect = {};
		ownership.attach(writer);
		ownership.attach(observer);

		ownership.detach(writer);

		expect(ownership.hasWriter()).toBe(false);
		expect(ownership.roleOf(observer)).toBe("observer");
		expect(ownership.attach(reconnect)).toBe("observer");
		expect(ownership.request(reconnect, "claim")).toEqual({
			ok: true,
			role: "writer",
			writerAttached: true,
			generation: 3,
		});
	});

	// ── explicit takeover ─────────────────────────────────────────────
	// `claim` must stay non-stealing — that is what keeps ordinary attachment safe —
	// so transferring a LIVE lease needs its own action.
	it("moves a live lease on takeover, demoting the previous writer", () => {
		const ownership = new WriterOwnership<object>();
		const first = {};
		const second = {};
		ownership.attach(first);
		ownership.attach(second);

		expect(ownership.request(second, "takeover")).toEqual({
			ok: true,
			role: "writer",
			writerAttached: true,
			generation: 2,
		});
		// One pointer, swapped in one call: never two writers, never none.
		expect(ownership.canMutatePty(second)).toBe(true);
		expect(ownership.canMutatePty(first)).toBe(false);
		expect(ownership.roleOf(first)).toBe("observer");
		expect(ownership.hasWriter()).toBe(true);
		expect(ownership.writerClient()).toBe(second);
	});

	it("refuses a plain claim in the very case takeover handles", () => {
		const ownership = new WriterOwnership<object>();
		const first = {};
		const second = {};
		ownership.attach(first);
		ownership.attach(second);

		expect(ownership.request(second, "claim")).toEqual({
			ok: false,
			reason: "writer-active",
			role: "observer",
			writerAttached: true,
			generation: 1,
		});
		expect(ownership.canMutatePty(first)).toBe(true);
	});

	it("is idempotent when the current writer takes over again — the pointer does not move", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		ownership.attach(writer);

		expect(ownership.request(writer, "takeover")).toEqual({
			ok: true,
			role: "writer",
			writerAttached: true,
			generation: 1,
		});
		expect(ownership.canMutatePty(writer)).toBe(true);
	});

	it("takes a VACANT slot, counting it as one transition", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		const observer = {};
		ownership.attach(writer);
		ownership.attach(observer);
		ownership.detach(writer);

		expect(ownership.request(observer, "takeover")).toEqual({
			ok: true,
			role: "writer",
			writerAttached: true,
			generation: 3,
		});
	});

	it("refuses a takeover from a client that never attached", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		ownership.attach(writer);

		expect(ownership.request({}, "takeover")).toEqual({
			ok: false,
			reason: "not-attached",
			role: null,
			writerAttached: true,
			generation: 1,
		});
		expect(ownership.canMutatePty(writer)).toBe(true);
	});

	// The documented contract (decision 200): last-explicit-takeover-wins. Deliberately
	// NOT an expected-owner/generation guard — the host serializes these, so a rejection
	// would only make the button refuse a click the user meant.
	it("last explicit takeover wins: both succeed and the pointer ends on the last asker", () => {
		const ownership = new WriterOwnership<object>();
		const a = {};
		const b = {};
		const c = {};
		ownership.attach(a);
		ownership.attach(b);
		ownership.attach(c);

		expect(ownership.request(b, "takeover")).toMatchObject({ ok: true, generation: 2 });
		expect(ownership.roleOf(a)).toBe("observer");
		expect(ownership.request(c, "takeover")).toMatchObject({ ok: true, generation: 3 });
		expect(ownership.roleOf(b)).toBe("observer");
		expect(ownership.writerClient()).toBe(c);
	});

	// ── writer generation ──────────────────────────────
	// A client cannot tell "the lease I know about" from "a lease that has moved since"
	// without this, and would resize a PTY it no longer owns.
	it("counts every REAL pointer transition exactly once", () => {
		const ownership = new WriterOwnership<object>();
		const a = {};
		const b = {};
		expect(ownership.writerGeneration()).toBe(0);

		ownership.attach(a); // null -> A
		expect(ownership.writerGeneration()).toBe(1);
		ownership.attach(b); // no transition: b observes
		expect(ownership.writerGeneration()).toBe(1);
		ownership.request(b, "takeover"); // A -> B
		expect(ownership.writerGeneration()).toBe(2);
		ownership.request(b, "release"); // B -> null
		expect(ownership.writerGeneration()).toBe(3);
		ownership.request(a, "claim"); // null -> A
		expect(ownership.writerGeneration()).toBe(4);
		ownership.detach(a); // A -> null
		expect(ownership.writerGeneration()).toBe(5);
	});

	it("does NOT count idempotent requests — they move nothing", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		ownership.attach(writer);
		const before = ownership.writerGeneration();

		ownership.request(writer, "claim");
		ownership.request(writer, "takeover");
		ownership.attach(writer);

		expect(ownership.writerGeneration()).toBe(before);
	});

	it("does NOT count a refused request", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		const observer = {};
		ownership.attach(writer);
		ownership.attach(observer);
		const before = ownership.writerGeneration();

		ownership.request(observer, "claim"); // refused: writer-active
		ownership.request(observer, "release"); // refused: not-writer
		ownership.request({}, "takeover"); // refused: not-attached

		expect(ownership.writerGeneration()).toBe(before);
	});

	it("does NOT count an observer leaving", () => {
		const ownership = new WriterOwnership<object>();
		const writer = {};
		const observer = {};
		ownership.attach(writer);
		ownership.attach(observer);
		const before = ownership.writerGeneration();

		ownership.detach(observer);

		expect(ownership.writerGeneration()).toBe(before);
	});

	it("starts a new host with no stale writer lease", () => {
		const oldHost = new WriterOwnership<object>();
		oldHost.attach({});

		const restartedHost = new WriterOwnership<object>();
		expect(restartedHost.attach({})).toBe("writer");
	});
});
