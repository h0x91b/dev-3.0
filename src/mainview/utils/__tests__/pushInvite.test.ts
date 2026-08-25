/**
 * The push invite. The failure modes are symmetric and both bad: nag someone on
 * every load, or stay silent where enrolling would have worked. Each condition
 * below exists because of one of those.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readiness = { ready: true as boolean, reason: undefined as string | undefined };
let subscribed = false;
const subscribeCalls: number[] = [];

vi.mock("../webPush", () => ({
	pushReadiness: () => (readiness.ready ? { ready: true } : { ready: false, reason: readiness.reason }),
	isSubscribed: async () => subscribed,
	subscribeToPush: async () => {
		subscribeCalls.push(1);
		return "https://web.push.apple.com/x";
	},
}));

const shown: string[] = [];
vi.mock("../../toast", () => ({
	toast: {
		info: (msg: string) => shown.push(msg),
		success: (msg: string) => shown.push(msg),
		error: (msg: string) => shown.push(msg),
	},
}));

const { maybeInvitePushEnrollment } = await import("../pushInvite");
const t = ((key: string) => key) as never;

beforeEach(() => {
	shown.length = 0;
	subscribeCalls.length = 0;
	subscribed = false;
	readiness.ready = true;
	localStorage.clear();
	(globalThis as { Notification?: unknown }).Notification = { permission: "default" };
});

describe("when it offers", () => {
	it("offers once on a device that could actually accept", async () => {
		await maybeInvitePushEnrollment(t);
		expect(shown).toEqual(["push.inviteBody"]);
	});
});

describe("when it stays silent", () => {
	it("never asks twice, even if the user ignored it", async () => {
		await maybeInvitePushEnrollment(t);
		shown.length = 0;
		await maybeInvitePushEnrollment(t);
		expect(shown).toEqual([]);
	});

	it("says nothing where enrolling cannot work — an iOS tab, or plain http", async () => {
		readiness.ready = false;
		readiness.reason = "needs-install";
		await maybeInvitePushEnrollment(t);
		readiness.reason = "insecure";
		await maybeInvitePushEnrollment(t);
		expect(shown).toEqual([]);
	});

	it("respects a browser-level denial instead of re-asking", async () => {
		(globalThis as { Notification?: unknown }).Notification = { permission: "denied" };
		await maybeInvitePushEnrollment(t);
		expect(shown).toEqual([]);
	});

	it("does not pester a device that is already enrolled", async () => {
		subscribed = true;
		await maybeInvitePushEnrollment(t);
		expect(shown).toEqual([]);
	});

	it("stays quiet when storage is unavailable, rather than nagging every load", async () => {
		// The setup file substitutes a plain object for localStorage, so stub the
		// instance rather than Storage.prototype.
		const original = globalThis.localStorage.getItem;
		globalThis.localStorage.getItem = () => {
			throw new Error("blocked");
		};
		await maybeInvitePushEnrollment(t);
		expect(shown).toEqual([]);
		globalThis.localStorage.getItem = original;
	});
});
