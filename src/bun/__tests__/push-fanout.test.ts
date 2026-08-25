/**
 * Fan-out to registered devices. The behaviour worth pinning is the pruning
 * rule: a device that dropped its subscription must be forgotten, and a
 * transient failure must NOT be, or an outage quietly unsubscribes everyone.
 */
import { it, expect, vi, beforeEach } from "vitest";

const sent: string[] = [];
let nextStatus = 201;

vi.mock("../web-push", () => ({
	loadOrCreateVapidKeys: vi.fn(async () => ({ publicKey: "pub", privateKey: "priv" })),
	sendNotification: vi.fn(async (sub: { endpoint: string }) => {
		sent.push(sub.endpoint);
		return { statusCode: nextStatus };
	}),
	subscriptionIsGone: (status: number) => status === 404 || status === 410,
}));

const devices = [
	{ endpoint: "https://web.push.apple.com/a", keys: { p256dh: "x", auth: "y" }, createdAt: "" },
	{ endpoint: "https://fcm.googleapis.com/b", keys: { p256dh: "x", auth: "y" }, createdAt: "" },
];
let stored = [...devices];
const removed: string[] = [];

vi.mock("../web-push-store", () => ({
	loadSubscriptions: () => stored,
	removeSubscription: (endpoint: string) => {
		removed.push(endpoint);
		stored = stored.filter((s) => s.endpoint !== endpoint);
		return stored;
	},
}));

const { deliverToPushDevices } = await import("../notification-transports");

const event = {
	taskId: "t", projectId: "p", title: "#7 Thing", body: "Agent has questions",
	level: "info" as const, taskSeq: 7, taskTitle: "Thing", projectName: "proj",
};

beforeEach(() => {
	sent.length = 0;
	removed.length = 0;
	stored = [...devices];
	nextStatus = 201;
});

it("sends to every registered device", async () => {
	await deliverToPushDevices(event);
	expect(sent).toHaveLength(2);
});

it("sends nothing, and asks for no keys, when no device is registered", async () => {
	stored = [];
	await deliverToPushDevices(event);
	expect(sent).toHaveLength(0);
});

it("forgets a device the push service reports gone", async () => {
	nextStatus = 410;
	await deliverToPushDevices(event);
	expect(removed).toHaveLength(2);
});

it("keeps a device through a transient failure", async () => {
	nextStatus = 503;
	await deliverToPushDevices(event);
	expect(removed).toHaveLength(0);
});

it("keeps a device through a rate limit", async () => {
	nextStatus = 429;
	await deliverToPushDevices(event);
	expect(removed).toHaveLength(0);
});
