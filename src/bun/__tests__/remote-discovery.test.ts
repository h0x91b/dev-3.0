import { describe, expect, it, vi } from "vitest";
import {
	REMOTE_DISCOVERY_DISABLE_ENV,
	startRemoteDiscoveryAdvertisement,
} from "../remote-discovery";

const info = {
	instanceId: "123e4567-e89b-42d3-a456-426614174000",
	name: "studio-mac",
	appVersion: "1.35.2",
	protocolVersion: 1,
};

function fakeBonjour() {
	let errorListener: ((error: Error) => void) | undefined;
	let socketErrorListener: ((error: Error) => void) | undefined;
	const stop = vi.fn((callback?: () => void) => callback?.());
	const destroy = vi.fn();
	const publish = vi.fn(() => ({
		on: vi.fn((_event: "error", listener: (error: Error) => void) => {
			errorListener = listener;
		}),
		stop,
	}));
	class FakeBonjour {
		publish = publish;
		destroy = destroy;
		constructor(_options?: Record<string, never>, onError?: (error: Error) => void) {
			socketErrorListener = onError;
		}
	}
	return {
		loadBonjour: async () => FakeBonjour,
		publish,
		stop,
		destroy,
		emitError: (error: Error) => errorListener?.(error),
		emitSocketError: (error: Error) => socketErrorListener?.(error),
	};
}

describe("remote DNS-SD discovery", () => {
	it("advertises _dev3._tcp on the actual port with identity TXT records", async () => {
		const fake = fakeBonjour();
		const advertisement = await startRemoteDiscoveryAdvertisement(info, 41234, fake);

		expect(advertisement).not.toBeNull();
		expect(fake.publish).toHaveBeenCalledWith({
			name: expect.stringContaining("123e4567 41234"),
			type: "dev3",
			protocol: "tcp",
			port: 41234,
			probe: true,
			txt: {
				instanceId: info.instanceId,
				protocolVersion: "1",
				appVersion: "1.35.2",
			},
		});
	});

	it("withdraws the service and destroys the multicast socket exactly once", async () => {
		const fake = fakeBonjour();
		const advertisement = await startRemoteDiscoveryAdvertisement(info, 41234, fake);

		advertisement?.stop();
		advertisement?.stop();

		expect(fake.stop).toHaveBeenCalledOnce();
		expect(fake.destroy).toHaveBeenCalledOnce();
	});

	it("turns service and multicast socket errors into a graceful stop", async () => {
		for (const emit of ["emitError", "emitSocketError"] as const) {
			const fake = fakeBonjour();
			await startRemoteDiscoveryAdvertisement(info, 41234, fake);
			fake[emit](new Error("multicast unavailable"));
			expect(fake.stop).toHaveBeenCalledOnce();
			expect(fake.destroy).toHaveBeenCalledOnce();
		}
	});

	it("is default-on but supports an explicit disable feature gate", async () => {
		const loadBonjour = vi.fn();
		const advertisement = await startRemoteDiscoveryAdvertisement(info, 41234, {
			env: { [REMOTE_DISCOVERY_DISABLE_ENV]: "1" },
			loadBonjour,
		});

		expect(advertisement).toBeNull();
		expect(loadBonjour).not.toHaveBeenCalled();
	});

	it("silently degrades when the implementation cannot load", async () => {
		const advertisement = await startRemoteDiscoveryAdvertisement(info, 41234, {
			loadBonjour: async () => { throw new Error("unsupported"); },
		});

		expect(advertisement).toBeNull();
	});
});
