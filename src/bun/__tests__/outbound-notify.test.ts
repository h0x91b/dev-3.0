import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	execExited: Promise.resolve(0) as Promise<number>,
	pushStarted: false,
}));

vi.mock("../spawn", () => ({
	spawn: vi.fn(() => ({ exited: state.execExited, kill: vi.fn() })),
	spawnSync: vi.fn(() => ({ exitCode: 0, stdout: new Uint8Array() })),
}));

vi.mock("../web-push-store", () => ({
	loadSubscriptions: () => [
		{
			endpoint: "https://push.example/device",
			keys: { p256dh: "x", auth: "y" },
			createdAt: "",
		},
	],
	removeSubscription: vi.fn(),
}));

vi.mock("../web-push", () => ({
	loadOrCreateVapidKeys: vi.fn(async () => ({ publicKey: "pub", privateKey: "priv" })),
	sendNotification: vi.fn(async () => {
		state.pushStarted = true;
		return { statusCode: 201 };
	}),
	subscriptionIsGone: () => false,
}));

const { deliverOutbound } = await import("../notification-transports");

const event = {
	taskId: "t",
	projectId: "p",
	title: "#7 Thing",
	body: "Agent has questions",
	level: "info" as const,
	taskSeq: 7,
	taskTitle: "Thing",
	projectName: "proj",
};

it("starts device push without waiting for an exec hook", async () => {
	let finishExec!: (code: number) => void;
	state.execExited = new Promise<number>((resolve) => {
		finishExec = resolve;
	});
	state.pushStarted = false;

	const delivery = deliverOutbound(event, {
		transports: [{ kind: "exec", command: ["notify-hook"], timeoutMs: 5_000 }],
	});
	await vi.waitFor(() => expect(state.pushStarted).toBe(true));
	finishExec(0);
	await delivery;
});
