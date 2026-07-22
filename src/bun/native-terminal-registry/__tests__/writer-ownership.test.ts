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
