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
		});

		const claims = [ownership.request(first, "claim"), ownership.request(second, "claim")];
		expect(claims.filter((result) => result.ok)).toHaveLength(1);
		expect(claims[0]).toEqual({ ok: true, role: "writer", writerAttached: true });
		expect(claims[1]).toEqual({
			ok: false,
			reason: "writer-active",
			role: "observer",
			writerAttached: true,
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
		});
	});

	it("starts a new host with no stale writer lease", () => {
		const oldHost = new WriterOwnership<object>();
		oldHost.attach({});

		const restartedHost = new WriterOwnership<object>();
		expect(restartedHost.attach({})).toBe("writer");
	});
});
