/**
 * The push invite. The failure modes are symmetric and both bad: nag someone on
 * every load, or stay silent where enrolling would have worked. Each condition
 * below exists because of one of those — plus the rule that a toast may point at
 * a setting but must never own the setup itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OPEN_SETTINGS_SECTION_EVENT } from "../../state";

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

const shown: { msg: string; onClick?: () => void; source?: string }[] = [];
vi.mock("../../toast", () => ({
	toast: {
		info: (msg: string, opts?: { onClick?: () => void; source?: string }) =>
			shown.push({ msg, onClick: opts?.onClick, source: opts?.source }),
		success: (msg: string) => shown.push({ msg }),
		error: (msg: string) => shown.push({ msg }),
	},
}));

const { maybeInvitePushEnrollment } = await import("../pushInvite");
const t = ((key: string) => key) as never;
const messages = () => shown.map((entry) => entry.msg);

/** Swap `localStorage` itself rather than one method: whether the test env left
 *  happy-dom's native Storage in place or the setup file's stand-in, only the
 *  property is reliably replaceable. */
function withStorage(storage: Partial<Storage>, run: () => Promise<void>): Promise<void> {
	const targets = [globalThis, globalThis.window].filter(Boolean) as object[];
	const saved = targets.map((target) => Object.getOwnPropertyDescriptor(target, "localStorage"));
	for (const target of targets) {
		Object.defineProperty(target, "localStorage", { value: storage, configurable: true, writable: true });
	}
	return run().finally(() => {
		targets.forEach((target, i) => {
			if (saved[i]) Object.defineProperty(target, "localStorage", saved[i]);
		});
	});
}

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
		expect(messages()).toEqual(["push.inviteBody"]);
	});

	it("only points at Settings — it never runs the setup itself", async () => {
		const seen: unknown[] = [];
		const onOpen = (event: Event) => seen.push((event as CustomEvent).detail);
		window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpen);
		await maybeInvitePushEnrollment(t);
		shown[0]?.onClick?.();
		window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpen);

		expect(seen).toEqual([{ section: "system", anchor: "push-notifications" }]);
		expect(shown[0]?.source).toBe("settings");
		expect(subscribeCalls).toEqual([]);
	});
});

describe("when it stays silent", () => {
	it("never asks twice, even if the user ignored it", async () => {
		await maybeInvitePushEnrollment(t);
		shown.length = 0;
		await maybeInvitePushEnrollment(t);
		expect(messages()).toEqual([]);
	});

	it("says nothing where enrolling cannot work — an iOS tab, or plain http", async () => {
		readiness.ready = false;
		readiness.reason = "needs-install";
		await maybeInvitePushEnrollment(t);
		readiness.reason = "insecure";
		await maybeInvitePushEnrollment(t);
		expect(messages()).toEqual([]);
	});

	it("respects a browser-level denial instead of re-asking", async () => {
		(globalThis as { Notification?: unknown }).Notification = { permission: "denied" };
		await maybeInvitePushEnrollment(t);
		expect(messages()).toEqual([]);
	});

	it("does not pester a device that is already enrolled", async () => {
		subscribed = true;
		await maybeInvitePushEnrollment(t);
		expect(messages()).toEqual([]);
	});

	it("stays quiet when storage cannot be read, rather than nagging every load", async () => {
		await withStorage(
			{
				getItem: () => {
					throw new Error("blocked");
				},
				setItem: () => {},
				removeItem: () => {},
			},
			async () => {
				await maybeInvitePushEnrollment(t);
				expect(messages()).toEqual([]);
			},
		);
	});

	it("stays quiet when a dismissal could be read back but never written", async () => {
		// The nastier half: reads work, so a naive check sees "not dismissed" and
		// offers again on every single load.
		await withStorage(
			{
				getItem: () => null,
				setItem: () => {
					throw new Error("quota");
				},
				removeItem: () => {},
			},
			async () => {
				await maybeInvitePushEnrollment(t);
				expect(messages()).toEqual([]);
			},
		);
	});
});
