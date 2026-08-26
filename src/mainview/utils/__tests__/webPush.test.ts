import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToPush, unsubscribeFromPush } from "../webPush";

const originalFetch = globalThis.fetch;
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

function installServiceWorker(subscription: {
	endpoint: string;
	toJSON: () => unknown;
	unsubscribe: ReturnType<typeof vi.fn>;
}) {
	const registration = {
		pushManager: {
			getSubscription: vi.fn().mockResolvedValue(null),
			subscribe: vi.fn().mockResolvedValue(subscription),
		},
	};
	Object.defineProperty(navigator, "serviceWorker", {
		configurable: true,
		value: {
			register: vi.fn().mockResolvedValue(registration),
			get ready() {
				return Promise.resolve(registration);
			},
			getRegistration: vi.fn().mockResolvedValue(registration),
		},
	});
	return registration;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalServiceWorker) {
		Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
	} else {
		delete (navigator as { serviceWorker?: unknown }).serviceWorker;
	}
});

describe("push enrollment persistence", () => {
	it("removes the browser subscription when the host cannot store it", async () => {
		const subscription = {
			endpoint: "https://push.example/device",
			toJSON: () => ({ endpoint: "https://push.example/device", keys: { p256dh: "x", auth: "y" } }),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};
		installServiceWorker(subscription);
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ publicKey: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }))
			.mockResolvedValueOnce(Response.json({ error: "disk full" }, { status: 500 })) as unknown as typeof fetch;

		await expect(subscribeToPush()).rejects.toThrow("could not register device (500)");
		expect(subscription.unsubscribe).toHaveBeenCalledOnce();
	});

	it("keeps the local subscription when the host cannot persist removal", async () => {
		const subscription = {
			endpoint: "https://push.example/device",
			toJSON: () => ({}),
			unsubscribe: vi.fn().mockResolvedValue(true),
		};
		const registration = installServiceWorker(subscription);
		registration.pushManager.getSubscription.mockResolvedValue(subscription);
		globalThis.fetch = vi.fn().mockResolvedValue(
			Response.json({ error: "disk full" }, { status: 500 }),
		) as unknown as typeof fetch;

		await expect(unsubscribeFromPush()).rejects.toThrow("could not unregister device (500)");
		expect(subscription.unsubscribe).not.toHaveBeenCalled();
	});
});
