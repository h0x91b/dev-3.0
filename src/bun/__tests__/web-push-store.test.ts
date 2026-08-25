/**
 * The device registry. A stored subscription is a standing capability to make
 * someone's phone buzz, so the properties that matter are that a device cannot
 * be registered twice, that removal is real, and that malformed input is
 * refused rather than persisted.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSubscription, loadSubscriptions, removeSubscription, saveSubscriptions } from "../web-push-store";

const dir = mkdtempSync(join(tmpdir(), "dev3-push-store-"));
const file = join(dir, "subs.json");

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: "BPublicKey", auth: "AuthSecret" } });

beforeEach(() => {
	rmSync(file, { force: true });
});

describe("loading", () => {
	it("returns nothing when the store does not exist", () => {
		expect(loadSubscriptions(file)).toEqual([]);
	});

	it("survives a corrupt store instead of throwing", () => {
		writeFileSync(file, "{not json");
		expect(loadSubscriptions(file)).toEqual([]);
	});

	it("drops entries that are not subscriptions", () => {
		writeFileSync(file, JSON.stringify([sub("https://a/1"), { endpoint: "https://b/2" }, null, "nope"]));
		expect(loadSubscriptions(file)).toHaveLength(1);
	});

	it("refuses a non-https endpoint", () => {
		writeFileSync(file, JSON.stringify([{ endpoint: "http://evil/1", keys: { p256dh: "x", auth: "y" } }]));
		expect(loadSubscriptions(file)).toEqual([]);
	});
});

describe("registering a device", () => {
	it("stores it and stamps when it happened", () => {
		const subs = addSubscription(sub("https://a/1"), "iPhone", file, new Date("2026-08-26T10:00:00Z"));
		expect(subs).toHaveLength(1);
		expect(subs[0].label).toBe("iPhone");
		expect(subs[0].createdAt).toBe("2026-08-26T10:00:00.000Z");
	});

	it("replaces rather than duplicates when the same device re-subscribes", () => {
		addSubscription(sub("https://a/1"), "iPhone", file);
		const subs = addSubscription(sub("https://a/1"), "iPhone renamed", file);
		expect(subs).toHaveLength(1);
		expect(subs[0].label).toBe("iPhone renamed");
	});

	it("keeps distinct devices apart", () => {
		addSubscription(sub("https://a/1"), "iPhone", file);
		expect(addSubscription(sub("https://b/2"), "Mac", file)).toHaveLength(2);
	});

	it("rejects malformed input instead of persisting it", () => {
		expect(() => addSubscription({ endpoint: "https://a/1" }, undefined, file)).toThrow();
		expect(loadSubscriptions(file)).toEqual([]);
	});
});

describe("removing a device", () => {
	it("takes it out of the store", () => {
		addSubscription(sub("https://a/1"), "iPhone", file);
		addSubscription(sub("https://b/2"), "Mac", file);
		const left = removeSubscription("https://a/1", file);
		expect(left).toHaveLength(1);
		expect(left[0].endpoint).toBe("https://b/2");
	});

	it("is a no-op for an endpoint that was never there", () => {
		addSubscription(sub("https://a/1"), "iPhone", file);
		expect(removeSubscription("https://nope/9", file)).toHaveLength(1);
	});
});

describe("at rest", () => {
	it("is written 0600 — it is a capability, not a preference", () => {
		saveSubscriptions([{ ...sub("https://a/1"), createdAt: new Date(0).toISOString() }], file);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});
